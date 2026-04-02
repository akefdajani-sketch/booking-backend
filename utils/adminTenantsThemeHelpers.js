// utils/adminTenantsThemeHelpers.js
//
// Shared helpers for routes/adminTenantsTheme/ sub-files.
// Extracted from routes/adminTenantsTheme.js.

const db = require("../db");
const { pool } = require("../db");
const requireAdminOrTenantRole = require("../middleware/requireAdminOrTenantRole");
const { writeTenantAppearanceSnapshot } = require("../theme/resolveTenantAppearanceSnapshot");

// Diff helpers (Phase 2B)
// --------------------
function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function stableStringify(v) {
  try {
    if (typeof v === "string") return v;
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Compute a shallow+deep diff between two JSON-like values.
 * Returns a list of { path, type, from, to } where:
 *  - type: "added" | "removed" | "changed"
 */
function jsonDiff(fromVal, toVal, basePath = "") {
  const changes = [];

  // identical (including primitives)
  if (fromVal === toVal) return changes;

  // arrays: treat as value change (simple but predictable)
  if (Array.isArray(fromVal) || Array.isArray(toVal)) {
    const fromStr = stableStringify(fromVal);
    const toStr = stableStringify(toVal);
    if (fromStr !== toStr) {
      changes.push({ path: basePath || "", type: "changed", from: fromVal, to: toVal });
    }
    return changes;
  }

  // objects: recurse key-by-key
  if (isPlainObject(fromVal) && isPlainObject(toVal)) {
    const keys = new Set([...Object.keys(fromVal), ...Object.keys(toVal)]);
    for (const k of Array.from(keys).sort()) {
      const nextPath = basePath ? `${basePath}.${k}` : k;
      if (!(k in fromVal)) {
        changes.push({ path: nextPath, type: "added", from: undefined, to: toVal[k] });
        continue;
      }
      if (!(k in toVal)) {
        changes.push({ path: nextPath, type: "removed", from: fromVal[k], to: undefined });
        continue;
      }
      changes.push(...jsonDiff(fromVal[k], toVal[k], nextPath));
    }
    return changes;
  }

  // primitives / mismatched types
  changes.push({ path: basePath || "", type: "changed", from: fromVal, to: toVal });
  return changes;
}

function summarizeDiff(changes) {
  const counts = { added: 0, removed: 0, changed: 0, total: 0 };
  for (const c of changes) {
    if (c.type === "added") counts.added += 1;
    else if (c.type === "removed") counts.removed += 1;
    else counts.changed += 1;
  }
  counts.total = changes.length;
  return counts;
}


const db = require("../db");
const requireAdminOrTenantRole = require("../middleware/requireAdminOrTenantRole");
const { getPlanSummaryForTenant } = require("../utils/planEnforcement");
const { writeTenantAppearanceSnapshot } = require("../theme/resolveTenantAppearanceSnapshot");
const { sanitizeBrandOverrides } = require("../theme/validateTokens");

// Glass vars and other snapshot-computed vars that must NEVER be stored in
// branding.brand_overrides. They are derived dynamically from the brand colors
// by buildResolvedCssVars in resolveTenantAppearanceSnapshot. Storing them
// hard-wires the appearance and makes Brand Setup color changes have no effect.
// Vars that are purely computed by the snapshot and have NO user-facing editor.
// These are stripped from branding.brand_overrides on every save-draft and publish
// to prevent stale hardcoded values from blocking dynamic computation.
//
// NOTE: Glass vars (--bf-glass-*) were previously in this list but are intentionally
// REMOVED because the "Premium glass controls" UI allows tenants to set them explicitly.
// branding.brand_overrides is now the correct storage path for those overrides, and
// resolveTenantAppearanceSnapshot merges them into brandOverrides before computing.
const SNAPSHOT_COMPUTED_VARS = new Set([
  // Pattern overlay vars — no UI to set these, always computed from brand primary
  "--bf-premium-pattern-line",
  "--bf-premium-pattern-opacity",
  "--bf-premium-pattern-size",
  "--bf-premium-pattern-sheen-opacity",
  "--bf-premium-light-grid-opacity",
  "--bf-premium-pattern-blend",
  // Selection highlight — computed from brand primary, no direct UI
  "--bf-selection-bg",
  "--bf-selection-text",
]);

/**
 * Strip snapshot-computed vars from branding.brand_overrides.
 * Called on every save-draft and publish so the snapshot resolver always
 * owns the glass/pattern/selection vars — never a stale stored override.
 */
function stripComputedVarsFromBranding(branding) {
  if (!branding || typeof branding !== "object") return branding;
  const bo = branding.brand_overrides;
  if (!bo || typeof bo !== "object") return branding;

  const cleaned = {};
  for (const [k, v] of Object.entries(bo)) {
    if (!SNAPSHOT_COMPUTED_VARS.has(k)) cleaned[k] = v;
  }

  // Return a shallow clone with the cleaned brand_overrides
  return { ...branding, brand_overrides: cleaned };
}

function setTenantIdFromParam(req, res, next) {
  const tid = Number(req.params.tenantId);
  if (!Number.isFinite(tid) || tid <= 0) {
    return res.status(400).json({ error: "Invalid tenantId" });
  }
  req.tenantId = tid;
  req.body = req.body || {};
  // Some middlewares look for tenantId/tenant_id in body.
  req.body.tenantId = req.body.tenantId || tid;
  req.body.tenant_id = req.body.tenant_id || tid;
  return next();
}

// -----------------------------------------------------------------------------
// Schema hardening (idempotent)
//
// We ship explicit migrations in Phase 1, but keep these guards so older
// environments (or partial restores) don't hard-fail.
// -----------------------------------------------------------------------------
async function ensureThemeSchemaColumns() {
  // Postgres supports ADD COLUMN IF NOT EXISTS.
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS theme_schema_draft_json JSONB;`);
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS theme_schema_published_json JSONB;`);
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS theme_schema_draft_saved_at TIMESTAMP;`);
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS theme_schema_published_at TIMESTAMP;`);
}

async function ensureBrandingColumns() {
  // Existing installs usually have branding + branding_published + publish_status.
  // We add the saved/published timestamps so the UI can show state clearly.
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS branding JSONB;`);
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS branding_published JSONB;`);
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS publish_status TEXT;`);
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS branding_draft_saved_at TIMESTAMP;`);
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS branding_published_at TIMESTAMP;`);
}

async function ensureThemeKeyColumn() {
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS theme_key TEXT;`);
}

async function ensureBrandOverridesColumn() {
  // Legacy + public booking pages still rely on this column. Treat NULL as "inherit".
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS brand_overrides_json JSONB;`);
}


async function ensureAppearanceSnapshotColumns() {
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS appearance_snapshot_published_json JSONB;`);
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS appearance_snapshot_version INTEGER NOT NULL DEFAULT 1;`);
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS appearance_snapshot_published_at TIMESTAMPTZ;`);
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS appearance_snapshot_source_theme_key TEXT;`);
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS appearance_snapshot_layout_key TEXT;`);
}

async function refreshAppearanceSnapshot(tenantId) {
  await ensureThemeKeyColumn();
  await ensureBrandingColumns();
  await ensureThemeSchemaColumns();
  await ensureBrandOverridesColumn();
  await ensureAppearanceSnapshotColumns();
  try {
    return await writeTenantAppearanceSnapshot(tenantId);
  } catch (e) {
    console.error("refreshAppearanceSnapshot error:", e);
    return null;
  }
}

async function ensureChangelog() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS tenant_theme_schema_changelog (
      id SERIAL PRIMARY KEY,
      tenant_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      actor TEXT,
      metadata JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_theme_schema_changelog_tenant_time
     ON tenant_theme_schema_changelog (tenant_id, created_at DESC);`
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_theme_schema_changelog_tenant_action_time
     ON tenant_theme_schema_changelog (tenant_id, action, created_at DESC);`
  );
}

async function logChange(tenantId, action, actor, metadata) {
  await ensureChangelog();
  await db.query(
    "INSERT INTO tenant_theme_schema_changelog (tenant_id, action, actor, metadata) VALUES ($1, $2, $3, $4::jsonb)",
    [tenantId, action, actor || null, JSON.stringify(metadata || {})]
  );
}

function getActor(req) {
  const v = String(req.headers["x-admin-actor"] || "").trim();
  return v || null;
}

function parseJsonBody(req) {
  // Accept either { value: ... } shapes or raw objects.
  return (req.body && (req.body.value ?? req.body.schema ?? req.body.draft ?? req.body.branding ?? req.body)) || null;
}

// -----------------------------------------------------------------------------
// Phase 1: Canonical Appearance endpoint
// GET /api/admin/tenants/:tenantId/appearance
// Returns:
// - theme_key
// - branding (draft + published + timestamps)
// - theme_schema (draft + published + timestamps)
// -----------------------------------------------------------------------------

module.exports = { isPlainObject, stableStringify, jsonDiff, summarizeDiff, stripComputedVarsFromBranding, setTenantIdFromParam, ensureThemeSchemaColumns, ensureBrandingColumns, ensureThemeKeyColumn, ensureBrandOverridesColumn, ensureAppearanceSnapshotColumns, refreshAppearanceSnapshot, ensureChangelog, logChange, getActor, parseJsonBody };
