'use strict';

// routes/contracts/get.js
// GET /api/contracts/:id
// G2a-1: Return single contract with linked invoices and resource/customer summary.

const { pool } = require('../../db');
const db = pool;
const logger = require('../../utils/logger');
const requireAppAuth           = require('../../middleware/requireAppAuth');
const { requireTenant }        = require('../../middleware/requireTenant');
const requireAdminOrTenantRole = require('../../middleware/requireAdminOrTenantRole');

module.exports = function mount(router) {
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

        const contractRes = await db.query(
          `SELECT c.*,
                  cu.name  AS customer_name,
                  cu.email AS customer_email,
                  cu.phone AS customer_phone,
                  r.name   AS resource_name
             FROM contracts c
             JOIN customers cu ON cu.id = c.customer_id
             JOIN resources r  ON r.id  = c.resource_id
            WHERE c.id = $1 AND c.tenant_id = $2`,
          [id, tenantId]
        );
        if (!contractRes.rows.length) return res.status(404).json({ error: 'Contract not found' });

        const contract = contractRes.rows[0];

        // Invoices for this contract (if any exist — they're created at sign time)
        const invoicesRes = await db.query(
          `SELECT id, milestone_index, milestone_label,
                  amount, amount_paid, currency_code,
                  status, due_date, issued_at, paid_at, voided_at, cancelled_at,
                  stripe_invoice_id, payment_method, payment_ref, payment_notes,
                  created_at, updated_at
             FROM contract_invoices
            WHERE contract_id = $1 AND tenant_id = $2
            ORDER BY milestone_index ASC`,
          [id, tenantId]
        );

        return res.json({
          contract,
          invoices: invoicesRes.rows,
        });
      } catch (err) {
        logger.error({ err }, 'get contract failed');
        return res.status(500).json({ error: 'Failed to load contract' });
      }
    }
  );
};
