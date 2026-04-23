'use strict';

// routes/contracts/list.js
// GET /api/contracts
// G2a-1: List contracts with filters + pagination.

const { pool } = require('../../db');
const db = pool;
const logger = require('../../utils/logger');
const requireAppAuth           = require('../../middleware/requireAppAuth');
const { requireTenant }        = require('../../middleware/requireTenant');
const requireAdminOrTenantRole = require('../../middleware/requireAdminOrTenantRole');

function toNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const VALID_STATUSES = new Set([
  'draft','pending_signature','signed','active',
  'completed','terminated','expired','cancelled',
]);

module.exports = function mount(router) {
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

        const customerId = toNum(req.query.customer_id ?? req.query.customerId);
        const resourceId = toNum(req.query.resource_id ?? req.query.resourceId);
        const bookingId  = toNum(req.query.booking_id ?? req.query.bookingId);
        const statusRaw  = (req.query.status || '').toString().trim();
        const limit  = Math.min(Math.max(toNum(req.query.limit)  ?? 25, 1), 200);
        const offset = Math.max(toNum(req.query.offset) ?? 0, 0);

        const where  = [`c.tenant_id = $1`];
        const params = [tenantId];

        if (customerId) {
          params.push(customerId);
          where.push(`c.customer_id = $${params.length}`);
        }
        if (resourceId) {
          params.push(resourceId);
          where.push(`c.resource_id = $${params.length}`);
        }
        if (bookingId) {
          params.push(bookingId);
          where.push(`c.booking_id = $${params.length}`);
        }
        if (statusRaw) {
          // Comma-separated list support
          const statuses = statusRaw.split(',').map(s => s.trim()).filter(s => VALID_STATUSES.has(s));
          if (!statuses.length) {
            return res.status(400).json({ error: `status must be in ${[...VALID_STATUSES].join('|')}` });
          }
          params.push(statuses);
          where.push(`c.status = ANY($${params.length}::text[])`);
        }

        // Pagination params
        params.push(limit);  const lp = params.length;
        params.push(offset); const op = params.length;

        const { rows } = await db.query(
          `SELECT c.id, c.contract_number, c.customer_id, cu.name AS customer_name,
                  c.resource_id, r.name AS resource_name,
                  c.booking_id, c.start_date, c.end_date,
                  c.monthly_rate, c.total_value, c.security_deposit, c.currency_code,
                  c.status, c.signed_at, c.signed_by_name,
                  c.generated_pdf_url, c.signed_pdf_url,
                  c.payment_schedule_template_id,
                  c.auto_release_on_expiry,
                  c.created_at, c.updated_at
             FROM contracts c
             JOIN customers cu ON cu.id = c.customer_id
             JOIN resources r  ON r.id  = c.resource_id
            WHERE ${where.join(' AND ')}
            ORDER BY c.created_at DESC
            LIMIT $${lp} OFFSET $${op}`,
          params
        );

        // Total count for pagination
        const countRes = await db.query(
          `SELECT COUNT(*)::int AS total FROM contracts c WHERE ${where.join(' AND ')}`,
          params.slice(0, params.length - 2) // drop limit+offset
        );

        return res.json({
          contracts: rows,
          pagination: {
            limit, offset,
            total: countRes.rows[0].total,
            hasMore: offset + rows.length < countRes.rows[0].total,
          },
        });
      } catch (err) {
        logger.error({ err }, 'list contracts failed');
        return res.status(500).json({ error: 'Failed to load contracts' });
      }
    }
  );
};
