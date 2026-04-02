// routes/adminTenantsTheme/theme.js
// appearance, diff, reset-to-inherit, theme-key, theme-schema CRUD, changelog, plan-summary
// Mounted by routes/adminTenantsTheme.js

const db = require("../../db");
const { pool } = require("../../db");
const requireAdminOrTenantRole = require("../../middleware/requireAdminOrTenantRole");
const {
  isPlainObject, stableStringify, jsonDiff, summarizeDiff, stripComputedVarsFromBranding,
  setTenantIdFromParam, ensureThemeSchemaColumns, ensureBrandingColumns, ensureThemeKeyColumn,
  ensureBrandOverridesColumn, ensureAppearanceSnapshotColumns, refreshAppearanceSnapshot,
  ensureChangelog, logChange, getActor, parseJsonBody,
} = require("../../utils/adminTenantsThemeHelpers");


module.exports = function mount(router) {
router.get("/:tenantId/appearance", setTenantIdFromParam, requireAdminOrTenantRole("owner"), async (req, res) => {
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
router.get("/:tenantId/appearance/diff", setTenantIdFromParam, requireAdminOrTenantRole("owner"), async (req, res) => {
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

router.post("/:tenantId/appearance/reset-to-inherit", setTenantIdFromParam, requireAdminOrTenantRole("owner"), async (req, res) => {
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


router.post("/:tenantId/theme-key", setTenantIdFromParam, requireAdminOrTenantRole("owner"), async (req, res) => {
  try {
    const tenantId = Number(req.params.tenantId);
    if (!Number.isFinite(tenantId) || tenantId <= 0) {
      return res.status(400).json({ error: "Invalid tenantId" });
    }

    await ensureThemeKeyColumn();

    const themeKey = String((req.body && (req.body.theme_key ?? req.body.themeKey)) || "").trim();
    if (!themeKey) return res.status(400).json({ error: "theme_key is required" });

    const tenant = await updateTenantThemeKey(db, tenantId, themeKey);

    await logChange(tenantId, "THEME_KEY_SET", getActor(req), { theme_key: themeKey });
    const appearance_snapshot = await refreshAppearanceSnapshot(tenantId);

    return res.json({ ok: true, tenant, appearance_snapshot });
  } catch (e) {
    const status = Number(e?.status) || 500;
    const msg = e?.message || "Failed to set theme key";
    if (status >= 500) console.error("POST /api/admin/tenants/:tenantId/theme-key error:", e);
    return res.status(status).json({ error: status >= 500 ? "Failed to set theme key" : msg });
  }
});


// -----------------------------------------------------------------------------
// Theme schema (existing endpoints, kept stable)
// -----------------------------------------------------------------------------
router.get("/:tenantId/theme-schema", setTenantIdFromParam, requireAdminOrTenantRole("owner"), async (req, res) => {
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

router.post("/:tenantId/theme-schema/save-draft", setTenantIdFromParam, requireAdminOrTenantRole("owner"), async (req, res) => {
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

router.post("/:tenantId/theme-schema/publish", setTenantIdFromParam, requireAdminOrTenantRole("owner"), async (req, res) => {
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
  const appearance_snapshot = await refreshAppearanceSnapshot(tenantId);

  res.json({ ok: true, published_at: rows[0].theme_schema_published_at, appearance_snapshot });
});

router.post("/:tenantId/theme-schema/rollback", setTenantIdFromParam, requireAdminOrTenantRole("owner"), async (req, res) => {
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

router.get("/:tenantId/theme-schema/changelog", setTenantIdFromParam, requireAdminOrTenantRole("owner"), async (req, res) => {
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
};
