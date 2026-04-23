'use strict';

// routes/contracts/pdf.js
// G2a-2: Generate unsigned contract PDF via pdfkit, store in R2.
//
// POST /api/contracts/:id/generate-pdf
// Requires: authenticated tenant user (req.user.tenant_id)
// Response: { ok: true, url, key, hash }
//
// Rules:
//   - Allowed for status = draft | pending_signature (overwrites previous PDF)
//   - Refused for status in (signed, active, completed, terminated, expired, cancelled)
//     because PDF is a legal artifact once signed.

const { pool } = require('../../db');
const logger = require('../../utils/logger');
const { generateContractPdf } = require('../../utils/contractPdf');
const { loadTenantTaxConfig } = require('../../utils/taxEngine');
const { deleteFromR2 } = require('../../utils/r2');

const ALLOWED_STATUSES = new Set(['draft', 'pending_signature']);

module.exports = function mount(router) {
  router.post('/:id/generate-pdf', async (req, res, next) => {
    const tenantId = Number(req.user && req.user.tenant_id);
    const contractId = Number(req.params.id);

    if (!tenantId) return res.status(401).json({ error: 'unauthorized' });
    if (!Number.isInteger(contractId) || contractId <= 0) {
      return res.status(400).json({ error: 'invalid contract id' });
    }

    try {
      // 1. Load contract (tenant-scoped)
      const { rows: contractRows } = await pool.query(
        `SELECT * FROM contracts WHERE id = $1 AND tenant_id = $2`,
        [contractId, tenantId]
      );
      if (contractRows.length === 0) {
        return res.status(404).json({ error: 'contract not found' });
      }
      const contract = contractRows[0];

      // 2. Gate: status must allow regeneration
      if (!ALLOWED_STATUSES.has(contract.status)) {
        return res.status(409).json({
          error: 'pdf_locked',
          message: `PDF cannot be regenerated when contract status is '${contract.status}'. Allowed only for draft or pending_signature.`,
        });
      }

      // 3. Load related entities (all tenant-scoped for safety)
      const [{ rows: tenantRows }, { rows: customerRows }, { rows: resourceRows }] = await Promise.all([
        pool.query(`SELECT * FROM tenants  WHERE id = $1`, [tenantId]),
        pool.query(`SELECT * FROM customers WHERE id = $1 AND tenant_id = $2`,
                   [contract.customer_id, tenantId]),
        pool.query(`SELECT * FROM resources WHERE id = $1 AND tenant_id = $2`,
                   [contract.resource_id, tenantId]),
      ]);

      if (tenantRows.length === 0)   return res.status(500).json({ error: 'tenant missing' });
      if (customerRows.length === 0) return res.status(422).json({ error: 'customer missing' });
      if (resourceRows.length === 0) return res.status(422).json({ error: 'resource missing' });

      const tenant   = tenantRows[0];
      const customer = customerRows[0];
      const resource = resourceRows[0];

      // 4. Build the "invoices" array for the PDF from the snapshot.
      //    For unsigned contracts, contract_invoices rows don't exist yet,
      //    so we explode the snapshot in-memory. Snapshot was computed at
      //    creation via utils/contracts.applyTemplate().
      const snapshot = contract.payment_schedule_snapshot || [];
      const invoicesForPdf = Array.isArray(snapshot)
        ? snapshot.map((m, i) => ({
            milestone_index: i,
            milestone_label: m.label,
            label:           m.label,
            amount:          m.amount,
            due_date:        m.due_date || null,
          }))
        : [];

      // 5. Load tax config for VAT footnote
      const taxConfig = await loadTenantTaxConfig(tenantId);

      // 6. Generate + upload
      const { url, key, hash } = await generateContractPdf({
        contract, tenant, customer, resource, taxConfig,
        invoices: invoicesForPdf,
        language: 'en',
      });

      // 7. Delete the previous PDF from R2 if one existed (fire-and-forget)
      const previousKey = contract.generated_pdf_key;
      if (previousKey && previousKey !== key) {
        deleteFromR2(previousKey).catch((err) => {
          logger.warn({ tenantId, contractId, previousKey, err: err && err.message },
                      'failed to delete previous contract PDF from R2');
        });
      }

      // 8. Persist on contract
      await pool.query(
        `UPDATE contracts
            SET generated_pdf_url  = $1,
                generated_pdf_key  = $2,
                generated_pdf_hash = $3,
                updated_at         = NOW()
          WHERE id = $4 AND tenant_id = $5`,
        [url, key, hash, contractId, tenantId]
      );

      return res.json({ ok: true, url, key, hash });
    } catch (err) {
      logger.error({ tenantId, contractId, err: err && err.message, stack: err && err.stack },
                   'generate-pdf failed');
      return next(err);
    }
  });
};
