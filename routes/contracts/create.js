'use strict';

// routes/contracts/create.js
// POST /api/contracts
// G2a-1: Create a contract.
//
// FINAL-CONTRACT-FIX (this revision):
//   - Uses generateContractSchedule (unified generator) for fixed-duration
//     templates AND for None (no template). Long Stay (variable-duration,
//     duration_months IS NULL) keeps the legacy applyTemplate path.
//   - When a fixed-duration template is selected, end_date is recomputed
//     server-side from start_date + duration_months − 1 day, regardless of
//     what the client sends. Defense-in-depth — the modal does the same math
//     but the server is the source of truth.
//   - total_value is recomputed server-side from monthly_rate × actual
//     covered period (using the generator's own math). Prevents drift
//     between displayed total and billed schedule.
//   - Security deposit is generated as a separate is_deposit=TRUE invoice
//     (excluded from total_value).

const { pool } = require('../../db');
const logger = require('../../utils/logger');
const requireAppAuth           = require('../../middleware/requireAppAuth');
const { requireTenant }        = require('../../middleware/requireTenant');
const requireAdminOrTenantRole = require('../../middleware/requireAdminOrTenantRole');

const {
  generateContractNumber,
  resolveContractPrefix,
  applyTemplate,
  generateContractSchedule,
  computeFixedTermEndDate,
  computeTotalValueFromSchedule,
  insertContractInvoices,
  roundMinor,
  materializeContractBooking,
  syncResourceLeaseFromContract,
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

        const body = req.body || {};
        const customerId = toNum(body.customer_id ?? body.customerId);
        const resourceId = toNum(body.resource_id ?? body.resourceId);
        const bookingId  = toNum(body.booking_id ?? body.bookingId);
        const startDate  = toIsoDate(body.start_date ?? body.startDate);
        let   endDate    = toIsoDate(body.end_date ?? body.endDate);
        const monthlyRate     = toNum(body.monthly_rate ?? body.monthlyRate);
        let   totalValue      = toNum(body.total_value ?? body.totalValue);
        const securityDeposit = toNum(body.security_deposit ?? body.securityDeposit) ?? 0;
        const currencyCode    = String(body.currency_code ?? body.currencyCode ?? '').trim().toUpperCase();
        const templateId      = toNum(body.payment_schedule_template_id ?? body.templateId);
        const autoRelease     = body.auto_release_on_expiry === true;
        const notes           = body.notes != null ? String(body.notes) : null;
        const terms           = body.terms != null ? String(body.terms) : null;
        const signedByName    = body.signed_by_name != null ? String(body.signed_by_name) : null;

        const initialStatusRaw = body.initial_status ?? body.initialStatus ?? 'draft';
        const initialStatus    = String(initialStatusRaw).trim().toLowerCase();
        if (!['draft', 'signed'].includes(initialStatus)) {
          return res.status(400).json({
            error: "initial_status must be 'draft' or 'signed'",
          });
        }
        if (initialStatus === 'signed' && (!signedByName || !signedByName.trim())) {
          return res.status(400).json({
            error: "signed_by_name required when initial_status='signed'",
          });
        }

        if (!customerId) return res.status(400).json({ error: 'customer_id required' });
        if (!resourceId) return res.status(400).json({ error: 'resource_id required' });
        if (!startDate) {
          return res.status(400).json({ error: 'start_date required (YYYY-MM-DD)' });
        }
        // FINAL-CONTRACT-FIX: end_date validation happens here (BEFORE pool.connect)
        // for parity with the original code path. The test suite covers this:
        //   POST / rejects end_date <= start_date  →  400 with /end_date/ in error.
        // Inside the transaction we recompute end_date for fixed-duration templates
        // (template drives end_date from start_date + duration_months − 1), which
        // is always > start_date by construction, so no re-validation needed there.
        // If body omits end_date entirely, defer — a fixed-duration template may
        // be supplying it inside the transaction; the "no template + no end_date"
        // case is rejected inside the transaction with its own error message.
        if (endDate && new Date(endDate) <= new Date(startDate)) {
          return res.status(400).json({ error: 'end_date must be after start_date' });
        }
        if (monthlyRate == null || monthlyRate < 0) {
          return res.status(400).json({ error: 'monthly_rate required (non-negative)' });
        }
        if (securityDeposit < 0) {
          return res.status(400).json({ error: 'security_deposit must be non-negative' });
        }
        if (!/^[A-Z]{3}$/.test(currencyCode)) {
          return res.status(400).json({ error: 'currency_code required (3-letter ISO)' });
        }

        const client = await pool.connect();
        try {
          await client.query('BEGIN');

          const tRow = await client.query(
            `SELECT id, slug, contract_number_prefix, currency_code
               FROM tenants WHERE id = $1`,
            [tenantId]
          );
          if (!tRow.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Tenant not found' });
          }
          const tenant = tRow.rows[0];

          const checks = await client.query(
            `SELECT
               (SELECT id FROM customers WHERE id = $1 AND tenant_id = $3 AND deleted_at IS NULL) AS cust_id,
               (SELECT id FROM resources WHERE id = $2 AND tenant_id = $3) AS res_id`,
            [customerId, resourceId, tenantId]
          );
          if (!checks.rows[0].cust_id) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'customer_id not found for this tenant' });
          }
          if (!checks.rows[0].res_id) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'resource_id not found for this tenant' });
          }
          if (bookingId) {
            const b = await client.query(
              `SELECT id FROM bookings WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
              [bookingId, tenantId]
            );
            if (!b.rows.length) {
              await client.query('ROLLBACK');
              return res.status(400).json({ error: 'booking_id not found for this tenant' });
            }
          }

          // ─── Template lookup (if any) ─────────────────────────────────────
          let template = null;
          if (templateId) {
            const tplRow = await client.query(
              `SELECT id, tenant_id, name, milestones, stay_type_scope, active, duration_months
                 FROM payment_schedule_templates
                WHERE id = $1
                  AND active = TRUE
                  AND (tenant_id = $2 OR tenant_id IS NULL)`,
              [templateId, tenantId]
            );
            if (!tplRow.rows.length) {
              await client.query('ROLLBACK');
              return res.status(400).json({ error: 'payment_schedule_template_id not found or inactive' });
            }
            template = tplRow.rows[0];
          }

          // ─── FIXED-DURATION TEMPLATE PATH ────────────────────────────────
          //
          // Server is source of truth: when a fixed-duration template is
          // selected, end_date and total_value are recomputed regardless of
          // what the client sent. This prevents the schedule/duration
          // mismatch that produced the bad pre-fix contracts.

          const isFixedDurationTemplate = template && template.duration_months != null;
          const isVariableDurationTemplate = template && template.duration_months == null;

          if (isFixedDurationTemplate) {
            endDate = computeFixedTermEndDate(startDate, template.duration_months);
          } else if (!endDate) {
            // No template, no end date — required.
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'end_date required (YYYY-MM-DD)' });
          }

          if (new Date(endDate) <= new Date(startDate)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'end_date must be after start_date' });
          }

          // total_value: for fixed-duration templates AND for None, recompute
          // from the generator math. For variable-duration templates (Long
          // Stay), accept client-supplied total_value (legacy behaviour).
          if (!isVariableDurationTemplate) {
            totalValue = computeTotalValueFromSchedule({
              startDate, endDate, monthlyRate,
            });
          } else if (totalValue == null || totalValue < 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'total_value required for variable-duration templates' });
          }

          // ─── Generate schedule ────────────────────────────────────────────
          let snapshot = null;
          let invoiceRows = [];
          if (isVariableDurationTemplate) {
            // Long Stay 15-60 nights: legacy percentage-based path.
            const applied = applyTemplate({
              template,
              totalValue: roundMinor(totalValue),
              startDate, endDate,
              signedAt: initialStatus === 'signed' ? new Date() : null,
            });
            snapshot = applied.snapshot;
            invoiceRows = applied.invoiceRows;
          } else {
            // Fixed-duration template OR None: unified generator.
            const generated = generateContractSchedule({
              startDate, endDate, monthlyRate, securityDeposit,
            });
            snapshot = generated.snapshot;
            invoiceRows = generated.invoiceRows;
          }

          // ─── Generate contract number ────────────────────────────────────
          const prefix = resolveContractPrefix(tenant);
          const year = new Date(startDate).getUTCFullYear();
          const contractNumber = await generateContractNumber(client, {
            tenantId, tenantPrefix: prefix, year,
          });

          // ─── Insert contract row ─────────────────────────────────────────
          const signedAtSql       = initialStatus === 'signed' ? 'NOW()' : 'NULL';
          const signatureMethodVal = initialStatus === 'signed' ? 'manual' : null;
          const insertRes = await client.query(
            `INSERT INTO contracts (
               tenant_id, contract_number, customer_id, resource_id, booking_id,
               start_date, end_date,
               monthly_rate, total_value, security_deposit, currency_code,
               payment_schedule_template_id, payment_schedule_snapshot,
               status, auto_release_on_expiry,
               notes, terms, signed_by_name, created_by,
               signed_at, signature_method
             )
             VALUES (
               $1, $2, $3, $4, $5,
               $6, $7,
               $8, $9, $10, $11,
               $12, $13::jsonb,
               $14, $15,
               $16, $17, $18, NULL,
               ${signedAtSql}, $19
             )
             RETURNING *`,
            [
              tenantId, contractNumber, customerId, resourceId, bookingId,
              startDate, endDate,
              roundMinor(monthlyRate), roundMinor(totalValue), roundMinor(securityDeposit), currencyCode,
              templateId, snapshot ? JSON.stringify(snapshot) : null,
              initialStatus, autoRelease,
              notes, terms, signedByName,
              signatureMethodVal,
            ]
          );
          const contract = insertRes.rows[0];

          // ─── Fast-confirm side effects ────────────────────────────────────
          let invoicesCreated     = 0;
          let phantomBookingResult = null;
          let leaseSyncResult      = null;
          if (initialStatus === 'signed') {
            if (invoiceRows.length) {
              const newInvoiceIds = await insertContractInvoices(client, {
                tenantId,
                contractId: contract.id,
                currencyCode: contract.currency_code,
                invoiceRows,
              });
              invoicesCreated = newInvoiceIds.length;
            }
            phantomBookingResult = await materializeContractBooking(client, contract);
            leaseSyncResult      = await syncResourceLeaseFromContract(client, contract, 'apply');
          }

          await client.query('COMMIT');

          // ─── G2-PL-4: signing notification (non-fatal, post-commit) ───
          // Fires WA + SMS confirmation with the first invoice's payment
          // link. Wrapped in setImmediate so it doesn't block the response.
          if (initialStatus === 'signed' && invoicesCreated > 0) {
            setImmediate(async () => {
              try {
                const { sendContractSigningNotification } = require('../../utils/contractSigningNotification');
                await sendContractSigningNotification({
                  contractId: contract.id,
                  tenantId,
                });
              } catch (notifErr) {
                logger.error(
                  { err: notifErr.message, contractId: contract.id, tenantId },
                  'Contract signing notification error (non-fatal)'
                );
              }
            });
          }

          logger.info({
            tenantId, contractId: contract.id, contractNumber,
            initialStatus, invoicesCreated,
            templatePath: isFixedDurationTemplate ? 'fixed' : (isVariableDurationTemplate ? 'variable' : 'none'),
            phantomBooking: phantomBookingResult,
            leaseSync: leaseSyncResult,
          }, 'contract created');

          return res.status(201).json({
            contract: {
              id: contract.id,
              contract_number: contract.contract_number,
              status: contract.status,
              tenant_id: tenantId,
              customer_id: customerId,
              resource_id: resourceId,
              booking_id: contract.booking_id ?? bookingId,
              start_date: startDate,
              end_date: endDate,
              monthly_rate: roundMinor(monthlyRate),
              total_value: roundMinor(totalValue),
              security_deposit: roundMinor(securityDeposit),
              currency_code: currencyCode,
              payment_schedule_template_id: templateId,
              payment_schedule_snapshot: snapshot,
              auto_release_on_expiry: autoRelease,
              signed_at: contract.signed_at,
              signature_method: contract.signature_method,
              created_at: contract.created_at,
            },
            invoices_created: invoicesCreated,
            phantom_booking:  phantomBookingResult,
            lease_sync:       leaseSyncResult,
          });
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      } catch (err) {
        // CONTRACT-CONFLICT-DEFENSE-1: backend conflict check throws this when
        // the contract's date range overlaps an existing non-cancelled booking
        // on the same resource. Surface as 409 with the offending booking ids.
        if (err && err.code === 'CONTRACT_BOOKING_CONFLICT') {
          return res.status(409).json({
            error: 'Contract dates overlap existing booking(s) on this resource',
            conflictingBookingIds: err.conflictingBookingIds || [],
          });
        }
        if (err && err.code === '23P01') {
          return res.status(409).json({
            error: 'Resource already has an active/signed contract overlapping these dates',
          });
        }
        if (err && err.code === '23505' && /uq_contracts_number/.test(err.message || '')) {
          return res.status(409).json({
            error: 'Contract number collision. Retry.',
          });
        }
        logger.error({ err }, 'create contract failed');
        return res.status(500).json({ error: 'Failed to create contract' });
      }
    }
  );
};

module.exports.signFlowHelpers = { insertContractInvoices };
