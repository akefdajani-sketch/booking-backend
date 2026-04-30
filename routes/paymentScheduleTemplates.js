'use strict';

// routes/paymentScheduleTemplates.js
// G2a-1: Payment schedule templates CRUD.
//
// Mount in app.js:
//   app.use('/api/payment-schedule-templates', require('./routes/paymentScheduleTemplates'));
//
// Routes:
//   GET    /api/payment-schedule-templates           — list (tenant's own + platform defaults)
//   POST   /api/payment-schedule-templates           — create tenant template
//   GET    /api/payment-schedule-templates/:id       — get one (tenant's own OR a platform row)
//   PATCH  /api/payment-schedule-templates/:id       — update (rejects is_system rows)
//   DELETE /api/payment-schedule-templates/:id       — soft-delete (active=false); rejects is_system

const express = require('express');
const router  = express.Router();
const { pool } = require('../db');
const db = pool;

const requireAppAuth           = require('../middleware/requireAppAuth');
const { requireTenant }        = require('../middleware/requireTenant');
const requireAdminOrTenantRole = require('../middleware/requireAdminOrTenantRole');
const logger                   = require('../utils/logger');

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_SCOPES = new Set(['any', 'long_stay', 'contract_stay']);

function validateMilestones(milestones) {
  if (!Array.isArray(milestones) || milestones.length === 0) {
    return 'milestones must be a non-empty array';
  }
  let pctSum = 0;
  for (let i = 0; i < milestones.length; i++) {
    const m = milestones[i];
    if (!m || typeof m !== 'object') return `milestones[${i}] must be an object`;
    if (!m.label || typeof m.label !== 'string') return `milestones[${i}].label required`;
    const pct = Number(m.percent);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      return `milestones[${i}].percent must be 0..100`;
    }
    pctSum += pct;
    const validTriggers = ['signing', 'check_in', 'mid_stay', 'monthly_on_first', 'monthly_relative'];
    if (!validTriggers.includes(m.trigger)) {
      return `milestones[${i}].trigger must be one of ${validTriggers.join('|')}`;
    }
  }
  if (Math.abs(pctSum - 100) > 0.01) {
    return `milestone percents sum to ${pctSum}, expected 100`;
  }
  return null;
}

function normalizeBody(body) {
  const src = (body && typeof body === 'object') ? body : {};
  return {
    name:            String(src.name || '').trim(),
    description:     src.description != null ? String(src.description) : null,
    stay_type_scope: String(src.stay_type_scope || 'any').trim(),
    milestones:      src.milestones,
    is_default:      src.is_default === true || src.is_default === 'true',
  };
}

// ---------------------------------------------------------------------------
// GET / — list
// ---------------------------------------------------------------------------

router.get(
  '/',
  requireAppAuth,
  requireTenant,
  requireAdminOrTenantRole('staff'),
  async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      if (!Number.isFinite(tenantId) || tenantId <= 0) {
        return res.status(400).json({ error: 'Invalid tenant.' });
      }
      const scopeFilter = (req.query.stay_type_scope || '').toString().trim();

      const where = [`active = TRUE`, `(tenant_id = $1 OR tenant_id IS NULL)`];
      const params = [tenantId];
      if (scopeFilter && VALID_SCOPES.has(scopeFilter)) {
        params.push(scopeFilter);
        where.push(`(stay_type_scope = $${params.length} OR stay_type_scope = 'any')`);
      }

      const { rows } = await db.query(
        `SELECT id, tenant_id, name, description, stay_type_scope,
                milestones, is_default, is_system, active, duration_months,
                created_at, updated_at
           FROM payment_schedule_templates
          WHERE ${where.join(' AND ')}
          ORDER BY tenant_id NULLS LAST, is_default DESC, name ASC`,
        params
      );
      return res.json({ templates: rows });
    } catch (err) {
      logger.error({ err }, 'list payment_schedule_templates failed');
      return res.status(500).json({ error: 'Failed to load templates' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /:id — single (tenant's own or platform row)
// ---------------------------------------------------------------------------

router.get(
  '/:id',
  requireAppAuth,
  requireTenant,
  requireAdminOrTenantRole('staff'),
  async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid id' });
      }
      const { rows } = await db.query(
        `SELECT id, tenant_id, name, description, stay_type_scope,
                milestones, is_default, is_system, active, duration_months,
                created_at, updated_at
           FROM payment_schedule_templates
          WHERE id = $1
            AND active = TRUE
            AND (tenant_id = $2 OR tenant_id IS NULL)`,
        [id, tenantId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Template not found' });
      return res.json({ template: rows[0] });
    } catch (err) {
      logger.error({ err }, 'get payment_schedule_template failed');
      return res.status(500).json({ error: 'Failed to load template' });
    }
  }
);

// ---------------------------------------------------------------------------
// POST / — create
// ---------------------------------------------------------------------------

router.post(
  '/',
  requireAppAuth,
  requireTenant,
  requireAdminOrTenantRole('owner'),
  async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      if (!Number.isFinite(tenantId) || tenantId <= 0) {
        return res.status(400).json({ error: 'Invalid tenant.' });
      }

      const body = normalizeBody(req.body);
      if (!body.name) return res.status(400).json({ error: 'name required' });
      if (!VALID_SCOPES.has(body.stay_type_scope)) {
        return res.status(400).json({ error: `stay_type_scope must be one of ${[...VALID_SCOPES].join('|')}` });
      }
      const msError = validateMilestones(body.milestones);
      if (msError) return res.status(400).json({ error: msError });

      // If is_default=true, clear prior default for this (tenant, scope) inside a tx.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        if (body.is_default) {
          await client.query(
            `UPDATE payment_schedule_templates
                SET is_default = FALSE, updated_at = NOW()
              WHERE tenant_id = $1
                AND stay_type_scope = $2
                AND is_default = TRUE
                AND active = TRUE`,
            [tenantId, body.stay_type_scope]
          );
        }

        const { rows } = await client.query(
          `INSERT INTO payment_schedule_templates
             (tenant_id, name, description, stay_type_scope, milestones,
              is_default, is_system, active)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, FALSE, TRUE)
           RETURNING id, tenant_id, name, description, stay_type_scope,
                     milestones, is_default, is_system, active,
                     created_at, updated_at`,
          [
            tenantId, body.name, body.description, body.stay_type_scope,
            JSON.stringify(body.milestones), body.is_default,
          ]
        );
        await client.query('COMMIT');
        return res.status(201).json({ template: rows[0] });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      logger.error({ err }, 'create payment_schedule_template failed');
      return res.status(500).json({ error: 'Failed to create template' });
    }
  }
);

// ---------------------------------------------------------------------------
// PATCH /:id — update
// ---------------------------------------------------------------------------

router.patch(
  '/:id',
  requireAppAuth,
  requireTenant,
  requireAdminOrTenantRole('owner'),
  async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid id' });
      }

      // Verify ownership + not a system row
      const existing = await db.query(
        `SELECT id, tenant_id, is_system, stay_type_scope, is_default
           FROM payment_schedule_templates
          WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId]
      );
      if (!existing.rows.length) return res.status(404).json({ error: 'Template not found' });
      if (existing.rows[0].is_system) {
        return res.status(403).json({ error: 'Platform templates cannot be edited. Clone first.' });
      }

      const body = normalizeBody(req.body);
      const updates = [];
      const params = [];
      let p = 0;

      if (req.body.name !== undefined) {
        if (!body.name) return res.status(400).json({ error: 'name cannot be empty' });
        params.push(body.name); p++; updates.push(`name = $${p}`);
      }
      if (req.body.description !== undefined) {
        params.push(body.description); p++; updates.push(`description = $${p}`);
      }
      if (req.body.stay_type_scope !== undefined) {
        if (!VALID_SCOPES.has(body.stay_type_scope)) {
          return res.status(400).json({ error: `stay_type_scope must be one of ${[...VALID_SCOPES].join('|')}` });
        }
        params.push(body.stay_type_scope); p++; updates.push(`stay_type_scope = $${p}`);
      }
      if (req.body.milestones !== undefined) {
        const msError = validateMilestones(body.milestones);
        if (msError) return res.status(400).json({ error: msError });
        params.push(JSON.stringify(body.milestones)); p++; updates.push(`milestones = $${p}::jsonb`);
      }

      const scope = req.body.stay_type_scope !== undefined ? body.stay_type_scope : existing.rows[0].stay_type_scope;
      const becomingDefault = req.body.is_default === true;

      if (!updates.length && req.body.is_default === undefined) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        if (becomingDefault) {
          await client.query(
            `UPDATE payment_schedule_templates
                SET is_default = FALSE, updated_at = NOW()
              WHERE tenant_id = $1
                AND stay_type_scope = $2
                AND is_default = TRUE
                AND active = TRUE
                AND id <> $3`,
            [tenantId, scope, id]
          );
          updates.push(`is_default = TRUE`);
        } else if (req.body.is_default === false) {
          updates.push(`is_default = FALSE`);
        }

        updates.push(`updated_at = NOW()`);
        params.push(id); p++;
        params.push(tenantId); p++;

        const { rows } = await client.query(
          `UPDATE payment_schedule_templates
              SET ${updates.join(', ')}
            WHERE id = $${p - 1} AND tenant_id = $${p}
            RETURNING id, tenant_id, name, description, stay_type_scope,
                      milestones, is_default, is_system, active,
                      created_at, updated_at`,
          params
        );
        await client.query('COMMIT');
        if (!rows.length) return res.status(404).json({ error: 'Template not found' });
        return res.json({ template: rows[0] });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      logger.error({ err }, 'update payment_schedule_template failed');
      return res.status(500).json({ error: 'Failed to update template' });
    }
  }
);

// ---------------------------------------------------------------------------
// DELETE /:id — soft-delete (active = FALSE)
// ---------------------------------------------------------------------------

router.delete(
  '/:id',
  requireAppAuth,
  requireTenant,
  requireAdminOrTenantRole('owner'),
  async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid id' });
      }
      const { rows } = await db.query(
        `UPDATE payment_schedule_templates
            SET active = FALSE, is_default = FALSE, updated_at = NOW()
          WHERE id = $1 AND tenant_id = $2 AND is_system = FALSE
          RETURNING id`,
        [id, tenantId]
      );
      if (!rows.length) {
        return res.status(404).json({
          error: 'Template not found, or is a platform template (cannot delete).'
        });
      }
      return res.json({ ok: true, id: rows[0].id });
    } catch (err) {
      logger.error({ err }, 'delete payment_schedule_template failed');
      return res.status(500).json({ error: 'Failed to delete template' });
    }
  }
);

module.exports = router;
