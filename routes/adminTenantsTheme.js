// routes/adminTenantsTheme.js
// Phase C/D foundation: Draft / Publish / Rollback hardening for tenant theme schema
// Phase 1: Canonical "Appearance & Brand" contract (theme_key + branding + theme schema)

const express = require("express");
const router = express.Router();

// --------------------
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
const requireAdmin = require("../middleware/requireAdmin");
const { getPlanSummaryForTenant } = require("../utils/planEnforcement");

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
router.get("/:tenantId/appearance", requireAdmin, async (req, res) => {
  try {
    const tenantId = Number(req.params.tenantId);
    if (!Number.isFinite(tenantId) || tenantId <= 0) {
      return res.status(400).json({ error: "Invalid tenantId" });
    }

    await ensureThemeKeyColumn();
    await ensureBrandingColumns();
    await ensureThemeSchemaColumns();

    const { rows } = await db.query(
      `SELECT id, slug, theme_key,
              branding, branding_published, publish_status,
              branding_draft_saved_at, branding_published_at,
              theme_schema_draft_json, theme_schema_published_json,
              theme_schema_draft_saved_at, theme_schema_published_at
       FROM tenants
       WHERE id = $1`,
      [tenantId]
    );

    if (!rows[0]) return res.status(404).json({ error: "Tenant not found" });

    const t = rows[0];
    return res.json({
      tenant_id: t.id,
      slug: t.slug,
      theme_key: t.theme_key || null,
      branding: {
        draft: t.branding || {},
        published: t.branding_published || {},
        publish_status: t.publish_status || null,
        draft_saved_at: t.branding_draft_saved_at || null,
        published_at: t.branding_published_at || null,
      },
      theme_schema: {
        draft: t.theme_schema_draft_json || null,
        published: t.theme_schema_published_json || null,
        draft_saved_at: t.theme_schema_draft_saved_at || null,
        published_at: t.theme_schema_published_at || null,
      },
      capabilities: {
        has_branding: true,
        has_theme_schema: true,
      },
    });
  } catch (e) {
    console.error("GET /api/admin/tenants/:tenantId/appearance error:", e);
    return res.status(500).json({ error: "Failed to load tenant appearance" });
  }
});


/**
 * Diff viewer support: compare draft vs published for branding + theme_schema.
 * Returns draft/published blobs plus normalized diff lists.
 */
// Diff viewer endpoint: compare published vs draft for branding + theme_schema
// Returns normalized { diff: { counts, changes } } per section, with truncation safety.
router.get("/:tenantId/appearance/diff", requireAdmin, async (req, res) => {
  try {
    const tenantId = Number(req.params.tenantId);
    if (!Number.isFinite(tenantId) || tenantId <= 0) {
      return res.status(400).json({ error: "invalid tenant_id" });
    }

    // Ensure columns exist (safe to call repeatedly)
    await ensureBrandingColumns();
    await ensureThemeSchemaColumns();

    const q = await db.query(
      `
      select
        t.id as tenant_id,
        t.slug,
        t.theme_key,

        -- Branding (draft/published)
        t.branding as branding_draft,
        t.branding_published,
        t.publish_status as branding_publish_status,
        t.branding_draft_saved_at,
        t.branding_published_at,

        -- Theme schema (draft/published)
        t.theme_schema_draft_json,
        t.theme_schema_published_json,
        t.theme_schema_draft_saved_at,
        t.theme_schema_published_at
      from tenants t
      where t.id = $1
      `,
      [tenantId]
    );

    if (!q.rows.length) return res.status(404).json({ error: "tenant not found" });

    const row = q.rows[0];

    const LIMIT = 500;

    function buildSection(publishedVal, draftVal) {
      const published = publishedVal ?? {};
      const draft = draftVal ?? {};
      const changesAll = jsonDiff(published, draft);
      const truncated = changesAll.length > LIMIT;
      const changes = truncated ? changesAll.slice(0, LIMIT) : changesAll;
      return {
        diff: {
          counts: summarizeDiff(changesAll),
          changes,
          truncated,
          limit: LIMIT,
        },
      };
    }

    // Diff is computed as published → draft (what would change if you publish draft).
    const brandingSection = buildSection(row.branding_published, row.branding_draft);
    const schemaSection = buildSection(row.theme_schema_published_json, row.theme_schema_draft_json);

    return res.json({
      tenant_id: row.tenant_id,
      slug: row.slug,
      theme_key: row.theme_key || null,

      // compatibility / banner support
      publish_status: row.branding_publish_status || null,
      draft_saved_at: row.theme_schema_draft_saved_at || null,
      published_at: row.theme_schema_published_at || null,

      branding: brandingSection,
      theme_schema: schemaSection,
    });
  } catch (e) {
    console.error("GET /admin/tenants/:id/appearance/diff error", e);
    return res.status(500).json({ error: "server error" });
  }
});

router.post("/:tenantId/appearance/reset-to-inherit", requireAdmin, async (req, res) => {
  try {
    const tenantId = Number(req.params.tenantId);
    if (!Number.isFinite(tenantId) || tenantId <= 0) {
      return res.status(400).json({ error: "Invalid tenantId" });
    }

    await ensureBrandingColumns();
    await ensureThemeSchemaColumns();
    await ensureBrandOverridesColumn();

    const q = await db.query(
      `
	      UPDATE tenants
	      SET
	        -- Theme Studio (draft/publish)
	        -- IMPORTANT: some environments enforce NOT NULL on branding columns.
	        -- Use '{}' to represent "no tenant override" without violating constraints.
	        branding = '{}'::jsonb,
	        branding_published = '{}'::jsonb,
        branding_draft_saved_at = NULL,
        branding_published_at = NULL,

        theme_schema_draft_json = NULL,
        theme_schema_published_json = NULL,
        theme_schema_draft_saved_at = NULL,
        theme_schema_published_at = NULL,

        -- Legacy public booking overrides (tokens CSS vars)
        brand_overrides_json = NULL
      WHERE id = $1
      RETURNING id, slug, theme_key
      `,
      [tenantId]
    );

    if (!q.rows[0]) return res.status(404).json({ error: "Tenant not found" });

    await logChange(tenantId, "APPEARANCE_RESET_TO_INHERIT", getActor(req), {});

    return res.json({
      ok: true,
      tenant_id: q.rows[0].id,
      slug: q.rows[0].slug,
      theme_key: q.rows[0].theme_key || null,
    });
  } catch (e) {
    console.error("POST /api/admin/tenants/:tenantId/appearance/reset-to-inherit error:", e);
    return res.status(500).json({ error: "Failed to reset appearance" });
  }
});


router.post("/:tenantId/theme-key", requireAdmin, async (req, res) => {
  try {
    const tenantId = Number(req.params.tenantId);
    if (!Number.isFinite(tenantId) || tenantId <= 0) {
      return res.status(400).json({ error: "Invalid tenantId" });
    }

    await ensureThemeKeyColumn();

    const themeKey = String((req.body && (req.body.theme_key ?? req.body.themeKey)) || "").trim();
    if (!themeKey) return res.status(400).json({ error: "Missing theme_key" });

    const th = await db.query(
      `SELECT key FROM platform_themes WHERE key = $1 AND is_published = TRUE LIMIT 1`,
      [themeKey]
    );
    if (!th.rows[0]) return res.status(400).json({ error: "Theme key not found or not published" });

    await db.query(`UPDATE tenants SET theme_key = $1 WHERE id = $2`, [themeKey, tenantId]);

    await logChange(tenantId, "THEME_KEY_SET", getActor(req), { theme_key: themeKey });

    return res.json({ ok: true });
  } catch (e) {
    console.error("POST /api/admin/tenants/:tenantId/theme-key error:", e);
    return res.status(500).json({ error: "Failed to set theme key" });
  }
});

// -----------------------------------------------------------------------------
// Theme schema (existing endpoints, kept stable)
// -----------------------------------------------------------------------------
router.get("/:tenantId/theme-schema", requireAdmin, async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!tenantId) return res.status(400).json({ error: "Invalid tenantId" });

  await ensureThemeSchemaColumns();

  const { rows } = await db.query(
    `SELECT id,
            theme_schema_draft_json,
            theme_schema_published_json,
            theme_schema_draft_saved_at,
            theme_schema_published_at
     FROM tenants
     WHERE id = $1`,
    [tenantId]
  );

  if (!rows[0]) return res.status(404).json({ error: "Tenant not found" });

  res.json({
    tenant_id: rows[0].id,
    draft: rows[0].theme_schema_draft_json || null,
    published: rows[0].theme_schema_published_json || null,
    draft_saved_at: rows[0].theme_schema_draft_saved_at || null,
    published_at: rows[0].theme_schema_published_at || null,
  });
});

router.post("/:tenantId/theme-schema/save-draft", requireAdmin, async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!tenantId) return res.status(400).json({ error: "Invalid tenantId" });

  await ensureThemeSchemaColumns();

  const schema = parseJsonBody(req);
  if (!schema) return res.status(400).json({ error: "Missing draft schema" });

  await db.query(
    `UPDATE tenants
     SET theme_schema_draft_json = $1::jsonb,
         theme_schema_draft_saved_at = NOW()
     WHERE id = $2`,
    [JSON.stringify(schema), tenantId]
  );

  await logChange(tenantId, "THEME_SCHEMA_SAVE_DRAFT", getActor(req), { bytes: JSON.stringify(schema).length });

  res.json({ ok: true });
});

router.post("/:tenantId/theme-schema/publish", requireAdmin, async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!tenantId) return res.status(400).json({ error: "Invalid tenantId" });

  await ensureThemeSchemaColumns();

  // Phase 2D mini-win: if draft equals published and we already have a published
  // snapshot, treat this as a no-op publish (avoid touching timestamps).
  try {
    const guard = await db.query(
      `SELECT
         (theme_schema_published_json IS NOT NULL) AS has_published,
         (COALESCE(theme_schema_draft_json, 'null'::jsonb) = COALESCE(theme_schema_published_json, 'null'::jsonb)) AS no_schema_changes,
         theme_schema_published_at
       FROM tenants
       WHERE id = $1`,
      [tenantId]
    );
    const g = guard.rows?.[0];
    if (g?.has_published && g?.no_schema_changes) {
      return res.status(200).json({ ok: true, no_changes: true, published_at: g.theme_schema_published_at || null });
    }
  } catch (e) {
    // Guard failures should not block publishing.
  }

  const { rows } = await db.query(
    `UPDATE tenants
     SET theme_schema_published_json = theme_schema_draft_json,
         theme_schema_published_at = NOW()
     WHERE id = $1
     RETURNING theme_schema_published_at`,
    [tenantId]
  );
  if (!rows[0]) return res.status(404).json({ error: "Tenant not found" });

  await logChange(tenantId, "THEME_SCHEMA_PUBLISH", getActor(req), {});

  res.json({ ok: true, published_at: rows[0].theme_schema_published_at });
});

router.post("/:tenantId/theme-schema/rollback", requireAdmin, async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!tenantId) return res.status(400).json({ error: "Invalid tenantId" });

  await ensureThemeSchemaColumns();

  const { rows } = await db.query(
    `UPDATE tenants
     SET theme_schema_draft_json = theme_schema_published_json,
         theme_schema_draft_saved_at = NOW()
     WHERE id = $1
     RETURNING theme_schema_published_json IS NOT NULL AS has_published`,
    [tenantId]
  );
  if (!rows[0]) return res.status(404).json({ error: "Tenant not found" });
  if (!rows[0].has_published) {
    return res.status(400).json({ error: "Nothing published yet" });
  }

  await logChange(tenantId, "THEME_SCHEMA_ROLLBACK", getActor(req), {});

  res.json({ ok: true });
});

router.get("/:tenantId/theme-schema/changelog", requireAdmin, async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!tenantId) return res.status(400).json({ error: "Invalid tenantId" });

  await ensureChangelog();

  const { rows } = await db.query(
    `SELECT id, tenant_id, action, actor, metadata, created_at
     FROM tenant_theme_schema_changelog
     WHERE tenant_id = $1
     ORDER BY created_at DESC
     LIMIT 25`,
    [tenantId]
  );
  res.json({ entries: rows });
});

// -----------------------------------------------------------------------------
// Phase 1: Branding endpoints (draft/publish/rollback)
// These mirror the theme schema behavior but use:
// - branding (draft)
// - branding_published (published snapshot)
// - publish_status ("draft"|"published")
// -----------------------------------------------------------------------------
router.get("/:tenantId/branding", requireAdmin, async (req, res) => {
  try {
    const tenantId = Number(req.params.tenantId);
    if (!Number.isFinite(tenantId) || tenantId <= 0) {
      return res.status(400).json({ error: "Invalid tenantId" });
    }

    await ensureBrandingColumns();

    const { rows } = await db.query(
      `SELECT id, branding, branding_published, publish_status, branding_draft_saved_at, branding_published_at
       FROM tenants
       WHERE id = $1`,
      [tenantId]
    );

    if (!rows[0]) return res.status(404).json({ error: "Tenant not found" });

    return res.json({
      tenant_id: rows[0].id,
      draft: rows[0].branding || {},
      published: rows[0].branding_published || {},
      publish_status: rows[0].publish_status || null,
      draft_saved_at: rows[0].branding_draft_saved_at || null,
      published_at: rows[0].branding_published_at || null,
    });
  } catch (e) {
    console.error("GET /api/admin/tenants/:tenantId/branding error:", e);
    return res.status(500).json({ error: "Failed to load branding" });
  }
});

router.post("/:tenantId/branding/save-draft", requireAdmin, async (req, res) => {
  try {
    const tenantId = Number(req.params.tenantId);
    if (!Number.isFinite(tenantId) || tenantId <= 0) {
      return res.status(400).json({ error: "Invalid tenantId" });
    }

    await ensureBrandingColumns();

    const branding = parseJsonBody(req);
    if (!branding) return res.status(400).json({ error: "Missing draft branding" });

    await db.query(
      `UPDATE tenants
       SET branding = $1::jsonb,
           branding_draft_saved_at = NOW(),
           publish_status = COALESCE(NULLIF(publish_status, ''), 'draft')
       WHERE id = $2`,
      [JSON.stringify(branding), tenantId]
    );

    await logChange(tenantId, "BRANDING_SAVE_DRAFT", getActor(req), { bytes: JSON.stringify(branding).length });

    return res.json({ ok: true });
  } catch (e) {
    console.error("POST /api/admin/tenants/:tenantId/branding/save-draft error:", e);
    return res.status(500).json({ error: "Failed to save branding draft" });
  }
});

router.post("/:tenantId/branding/publish", requireAdmin, async (req, res) => {
  try {
    const tenantId = Number(req.params.tenantId);
    if (!Number.isFinite(tenantId) || tenantId <= 0) {
      return res.status(400).json({ error: "Invalid tenantId" });
    }

    await ensureBrandingColumns();

    const { rows } = await db.query(
      `UPDATE tenants
       SET branding_published = branding,
           branding_published_at = NOW(),
           publish_status = 'published'
       WHERE id = $1
       RETURNING branding_published_at`,
      [tenantId]
    );

    if (!rows[0]) return res.status(404).json({ error: "Tenant not found" });

    await logChange(tenantId, "BRANDING_PUBLISH", getActor(req), {});

    return res.json({ ok: true, published_at: rows[0].branding_published_at });
  } catch (e) {
    console.error("POST /api/admin/tenants/:tenantId/branding/publish error:", e);
    return res.status(500).json({ error: "Failed to publish branding" });
  }
});

router.post("/:tenantId/branding/rollback", requireAdmin, async (req, res) => {
  try {
    const tenantId = Number(req.params.tenantId);
    if (!Number.isFinite(tenantId) || tenantId <= 0) {
      return res.status(400).json({ error: "Invalid tenantId" });
    }

    await ensureBrandingColumns();

    const { rows } = await db.query(
      `UPDATE tenants
       SET branding = branding_published,
           branding_draft_saved_at = NOW()
       WHERE id = $1
       RETURNING branding_published IS NOT NULL AS has_published`,
      [tenantId]
    );

    if (!rows[0]) return res.status(404).json({ error: "Tenant not found" });
    if (!rows[0].has_published) {
      return res.status(400).json({ error: "Nothing published yet" });
    }

    await logChange(tenantId, "BRANDING_ROLLBACK", getActor(req), {});

    return res.json({ ok: true });
  } catch (e) {
    console.error("POST /api/admin/tenants/:tenantId/branding/rollback error:", e);
    return res.status(500).json({ error: "Failed to rollback branding" });
  }
});

// ---------------------------------------------------------------------------
// Phase D1: Admin Plan Summary (read-only)
// GET /api/admin/tenants/:tenantId/plan-summary
// - Used by Owner/Tenant setup UI to show plan, limits, usage, and trial state.
// ---------------------------------------------------------------------------
router.get("/:tenantId/plan-summary", requireAdmin, async (req, res) => {
  try {
    const tenantId = Number(req.params.tenantId);
    if (!Number.isFinite(tenantId) || tenantId <= 0) {
      return res.status(400).json({ error: "Invalid tenant id" });
    }

    const summary = await getPlanSummaryForTenant(tenantId);
    return res.json(summary);
  } catch (e) {
    console.error("GET /api/admin/tenants/:tenantId/plan-summary error:", e);
    return res.status(500).json({ error: "Failed to load plan summary" });
  }
});

module.exports = router;
