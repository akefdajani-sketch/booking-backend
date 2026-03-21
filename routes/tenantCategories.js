// routes/tenantCategories.js
// PR-CAT1: Service Categories CRUD
//
// Mirrors routes/resources.js exactly.
// All writes are owner/manager only. Reads are public (used by booking tab).

const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const db = pool;

const requireAdminOrTenantRole = require("../middleware/requireAdminOrTenantRole");
const { requireTenant } = require("../middleware/requireTenant");

// ---------------------------------------------------------------------------
// Resolve tenant from a category id — used by mutating routes
// ---------------------------------------------------------------------------
async function resolveTenantFromCategoryId(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0)
      return res.status(400).json({ error: "invalid id" });

    const { rows } = await db.query(
      "SELECT tenant_id FROM service_categories WHERE id = $1",
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Category not found" });

    req.tenantId = Number(rows[0].tenant_id);
    req.body = req.body || {};
    req.body.tenantId = req.body.tenantId || req.tenantId;
    return next();
  } catch (e) {
    console.error("resolveTenantFromCategoryId error:", e);
    return res.status(500).json({ error: "Failed to resolve tenant." });
  }
}

// ---------------------------------------------------------------------------
// GET /api/tenant-categories?tenantSlug=&tenantId=&includeInactive=
// Public — used by the public booking tab to build the category filter.
// ---------------------------------------------------------------------------
router.get("/", async (req, res) => {
  try {
    const { tenantSlug, tenantId, includeInactive } = req.query;

    const params = [];
    const where = [];

    if (tenantId) {
      params.push(Number(tenantId));
      where.push(`sc.tenant_id = $${params.length}`);
    } else if (tenantSlug) {
      params.push(String(tenantSlug));
      where.push(`t.slug = $${params.length}`);
    }

    if (!includeInactive || includeInactive === "false") {
      where.push(`sc.is_active = true`);
    }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const q = `
      SELECT
        sc.*,
        t.slug AS tenant_slug
      FROM service_categories sc
      JOIN tenants t ON t.id = sc.tenant_id
      ${whereClause}
      ORDER BY sc.display_order ASC, sc.created_at ASC
    `;

    const result = await db.query(q, params);
    return res.json({ categories: result.rows });
  } catch (err) {
    console.error("GET /api/tenant-categories error:", err);
    return res.status(500).json({ error: "Failed to fetch categories" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/tenant-categories  (owner/manager only)
// ---------------------------------------------------------------------------
router.post(
  "/",
  requireTenant,
  requireAdminOrTenantRole("manager"),
  async (req, res) => {
    try {
      const {
        tenant_id,
        name,
        description,
        image_url,
        color,
        display_order,
        is_active,
      } = req.body;

      if (!tenant_id || !name || !String(name).trim()) {
        return res
          .status(400)
          .json({ error: "tenant_id and name are required" });
      }

      const result = await db.query(
        `
        INSERT INTO service_categories
          (tenant_id, name, description, image_url, color, display_order, is_active)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
        `,
        [
          Number(tenant_id),
          String(name).trim(),
          description ? String(description).trim() : null,
          image_url ? String(image_url).trim() : null,
          color ? String(color).trim() : null,
          display_order != null ? Number(display_order) : 0,
          is_active ?? true,
        ]
      );

      return res.json({ category: result.rows[0] });
    } catch (err) {
      // 23505 = unique_violation (duplicate name per tenant)
      if (err && err.code === "23505") {
        return res
          .status(409)
          .json({ error: "A category with that name already exists." });
      }
      console.error("POST /api/tenant-categories error:", err);
      return res.status(500).json({ error: "Failed to create category" });
    }
  }
);

// ---------------------------------------------------------------------------
// PATCH /api/tenant-categories/:id  (owner/manager only)
// ---------------------------------------------------------------------------
router.patch(
  "/:id",
  resolveTenantFromCategoryId,
  requireAdminOrTenantRole("manager"),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      const { name, description, image_url, color, display_order, is_active } =
        req.body || {};

      const sets = [];
      const params = [];
      const add = (col, val) => {
        params.push(val);
        sets.push(`${col} = $${params.length}`);
      };

      if (name !== undefined)
        add("name", name == null ? null : String(name).trim());
      if (description !== undefined)
        add(
          "description",
          description == null ? null : String(description).trim()
        );
      if (image_url !== undefined)
        add("image_url", image_url == null ? null : String(image_url).trim());
      if (color !== undefined)
        add("color", color == null ? null : String(color).trim());
      if (display_order !== undefined)
        add("display_order", Number(display_order) || 0);
      if (is_active !== undefined) add("is_active", !!is_active);

      if (!sets.length)
        return res.status(400).json({ error: "No fields to update" });

      // Always update updated_at
      sets.push(`updated_at = NOW()`);

      params.push(id);
      const q = `
        UPDATE service_categories
        SET ${sets.join(", ")}
        WHERE id = $${params.length}
        RETURNING *
      `;
      const result = await db.query(q, params);
      if (!result.rows.length)
        return res.status(404).json({ error: "Category not found" });

      return res.json({ ok: true, category: result.rows[0] });
    } catch (err) {
      if (err && err.code === "23505") {
        return res
          .status(409)
          .json({ error: "A category with that name already exists." });
      }
      console.error("PATCH /api/tenant-categories/:id error:", err);
      return res.status(500).json({ error: "Failed to update category" });
    }
  }
);

// ---------------------------------------------------------------------------
// DELETE /api/tenant-categories/:id  (owner/manager only)
// Deleting a category sets category_id = NULL on its services (ON DELETE SET NULL).
// We do a soft-disable instead of hard delete if something prevents it.
// ---------------------------------------------------------------------------
router.delete(
  "/:id",
  resolveTenantFromCategoryId,
  requireAdminOrTenantRole("manager"),
  async (req, res) => {
    try {
      const id = Number(req.params.id);

      // Count services that will be uncategorised — warn the caller
      const { rows: countRows } = await db.query(
        `SELECT COUNT(*)::int AS service_count FROM services WHERE category_id = $1 AND deleted_at IS NULL`,
        [id]
      );
      const affectedServices = countRows[0]?.service_count ?? 0;

      await db.query(`DELETE FROM service_categories WHERE id = $1`, [id]);
      return res.json({ ok: true, deleted: true, affectedServices });
    } catch (err) {
      // FK violation — shouldn't happen due to ON DELETE SET NULL, but be safe
      if (err && err.code === "23503") {
        const result = await db.query(
          `UPDATE service_categories SET is_active = false, updated_at = NOW()
           WHERE id = $1 RETURNING id, is_active`,
          [Number(req.params.id)]
        );
        if (!result.rows.length)
          return res.status(404).json({ error: "Category not found" });
        return res.json({ ok: true, deleted: false, deactivated: true });
      }
      console.error("DELETE /api/tenant-categories/:id error:", err);
      return res.status(500).json({ error: "Failed to delete category" });
    }
  }
);

module.exports = router;
