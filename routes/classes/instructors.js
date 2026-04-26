'use strict';

// routes/classes/instructors.js
// G1: Instructor CRUD. Tenant-scoped via outer requireTenant middleware.

const db = require('../../db');
const logger = require('../../utils/logger');

module.exports = function mount(router) {
  // List instructors
  router.get('/instructors', async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const includeInactive = req.query.includeInactive === '1' || req.query.includeInactive === 'true';
      const where = ['tenant_id = $1'];
      if (!includeInactive) where.push('is_active = TRUE');
      const r = await db.query(
        `SELECT * FROM instructors
         WHERE ${where.join(' AND ')}
         ORDER BY display_order ASC, name ASC`,
        [tenantId]
      );
      return res.json({ instructors: r.rows });
    } catch (err) {
      logger.error({ err: err.message }, 'list instructors failed');
      return res.status(500).json({ error: 'Failed to load instructors.' });
    }
  });

  // Get one
  router.get('/instructors/:id', async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const id = Number(req.params.id);
      const r = await db.query(
        `SELECT * FROM instructors WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId]
      );
      if (r.rows.length === 0) return res.status(404).json({ error: 'Instructor not found.' });
      return res.json({ instructor: r.rows[0] });
    } catch (err) {
      logger.error({ err: err.message }, 'get instructor failed');
      return res.status(500).json({ error: 'Failed to load instructor.' });
    }
  });

  // Create
  router.post('/instructors', async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const body = req.body || {};
      const name = String(body.name || '').trim();
      if (!name) return res.status(400).json({ error: 'name is required.' });

      const r = await db.query(
        `INSERT INTO instructors
           (tenant_id, name, bio, photo_url, email, phone, specialties, staff_id, display_order, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, 0), NOW(), NOW())
         RETURNING *`,
        [
          tenantId, name,
          body.bio ?? null,
          body.photo_url ?? null,
          body.email ?? null,
          body.phone ?? null,
          Array.isArray(body.specialties) ? body.specialties : null,
          body.staff_id != null ? Number(body.staff_id) : null,
          body.display_order != null ? Number(body.display_order) : null,
        ]
      );
      return res.status(201).json({ instructor: r.rows[0] });
    } catch (err) {
      logger.error({ err: err.message }, 'create instructor failed');
      return res.status(500).json({ error: 'Failed to create instructor.' });
    }
  });

  // Update
  router.patch('/instructors/:id', async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const id = Number(req.params.id);
      const body = req.body || {};
      const fields = [];
      const params = [];
      let p = 1;
      const setIf = (col, val) => {
        if (val !== undefined) { fields.push(`${col} = $${p++}`); params.push(val); }
      };
      setIf('name', body.name);
      setIf('bio', body.bio);
      setIf('photo_url', body.photo_url);
      setIf('email', body.email);
      setIf('phone', body.phone);
      setIf('specialties', Array.isArray(body.specialties) ? body.specialties : undefined);
      setIf('staff_id', body.staff_id != null ? Number(body.staff_id) : null);
      setIf('display_order', body.display_order != null ? Number(body.display_order) : undefined);
      setIf('is_active', typeof body.is_active === 'boolean' ? body.is_active : undefined);

      if (fields.length === 0) return res.status(400).json({ error: 'No updatable fields supplied.' });

      fields.push(`updated_at = NOW()`);
      params.push(id, tenantId);

      const r = await db.query(
        `UPDATE instructors SET ${fields.join(', ')}
         WHERE id = $${p++} AND tenant_id = $${p}
         RETURNING *`,
        params
      );
      if (r.rows.length === 0) return res.status(404).json({ error: 'Instructor not found.' });
      return res.json({ instructor: r.rows[0] });
    } catch (err) {
      logger.error({ err: err.message }, 'update instructor failed');
      return res.status(500).json({ error: 'Failed to update instructor.' });
    }
  });

  // Soft delete (set is_active = false). Hard delete would cascade to sessions
  // which is rarely the intent. Tenants who really want hard delete can use SQL.
  router.delete('/instructors/:id', async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const id = Number(req.params.id);
      const r = await db.query(
        `UPDATE instructors SET is_active = FALSE, updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2 RETURNING id`,
        [id, tenantId]
      );
      if (r.rows.length === 0) return res.status(404).json({ error: 'Instructor not found.' });
      return res.json({ ok: true, id: r.rows[0].id });
    } catch (err) {
      logger.error({ err: err.message }, 'delete instructor failed');
      return res.status(500).json({ error: 'Failed to delete instructor.' });
    }
  });
};
