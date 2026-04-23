'use strict';

// routes/contracts/update.js
// PATCH /api/contracts/:id
// G2a-1: Update a contract — field edits (draft only) or status transitions.
//
// Allowed transitions (guarded):
//   draft              → pending_signature | cancelled
//   pending_signature  → signed | cancelled
//   signed             → active | terminated
//   active             → completed | terminated | expired
//   completed|terminated|expired|cancelled → (terminal, no transitions out)
//
// When transitioning to 'signed':
//   - sets signed_at = NOW() if not provided
//   - requires signed_by_name (unless signature_method='dropbox_sign' later in G2b)
//   - creates contract_invoices rows from payment_schedule_snapshot (if set)
//
// Field edits (name, dates, amounts, notes, terms, template, PDF URLs):
//   - draft: all editable
//   - pending_signature: only PDF fields + notes editable
//   - signed+: only notes + terminated_reason + signed PDF URL (scan upload) editable

const { pool } = require('../../db');
const logger = require('../../utils/logger');
const requireAppAuth           = require('../../middleware/requireAppAuth');
const { requireTenant }        = require('../../middleware/requireTenant');
const requireAdminOrTenantRole = require('../../middleware/requireAdminOrTenantRole');

const { applyTemplate, roundMinor, insertContractInvoices } = require('../../utils/contracts');

// Allowed transitions
const TRANSITIONS = {
  draft:             new Set(['pending_signature', 'cancelled']),
  pending_signature: new Set(['signed', 'cancelled']),
  signed:            new Set(['active', 'terminated']),
  active:            new Set(['completed', 'terminated', 'expired']),
  completed:         new Set(),
  terminated:        new Set(),
  expired:           new Set(),
  cancelled:         new Set(),
};

function toNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = function mount(router) {
  router.patch(
    '/:id',
    requireAppAuth,
    requireTenant,
    requireAdminOrTenantRole('staff'),
    async (req, res) => {
      const tenantId = Number(req.tenantId);
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid id' });
      }
      if (!Number.isFinite(tenantId) || tenantId <= 0) {
        return res.status(400).json({ error: 'Invalid tenant.' });
      }

      const body = req.body || {};
      const requestedStatus = body.status ? String(body.status).trim() : null;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const existing = await client.query(
          `SELECT * FROM contracts WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
          [id, tenantId]
        );
        if (!existing.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Contract not found' });
        }
        const current = existing.rows[0];

        // ─── Status transition ────────────────────────────────────────────
        let nextStatus = current.status;
        if (requestedStatus && requestedStatus !== current.status) {
          const allowed = TRANSITIONS[current.status] || new Set();
          if (!allowed.has(requestedStatus)) {
            await client.query('ROLLBACK');
            return res.status(400).json({
              error: `Cannot transition from '${current.status}' to '${requestedStatus}'`,
            });
          }
          nextStatus = requestedStatus;
        }

        // ─── Field editability gates ──────────────────────────────────────
        const editsAllowed = {
          draft:              new Set(['customer_id','resource_id','booking_id','start_date','end_date',
                                       'monthly_rate','total_value','security_deposit','currency_code',
                                       'payment_schedule_template_id','auto_release_on_expiry',
                                       'notes','terms','signed_by_name','signature_method',
                                       'generated_pdf_url','generated_pdf_key','generated_pdf_hash']),
          pending_signature:  new Set(['notes','signed_by_name','signature_method',
                                       'generated_pdf_url','generated_pdf_key','generated_pdf_hash']),
          signed:             new Set(['notes','signed_pdf_url','signed_pdf_key','terminated_reason']),
          active:             new Set(['notes','terminated_reason']),
          completed:          new Set(['notes']),
          terminated:         new Set(['notes']),
          expired:            new Set(['notes']),
          cancelled:          new Set(['notes']),
        };
        const editable = editsAllowed[current.status] || new Set();

        const updates = [];
        const params  = [];
        let p = 0;

        const fieldMap = [
          ['customer_id',        body.customer_id ?? body.customerId,        'number'],
          ['resource_id',        body.resource_id ?? body.resourceId,        'number'],
          ['booking_id',         body.booking_id ?? body.bookingId,          'number-or-null'],
          ['start_date',         body.start_date ?? body.startDate,          'date'],
          ['end_date',           body.end_date ?? body.endDate,              'date'],
          ['monthly_rate',       body.monthly_rate ?? body.monthlyRate,      'money'],
          ['total_value',        body.total_value ?? body.totalValue,        'money'],
          ['security_deposit',   body.security_deposit ?? body.securityDeposit, 'money'],
          ['currency_code',      body.currency_code ?? body.currencyCode,    'text-upper'],
          ['payment_schedule_template_id', body.payment_schedule_template_id ?? body.templateId, 'number-or-null'],
          ['auto_release_on_expiry', body.auto_release_on_expiry, 'bool'],
          ['notes',              body.notes,                                  'text'],
          ['terms',              body.terms,                                  'text'],
          ['signed_by_name',     body.signed_by_name ?? body.signedByName,   'text'],
          ['signature_method',   body.signature_method ?? body.signatureMethod, 'text'],
          ['generated_pdf_url',  body.generated_pdf_url,                      'text'],
          ['generated_pdf_key',  body.generated_pdf_key,                      'text'],
          ['generated_pdf_hash', body.generated_pdf_hash,                     'text'],
          ['signed_pdf_url',     body.signed_pdf_url,                         'text'],
          ['signed_pdf_key',     body.signed_pdf_key,                         'text'],
          ['terminated_reason',  body.terminated_reason,                      'text'],
        ];

        for (const [col, rawVal, kind] of fieldMap) {
          if (rawVal === undefined) continue;
          if (!editable.has(col)) {
            await client.query('ROLLBACK');
            return res.status(400).json({
              error: `Cannot edit '${col}' while status is '${current.status}'`,
            });
          }
          let val;
          switch (kind) {
            case 'number':
              val = toNum(rawVal);
              if (val == null) { await client.query('ROLLBACK'); return res.status(400).json({ error: `${col} must be a number` }); }
              break;
            case 'number-or-null':
              val = rawVal === null ? null : toNum(rawVal);
              if (rawVal !== null && val == null) { await client.query('ROLLBACK'); return res.status(400).json({ error: `${col} must be a number or null` }); }
              break;
            case 'money':
              val = toNum(rawVal);
              if (val == null || val < 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: `${col} must be a non-negative number` }); }
              val = roundMinor(val);
              break;
            case 'date':
              val = String(rawVal).trim();
              if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) { await client.query('ROLLBACK'); return res.status(400).json({ error: `${col} must be YYYY-MM-DD` }); }
              break;
            case 'text-upper':
              val = String(rawVal).trim().toUpperCase();
              if (col === 'currency_code' && !/^[A-Z]{3}$/.test(val)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'currency_code must be 3-letter ISO' }); }
              break;
            case 'bool':
              val = rawVal === true || rawVal === 'true';
              break;
            case 'text':
            default:
              val = rawVal == null ? null : String(rawVal);
          }
          params.push(val); p++;
          updates.push(`${col} = $${p}`);
        }

        // ─── Status-transition side effects ───────────────────────────────
        let newInvoiceIds = [];
        if (nextStatus !== current.status) {
          updates.push(`status = '${nextStatus}'`); // value validated above

          if (nextStatus === 'signed') {
            // Require signed_by_name to be set (either in this body or already)
            const effectiveSignedByName =
              (body.signed_by_name ?? body.signedByName ?? current.signed_by_name ?? '').toString().trim();
            if (!effectiveSignedByName) {
              await client.query('ROLLBACK');
              return res.status(400).json({ error: 'signed_by_name required when transitioning to signed' });
            }
            // Set signed_at if not already set
            if (!current.signed_at && !body.signed_at) {
              updates.push(`signed_at = NOW()`);
            }
            // Default signature_method to 'manual' if nothing set
            if (!current.signature_method && !body.signature_method) {
              updates.push(`signature_method = 'manual'`);
            }
          }

          if (nextStatus === 'terminated') {
            updates.push(`terminated_at = COALESCE(terminated_at, NOW())`);
          }
          if (nextStatus === 'expired') {
            // no timestamp column; use updated_at to mark change
          }
          if (nextStatus === 'cancelled') {
            // no specific column; updated_at suffices
          }
        }

        if (!updates.length && nextStatus === current.status) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'No fields to update' });
        }

        updates.push(`updated_at = NOW()`);
        params.push(id); p++;
        params.push(tenantId); p++;

        const { rows } = await client.query(
          `UPDATE contracts
              SET ${updates.join(', ')}
            WHERE id = $${p - 1} AND tenant_id = $${p}
            RETURNING *`,
          params
        );
        if (!rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Contract not found' });
        }
        const updated = rows[0];

        // ─── On sign: explode snapshot into contract_invoices ─────────────
        if (nextStatus === 'signed' && current.status !== 'signed') {
          if (updated.payment_schedule_snapshot && Array.isArray(updated.payment_schedule_snapshot)) {
            // Existing snapshot is reused as-is (amounts + due_dates already computed).
            // If snapshot is absent, we re-derive from the template using current dates/total.
            const invoiceRows = updated.payment_schedule_snapshot.map(s => ({
              milestone_index: s.milestone_index,
              milestone_label: s.label,
              amount: s.amount,
              due_date: s.due_date,
            }));
            newInvoiceIds = await insertContractInvoices(client, {
              tenantId,
              contractId: updated.id,
              currencyCode: updated.currency_code,
              invoiceRows,
            });
          } else if (updated.payment_schedule_template_id) {
            // Re-derive — happens if contract was created without applying template early
            const tpl = await client.query(
              `SELECT id, milestones FROM payment_schedule_templates WHERE id = $1 AND active = TRUE`,
              [updated.payment_schedule_template_id]
            );
            if (tpl.rows.length) {
              const applied = applyTemplate({
                template: tpl.rows[0],
                totalValue: Number(updated.total_value),
                startDate: updated.start_date,
                endDate: updated.end_date,
                signedAt: new Date(),
              });
              await client.query(
                `UPDATE contracts SET payment_schedule_snapshot = $1::jsonb WHERE id = $2`,
                [JSON.stringify(applied.snapshot), updated.id]
              );
              newInvoiceIds = await insertContractInvoices(client, {
                tenantId,
                contractId: updated.id,
                currencyCode: updated.currency_code,
                invoiceRows: applied.invoiceRows,
              });
            }
          }
        }

        await client.query('COMMIT');

        logger.info({
          tenantId, contractId: id,
          fromStatus: current.status, toStatus: nextStatus,
          invoicesCreated: newInvoiceIds.length,
        }, 'contract updated');

        return res.json({
          contract: updated,
          invoices_created: newInvoiceIds.length,
        });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (err && err.code === '23P01') {
          return res.status(409).json({
            error: 'Resource already has an active/signed contract overlapping these dates',
          });
        }
        logger.error({ err }, 'update contract failed');
        return res.status(500).json({ error: 'Failed to update contract' });
      } finally {
        client.release();
      }
    }
  );
};
