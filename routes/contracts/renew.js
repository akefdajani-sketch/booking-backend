'use strict';

// routes/contracts/renew.js
// G2a-S3d: POST /api/contracts/:id/renew
//
// Create a new contract copied from an existing one, with new dates and
// optionally a new monthly rate. The new contract:
//   - is always status='draft'
//   - links to the parent via parent_contract_id
//   - re-applies the same payment schedule template (or a new one if
//     specified) to compute a fresh milestone snapshot
//   - starts with fresh contract_number (per-tenant sequence)
//   - inherits customer, resource, security_deposit, currency, terms
//     unless overridden in the request body
//
// Request body (all optional except start_date + end_date):
//   {
//     "start_date": "2027-05-01",
//     "end_date":   "2028-05-01",
//     "monthly_rate": 550,                  // else inherits from parent
//     "total_value":  6600,                  // else inherits from parent (or recomputes if rate changed)
//     "payment_schedule_template_id": 42,   // else inherits parent's template
//     "terms":           "Updated terms",    // else inherits
//     "notes":           "Renewal of #N",
//     "security_deposit": 500                // else inherits
//   }
//
// Response:
//   { contract: <new contract row>, parent_id: <parent id> }
//
// Rules:
//   - Parent must belong to the same tenant.
//   - start_date must be > parent.end_date (renewal must follow original).
//   - end_date > start_date.
//   - Does NOT touch the parent's status; tenant can separately move parent
//     to 'completed' via PATCH /api/contracts/:id once renewal is signed.

const { pool } = require('../../db');
const logger = require('../../utils/logger');
const requireAppAuth           = require('../../middleware/requireAppAuth');
const { requireTenant }        = require('../../middleware/requireTenant');
const requireAdminOrTenantRole = require('../../middleware/requireAdminOrTenantRole');

const {
  generateContractNumber,
  resolveContractPrefix,
  applyTemplate,
  roundMinor,
} = require('../../utils/contracts');

function toNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toIsoDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

module.exports = function mount(router) {
  router.post(
    '/:id/renew',
    requireAppAuth,
    requireTenant,
    requireAdminOrTenantRole('staff'),
    async (req, res) => {
      const tenantId = Number(req.tenantId);
      const parentId = Number(req.params.id);

      if (!Number.isFinite(tenantId) || tenantId <= 0) {
        return res.status(400).json({ error: 'Invalid tenant.' });
      }
      if (!Number.isFinite(parentId) || parentId <= 0) {
        return res.status(400).json({ error: 'Invalid contract id.' });
      }

      const body = req.body || {};
      const newStart = toIsoDate(body.start_date ?? body.startDate);
      const newEnd   = toIsoDate(body.end_date   ?? body.endDate);
      if (!newStart || !newEnd) {
        return res.status(400).json({ error: 'start_date and end_date required (YYYY-MM-DD)' });
      }
      if (new Date(newEnd) <= new Date(newStart)) {
        return res.status(400).json({ error: 'end_date must be after start_date' });
      }

      const overrides = {
        monthly_rate:     toNum(body.monthly_rate ?? body.monthlyRate),
        total_value:      toNum(body.total_value  ?? body.totalValue),
        security_deposit: toNum(body.security_deposit ?? body.securityDeposit),
        templateId:       toNum(body.payment_schedule_template_id ?? body.templateId),
        terms:            body.terms != null ? String(body.terms) : undefined,
        notes:            body.notes != null ? String(body.notes) : undefined,
      };

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // ─── Load parent ───────────────────────────────────────────────────
        const parentSql = `SELECT * FROM contracts WHERE id = $1 AND tenant_id = $2`;
        const { rows: parentRows } = await client.query(parentSql, [parentId, tenantId]);
        if (parentRows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Parent contract not found' });
        }
        const parent = parentRows[0];

        // ─── Sanity: renewal must start strictly after parent's end_date ───
        if (parent.end_date && new Date(newStart) <= new Date(parent.end_date)) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: 'Renewal start_date must be after the parent contract\'s end_date',
            parent_end_date: parent.end_date,
          });
        }

        // ─── Load tenant + template ────────────────────────────────────────
        const { rows: tenantRows } = await client.query(
          `SELECT * FROM tenants WHERE id = $1`, [tenantId]
        );
        if (tenantRows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(500).json({ error: 'Tenant not found' });
        }
        const tenant = tenantRows[0];

        // Resolve effective values (override → parent)
        const effectiveTemplateId = overrides.templateId != null
          ? overrides.templateId
          : parent.payment_schedule_template_id;

        let template = null;
        if (effectiveTemplateId != null) {
          const { rows: tmplRows } = await client.query(
            `SELECT * FROM payment_schedule_templates
              WHERE id = $1
                AND (tenant_id = $2 OR tenant_id IS NULL)
                AND COALESCE(active, TRUE) = TRUE`,
            [effectiveTemplateId, tenantId]
          );
          if (tmplRows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Payment schedule template not found or inactive' });
          }
          template = tmplRows[0];
          // milestones may come back as JSON-string or JSONB — normalize
          if (typeof template.milestones === 'string') {
            try { template.milestones = JSON.parse(template.milestones); }
            catch { /* leave as-is to trigger applyTemplate error */ }
          }
        }

        const monthlyRate = overrides.monthly_rate != null
          ? overrides.monthly_rate
          : Number(parent.monthly_rate);

        // totalValue defaults: explicit override > recompute from new rate × new duration
        // > fall back to parent's total_value (unusual but possible).
        let totalValue = overrides.total_value;
        if (totalValue == null) {
          const months = monthsBetween(newStart, newEnd);
          if (Number.isFinite(monthlyRate) && monthlyRate > 0 && months > 0) {
            totalValue = roundMinor(monthlyRate * months);
          } else {
            totalValue = Number(parent.total_value);
          }
        }

        const securityDeposit = overrides.security_deposit != null
          ? overrides.security_deposit
          : Number(parent.security_deposit ?? 0);

        const newTerms = overrides.terms !== undefined
          ? overrides.terms
          : parent.terms;
        const newNotes = overrides.notes !== undefined
          ? overrides.notes
          : `Renewal of ${parent.contract_number}`;

        // ─── Apply template to compute new snapshot ────────────────────────
        let snapshot = null;
        if (template) {
          const applied = applyTemplate({
            template,
            totalValue,
            startDate: newStart,
            endDate:   newEnd,
            signedAt:  null, // not yet signed
          });
          snapshot = applied.snapshot;
        }

        // ─── Generate new contract number ──────────────────────────────────
        const prefix = resolveContractPrefix(tenant);
        const contractNumber = await generateContractNumber({
          client,
          tenantId,
          prefix,
          year: new Date(newStart).getUTCFullYear(),
        });

        // ─── Insert new contract ───────────────────────────────────────────
        const insertSql = `
          INSERT INTO contracts (
            tenant_id, contract_number, parent_contract_id,
            customer_id, resource_id, booking_id,
            start_date, end_date,
            monthly_rate, total_value, security_deposit, currency_code,
            status, payment_schedule_template_id, payment_schedule_snapshot,
            auto_release_on_expiry, terms, notes,
            created_at, updated_at
          ) VALUES (
            $1, $2, $3,
            $4, $5, NULL,
            $6, $7,
            $8, $9, $10, $11,
            'draft', $12, $13,
            $14, $15, $16,
            NOW(), NOW()
          )
          RETURNING *
        `;
        const { rows: insertedRows } = await client.query(insertSql, [
          tenantId, contractNumber, parentId,
          parent.customer_id, parent.resource_id,
          newStart, newEnd,
          monthlyRate, totalValue, securityDeposit, parent.currency_code,
          effectiveTemplateId, snapshot ? JSON.stringify(snapshot) : null,
          parent.auto_release_on_expiry ?? false,
          newTerms,
          newNotes,
        ]);
        const newContract = insertedRows[0];

        await client.query('COMMIT');

        logger.info({
          tenantId, parentId, newContractId: newContract.id,
          newContractNumber: contractNumber,
        }, 'contract renewed');

        return res.status(201).json({
          contract: newContract,
          parent_id: parentId,
        });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        // Exclusion constraint (overlapping signed/active on same resource)
        // does NOT fire on draft status, so no special-casing 23P01 here.
        logger.error({
          tenantId, parentId, err: err && err.message, stack: err && err.stack,
        }, 'contract renewal failed');
        return res.status(500).json({
          error: 'Contract renewal failed',
          message: err && err.message,
        });
      } finally {
        client.release();
      }
    }
  );
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function monthsBetween(startStr, endStr) {
  const s = new Date(startStr);
  const e = new Date(endStr);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return 0;
  const years = e.getUTCFullYear() - s.getUTCFullYear();
  const months = e.getUTCMonth() - s.getUTCMonth();
  const days = e.getUTCDate() - s.getUTCDate();
  return years * 12 + months + days / 30;
}
