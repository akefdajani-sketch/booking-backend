'use strict';

// routes/contracts/update.js
// PATCH /api/contracts/:id
// G2a-1: Update a contract — field edits (draft only) or status transitions.
//
// FINAL-CONTRACT-FIX (this revision):
//   - TRANSITIONS table expanded: signed → cancelled is now allowed. The
//     existing TERMINAL_STATES branch handles calendar release on cancel.
//     This eliminates the 400 the frontend was hitting when operators tried
//     to cancel a signed contract.
//   - On any transition INTO signed, schedule is regenerated via
//     generateContractSchedule for fixed-duration templates / None. Long
//     Stay (variable-duration) keeps the percentage-based applyTemplate.
//
// Allowed transitions (guarded):
//   draft              → pending_signature | signed | cancelled
//   pending_signature  → signed | cancelled
//   signed             → active | terminated | cancelled   ← cancelled added
//   active             → completed | terminated | expired
//   completed|terminated|expired|cancelled → terminal

const { pool } = require('../../db');
const logger = require('../../utils/logger');
const requireAppAuth           = require('../../middleware/requireAppAuth');
const { requireTenant }        = require('../../middleware/requireTenant');
const requireAdminOrTenantRole = require('../../middleware/requireAdminOrTenantRole');

const {
  applyTemplate,
  generateContractSchedule,
  computeFixedTermEndDate,
  computeTotalValueFromSchedule,
  roundMinor,
  insertContractInvoices,
  materializeContractBooking,
  cancelContractBooking,
  syncResourceLeaseFromContract,
} = require('../../utils/contracts');

const TRANSITIONS = {
  draft:             new Set(['pending_signature', 'signed', 'cancelled']),
  pending_signature: new Set(['signed', 'cancelled']),
  // FINAL-CONTRACT-FIX: 'cancelled' added. Calendar release handled below
  // via TERMINAL_STATES branch (existing code path).
  signed:            new Set(['active', 'terminated', 'cancelled']),
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

        let newInvoiceIds = [];
        if (nextStatus !== current.status) {
          updates.push(`status = '${nextStatus}'`);

          if (nextStatus === 'signed') {
            const effectiveSignedByName =
              (body.signed_by_name ?? body.signedByName ?? current.signed_by_name ?? '').toString().trim();
            if (!effectiveSignedByName) {
              await client.query('ROLLBACK');
              return res.status(400).json({ error: 'signed_by_name required when transitioning to signed' });
            }
            if (!current.signed_at && !body.signed_at) {
              updates.push(`signed_at = NOW()`);
            }
            if (!current.signature_method && !body.signature_method) {
              updates.push(`signature_method = 'manual'`);
            }
          }

          if (nextStatus === 'terminated') {
            updates.push(`terminated_at = COALESCE(terminated_at, NOW())`);
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

        // ─── On sign: regenerate schedule and emit invoices ───────────────
        //
        // FINAL-CONTRACT-FIX: when transitioning into signed, we ALWAYS
        // regenerate the schedule from the current contract dates/rate via
        // the appropriate generator. Reasons:
        //   - Drafts may have been edited (dates/rate/template changed) since
        //     the snapshot was first written.
        //   - The legacy snapshot from pre-fix bad contracts (extra invoices
        //     past end_date) gets corrected in place.
        //   - Variable-duration templates (Long Stay) keep using applyTemplate
        //     for backward compatibility.

        if (nextStatus === 'signed' && current.status !== 'signed') {
          let template = null;
          if (updated.payment_schedule_template_id) {
            const tpl = await client.query(
              `SELECT id, milestones, duration_months FROM payment_schedule_templates
                WHERE id = $1 AND active = TRUE`,
              [updated.payment_schedule_template_id]
            );
            if (tpl.rows.length) template = tpl.rows[0];
          }

          const isVariableDurationTemplate =
            template && template.duration_months == null && Array.isArray(template.milestones) && template.milestones.length > 0;

          let invoiceRows = [];
          let snapshot = null;

          if (isVariableDurationTemplate) {
            const applied = applyTemplate({
              template,
              totalValue: Number(updated.total_value),
              startDate: updated.start_date,
              endDate: updated.end_date,
              signedAt: new Date(),
            });
            snapshot = applied.snapshot;
            invoiceRows = applied.invoiceRows;
          } else {
            // Fixed-duration template OR None: unified generator.
            const generated = generateContractSchedule({
              startDate: updated.start_date instanceof Date
                ? updated.start_date.toISOString().slice(0, 10)
                : String(updated.start_date).slice(0, 10),
              endDate: updated.end_date instanceof Date
                ? updated.end_date.toISOString().slice(0, 10)
                : String(updated.end_date).slice(0, 10),
              monthlyRate: Number(updated.monthly_rate) || 0,
              securityDeposit: Number(updated.security_deposit) || 0,
            });
            snapshot = generated.snapshot;
            invoiceRows = generated.invoiceRows;
          }

          // Persist the regenerated snapshot.
          await client.query(
            `UPDATE contracts SET payment_schedule_snapshot = $1::jsonb WHERE id = $2`,
            [JSON.stringify(snapshot), updated.id]
          );

          if (invoiceRows.length) {
            newInvoiceIds = await insertContractInvoices(client, {
              tenantId,
              contractId: updated.id,
              currencyCode: updated.currency_code,
              invoiceRows,
            });
          }
        }

        // ─── CONTRACT-CALENDAR-1: phantom + lease sync (unchanged) ────────
        let phantomBookingResult = null;
        let leaseSyncResult      = null;
        if (nextStatus === 'signed' && current.status !== 'signed') {
          phantomBookingResult = await materializeContractBooking(client, updated);
          leaseSyncResult      = await syncResourceLeaseFromContract(client, updated, 'apply');

          const refetch = await client.query(
            `SELECT * FROM contracts WHERE id = $1 AND tenant_id = $2`,
            [updated.id, tenantId]
          );
          if (refetch.rows.length) Object.assign(updated, refetch.rows[0]);
        }

        // FINAL-CONTRACT-FIX: 'cancelled' is now in the terminal set for
        // contracts coming from 'signed' (the new TRANSITIONS allowance).
        // Lease release + phantom booking soft-delete already handled here.
        const TERMINAL_STATES = new Set(['terminated', 'cancelled', 'expired', 'completed']);
        const wasSignedOrActive = current.status === 'signed' || current.status === 'active';
        if (wasSignedOrActive && TERMINAL_STATES.has(nextStatus)) {
          phantomBookingResult = await cancelContractBooking(client, updated);
          leaseSyncResult      = await syncResourceLeaseFromContract(client, updated, 'release');
        }

        await client.query('COMMIT');

        logger.info({
          tenantId, contractId: id,
          fromStatus: current.status, toStatus: nextStatus,
          invoicesCreated: newInvoiceIds.length,
          phantomBooking: phantomBookingResult,
          leaseSync: leaseSyncResult,
        }, 'contract updated');

        return res.json({
          contract: updated,
          invoices_created: newInvoiceIds.length,
          phantom_booking: phantomBookingResult,
          lease_sync: leaseSyncResult,
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
