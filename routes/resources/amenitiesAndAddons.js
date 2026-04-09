// routes/resources/amenitiesAndAddons.js
// ---------------------------------------------------------------------------
// NIGHTLY SUITE: Amenities + Paid Add-ons per resource
//
// Mount at the bottom of routes/resources.js:
//   require('./resources/amenitiesAndAddons')(router);
//
// Endpoints:
//   GET    /api/resources/:id/amenities
//   POST   /api/resources/:id/amenities
//   PATCH  /api/resources/:id/amenities/:amenityId
//   DELETE /api/resources/:id/amenities/:amenityId
//
//   GET    /api/resources/:id/addons
//   POST   /api/resources/:id/addons
//   PATCH  /api/resources/:id/addons/:addonId
//   DELETE /api/resources/:id/addons/:addonId
//
// Public reads (no auth) are served through the same proxy allowlist as
// resources (already permitted).
// ---------------------------------------------------------------------------

// Use the same middleware that resources.js uses — passed in from the parent router context.
// resolveTenantFromResourceId is defined in routes/resources.js and passed as a parameter,
// and requireAdminOrTenantRole comes from middleware/requireAdminOrTenantRole.js
const requireAdminOrTenantRole = require("../../middleware/requireAdminOrTenantRole");
const { requireTenant }        = require("../../middleware/requireTenant");


const db = require("../../db");

// resolveTenantFromResourceId is defined in routes/resources.js.
// It is passed in here to avoid a circular dependency and to reuse
// the same tested middleware already used by all other resource routes.
module.exports = function attachAmenitiesAndAddons(router, resolveTenantFromResourceId) {

  // ── helper: check columns exist (idempotent migration guard) ──────────────
  async function tableHasColumn(table, col) {
    const r = await db.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name=$1 AND column_name=$2 LIMIT 1`,
      [table, col]
    );
    return r.rows.length > 0;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // AMENITIES
  // ─────────────────────────────────────────────────────────────────────────

  // GET /api/resources/:id/amenities  (public — no auth needed)
  router.get("/:id/amenities", async (req, res) => {
    try {
      const resourceId = Number(req.params.id);
      if (!Number.isFinite(resourceId)) return res.status(400).json({ error: "Invalid id" });

      // Guard: table may not exist yet if migration hasn't run
      const exists = await tableHasColumn("resource_amenities", "id").catch(() => false);
      if (!exists) return res.json({ amenities: [] });

      const { rows } = await db.query(
        `SELECT * FROM resource_amenities
         WHERE resource_id = $1 AND is_active = TRUE
         ORDER BY sort_order ASC, id ASC`,
        [resourceId]
      );
      res.json({ amenities: rows });
    } catch (err) {
      console.error("GET amenities error:", err);
      res.status(500).json({ error: "Failed to fetch amenities" });
    }
  });

  // POST /api/resources/:id/amenities  (admin / manager)
  router.post("/:id/amenities", resolveTenantFromResourceId, requireAdminOrTenantRole("manager"), async (req, res) => {
    try {
      const resourceId = Number(req.params.id);
      const tenantId   = req.tenantId;
      const { label, icon, category, sort_order } = req.body || {};

      if (!label) return res.status(400).json({ error: "label is required" });

      const { rows } = await db.query(
        `INSERT INTO resource_amenities (tenant_id, resource_id, label, icon, category, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [tenantId, resourceId, String(label).trim(), icon || null, category || null, Number(sort_order) || 0]
      );
      res.status(201).json({ amenity: rows[0] });
    } catch (err) {
      console.error("POST amenities error:", err);
      res.status(500).json({ error: "Failed to create amenity" });
    }
  });

  // PATCH /api/resources/:id/amenities/:amenityId
  router.patch("/:id/amenities/:amenityId", resolveTenantFromResourceId, requireAdminOrTenantRole("manager"), async (req, res) => {
    try {
      const resourceId  = Number(req.params.id);
      const amenityId   = Number(req.params.amenityId);
      const { label, icon, category, sort_order, is_active } = req.body || {};

      const sets = []; const params = [];
      const add = (col, val) => { params.push(val); sets.push(`${col}=$${params.length}`); };

      if (label      !== undefined) add("label",      String(label).trim());
      if (icon       !== undefined) add("icon",       icon || null);
      if (category   !== undefined) add("category",   category || null);
      if (sort_order !== undefined) add("sort_order", Number(sort_order) || 0);
      if (is_active  !== undefined) add("is_active",  !!is_active);

      if (!sets.length) return res.status(400).json({ error: "Nothing to update" });

      params.push(amenityId, resourceId);
      const { rows } = await db.query(
        `UPDATE resource_amenities SET ${sets.join(",")}
         WHERE id=$${params.length-1} AND resource_id=$${params.length} RETURNING *`,
        params
      );
      if (!rows.length) return res.status(404).json({ error: "Amenity not found" });
      res.json({ amenity: rows[0] });
    } catch (err) {
      console.error("PATCH amenity error:", err);
      res.status(500).json({ error: "Failed to update amenity" });
    }
  });

  // DELETE /api/resources/:id/amenities/:amenityId
  router.delete("/:id/amenities/:amenityId", resolveTenantFromResourceId, requireAdminOrTenantRole("manager"), async (req, res) => {
    try {
      const amenityId  = Number(req.params.amenityId);
      const resourceId = Number(req.params.id);
      await db.query(
        `UPDATE resource_amenities SET is_active=FALSE WHERE id=$1 AND resource_id=$2`,
        [amenityId, resourceId]
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to delete amenity" });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ADD-ONS
  // ─────────────────────────────────────────────────────────────────────────

  // GET /api/resources/:id/addons  (public)
  router.get("/:id/addons", async (req, res) => {
    try {
      const resourceId = Number(req.params.id);
      if (!Number.isFinite(resourceId)) return res.status(400).json({ error: "Invalid id" });

      const exists = await tableHasColumn("resource_addons", "id").catch(() => false);
      if (!exists) return res.json({ addons: [] });

      // Get tenant currency as fallback
      const { rows } = await db.query(
        `SELECT a.*, COALESCE(a.currency_code, t.currency_code, 'JOD') AS effective_currency
         FROM resource_addons a
         JOIN resources r ON r.id = a.resource_id
         JOIN tenants   t ON t.id = a.tenant_id
         WHERE a.resource_id = $1 AND a.is_active = TRUE
         ORDER BY a.sort_order ASC, a.id ASC`,
        [resourceId]
      );
      res.json({ addons: rows });
    } catch (err) {
      console.error("GET addons error:", err);
      res.status(500).json({ error: "Failed to fetch add-ons" });
    }
  });

  // POST /api/resources/:id/addons  (admin / manager)
  router.post("/:id/addons", resolveTenantFromResourceId, requireAdminOrTenantRole("manager"), async (req, res) => {
    try {
      const resourceId = Number(req.params.id);
      const tenantId   = req.tenantId;
      const { label, icon, description, price, price_type, sort_order } = req.body || {};

      if (!label) return res.status(400).json({ error: "label is required" });
      if (price == null) return res.status(400).json({ error: "price is required" });

      const validTypes = ["per_night", "flat", "per_guest"];
      const pt = validTypes.includes(price_type) ? price_type : "flat";

      const { rows } = await db.query(
        `INSERT INTO resource_addons
           (tenant_id, resource_id, label, icon, description, price, price_type, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [tenantId, resourceId, String(label).trim(), icon||null, description||null,
         Number(price), pt, Number(sort_order)||0]
      );
      res.status(201).json({ addon: rows[0] });
    } catch (err) {
      console.error("POST addons error:", err);
      res.status(500).json({ error: "Failed to create add-on" });
    }
  });

  // PATCH /api/resources/:id/addons/:addonId
  router.patch("/:id/addons/:addonId", resolveTenantFromResourceId, requireAdminOrTenantRole("manager"), async (req, res) => {
    try {
      const resourceId = Number(req.params.id);
      const addonId    = Number(req.params.addonId);
      const { label, icon, description, price, price_type, sort_order, is_active } = req.body || {};

      const sets = []; const params = [];
      const add = (col, val) => { params.push(val); sets.push(`${col}=$${params.length}`); };

      if (label       !== undefined) add("label",       String(label).trim());
      if (icon        !== undefined) add("icon",        icon||null);
      if (description !== undefined) add("description", description||null);
      if (price       !== undefined) add("price",       Number(price));
      if (price_type  !== undefined) add("price_type",  ["per_night","flat","per_guest"].includes(price_type) ? price_type : "flat");
      if (sort_order  !== undefined) add("sort_order",  Number(sort_order)||0);
      if (is_active   !== undefined) add("is_active",   !!is_active);

      if (!sets.length) return res.status(400).json({ error: "Nothing to update" });

      params.push(addonId, resourceId);
      const { rows } = await db.query(
        `UPDATE resource_addons SET ${sets.join(",")}
         WHERE id=$${params.length-1} AND resource_id=$${params.length} RETURNING *`,
        params
      );
      if (!rows.length) return res.status(404).json({ error: "Add-on not found" });
      res.json({ addon: rows[0] });
    } catch (err) {
      console.error("PATCH addon error:", err);
      res.status(500).json({ error: "Failed to update add-on" });
    }
  });

  // DELETE /api/resources/:id/addons/:addonId
  router.delete("/:id/addons/:addonId", resolveTenantFromResourceId, requireAdminOrTenantRole("manager"), async (req, res) => {
    try {
      const addonId    = Number(req.params.addonId);
      const resourceId = Number(req.params.id);
      await db.query(
        `UPDATE resource_addons SET is_active=FALSE WHERE id=$1 AND resource_id=$2`,
        [addonId, resourceId]
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to delete add-on" });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PROPERTY DETAILS (on the resource itself)
  // PATCH /api/resources/:id/property-details
  // ─────────────────────────────────────────────────────────────────────────
  router.patch("/:id/property-details", resolveTenantFromResourceId, requireAdminOrTenantRole("manager"), async (req, res) => {
    try {
      const resourceId = Number(req.params.id);
      const {
        bedrooms, bathrooms, area_sqm, max_guests, floor,
        description, house_rules, cancellation_policy
      } = req.body || {};

      // Merge with existing JSON so partial updates don't wipe other fields
      const { rows: existing } = await db.query(
        `SELECT property_details_json FROM resources WHERE id=$1`, [resourceId]
      );
      const current = existing[0]?.property_details_json || {};

      const merged = {
        ...current,
        ...(bedrooms            != null ? { bedrooms:             Number(bedrooms) }             : {}),
        ...(bathrooms           != null ? { bathrooms:            Number(bathrooms) }            : {}),
        ...(area_sqm            != null ? { area_sqm:             Number(area_sqm) }             : {}),
        ...(max_guests          != null ? { max_guests:           Number(max_guests) }           : {}),
        ...(floor               != null ? { floor:                Number(floor) }                : {}),
        ...(description         != null ? { description:          String(description) }          : {}),
        ...(house_rules         != null ? { house_rules:          String(house_rules) }          : {}),
        ...(cancellation_policy != null ? { cancellation_policy:  String(cancellation_policy) }  : {}),
      };

      const { rows } = await db.query(
        `UPDATE resources SET property_details_json=$1 WHERE id=$2 RETURNING *`,
        [JSON.stringify(merged), resourceId]
      );
      res.json({ ok: true, resource: rows[0] });
    } catch (err) {
      console.error("PATCH property-details error:", err);
      res.status(500).json({ error: "Failed to update property details" });
    }
  });
};
