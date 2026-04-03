// routes/services/images.js
// POST/:id/image, DELETE/:id/image
// Mounted by routes/services.js

const db = require("../../db");
const { pool } = require("../../db");
const requireAdminOrTenantRole = require("../../middleware/requireAdminOrTenantRole");
const requireAppAuth = require("../../middleware/requireAppAuth");
const { requireTenant } = require("../../middleware/requireTenant");
const { r2Upload, deleteFromR2 } = require("../../utils/r2");
const {
  resolveTenantFromServiceId, normalizeAvailabilityBasis, normalizeAllowMembership,
  getServicesColumns, getTenantsColumns, serviceHoursTableExists,
} = require("../../utils/servicesHelpers");


module.exports = function mount(router) {
router.post(
  "/:id/image",
  resolveTenantFromServiceId,
  requireAdminOrTenantRole("manager"),
  upload.single("file"),
  uploadErrorHandler,
  async (req, res) => {
    const id = Number(req.params.id);

    if (!id) return res.status(400).json({ error: "invalid id" });
    if (!req.file) return res.status(400).json({ error: "file is required" });

    const tmpPath = req.file.path;

    try {
      const meta = await db.query(
        `
        SELECT s.id, s.name AS service_name, t.slug AS tenant_slug
        FROM services s
        JOIN tenants t ON t.id = s.tenant_id
        WHERE s.id = $1
        `,
        [id]
      );

      if (!meta.rows.length) return res.status(404).json({ error: "not found" });

      const { tenant_slug, service_name } = meta.rows[0];

      const safeTenant = safeName(tenant_slug || "tenant");
      const safeService = safeName(service_name || `service-${id}`);

      const key = `tenants/${safeTenant}/services/${id}-${safeService}-${Date.now()}`;

      const { url } = await uploadFileToR2({
        filePath: tmpPath,
        contentType: req.file.mimetype,
        key,
      });

      const svcCols = await getServicesColumns();

      // Prefer image_url if present, else legacy photo_url
      const sets = [];
      const params = [id, url];
      if (svcCols.has("image_url")) sets.push("image_url = $2");
      else if (svcCols.has("photo_url")) sets.push("photo_url = $2");
      else return res.status(500).json({ error: "DB misconfigured: no image_url/photo_url column" });

      // Optional: image_key if present
      if (svcCols.has("image_key")) {
        params.push(key);
        sets.push(`image_key = $${params.length}`);
      }

      const q = `
        UPDATE services
        SET ${sets.join(", ")}
        WHERE id = $1
        RETURNING *
      `;

      const out = await db.query(q, params);
      return res.json(out.rows[0]);
    } catch (err) {
      console.error("Error uploading service image:", err);
      return res.status(500).json({ error: "Failed to upload image" });
    } finally {
      try { await fsp.unlink(tmpPath); } catch {}
    }
  }
);


// ---------------------------------------------------------------------------
// DELETE /api/services/:id/image (admin-only)
// Clears image_url/photo_url and deletes R2 object if image_key exists.
// ---------------------------------------------------------------------------
router.delete("/:id/image", resolveTenantFromServiceId, requireAdminOrTenantRole("manager"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "invalid id" });

    const svcCols = await getServicesColumns();

    // Decide which URL column to clear
    let urlCol = null;
    if (svcCols.has("image_url")) urlCol = "image_url";
    else if (svcCols.has("photo_url")) urlCol = "photo_url";
    else return res.status(500).json({ error: "DB misconfigured: no image_url/photo_url column" });

    // Read old key if the column exists
    let oldKey = null;
    if (svcCols.has("image_key")) {
      const old = await db.query(`SELECT image_key FROM services WHERE id=$1 LIMIT 1`, [id]);
      oldKey = old.rows?.[0]?.image_key || null;
    }

    const sets = [`${urlCol}=NULL`];
    if (svcCols.has("image_key")) sets.push("image_key=NULL");

    const result = await db.query(
      `UPDATE services SET ${sets.join(", ")} WHERE id=$1 RETURNING *`,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "not found" });
    }

    if (oldKey) {
      await deleteFromR2(oldKey).catch(() => {});
    }

    return res.json({ ok: true, service: result.rows[0] });
  } catch (err) {
    console.error("Error deleting service image:", err);
    return res.status(500).json({ error: "Failed to delete image" });
  }
});
};
