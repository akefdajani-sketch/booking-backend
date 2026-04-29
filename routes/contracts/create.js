'use strict';

// routes/contracts/create.js
// POST /api/contracts
// G2a-1: Create a contract (optionally applying a payment schedule template).

const { pool } = require('../../db');
const logger = require('../../utils/logger');
const requireAppAuth           = require('../../middleware/requireAppAuth');
const { requireTenant }        = require('../../middleware/requireTenant');
const requireAdminOrTenantRole = require('../../middleware/requireAdminOrTenantRole');

const {
  generateContractNumber,
  resolveContractPrefix,
  applyTemplate,
  insertContractInvoices,
  roundMinor,
  // CONTRACT-CALENDAR-1
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

        // ─── Parse + validate body ────────────────────────────────────────────
        const body = req.body || {};
        const customerId = toNum(body.customer_id ?? body.customerId);
        const resourceId = toNum(body.resource_id ?? body.resourceId);
        const bookingId  = toNum(body.booking_id ?? body.bookingId);
        const startDate  = toIsoDate(body.start_date ?? body.startDate);
        const endDate    = toIsoDate(body.end_date ?? body.endDate);
        const monthlyRate     = toNum(body.monthly_rate ?? body.monthlyRate);
        const totalValue      = toNum(body.total_value ?? body.totalValue);
        const securityDeposit = toNum(body.security_deposit ?? body.securityDeposit) ?? 0;
        const currencyCode    = String(body.currency_code ?? body.currencyCode ?? '').trim().toUpperCase();
        const templateId      = toNum(body.payment_schedule_template_id ?? body.templateId);
        const autoRelease     = body.auto_release_on_expiry === true;
        const notes           = body.notes != null ? String(body.notes) : null;
        const terms           = body.terms != null ? String(body.terms) : null;
        const signedByName    = body.signed_by_name != null ? String(body.signed_by_name) : null;

        // CONTRACT-FAST-CONFIRM-1: Allow caller to create a contract directly
        // in 'signed' state, skipping the pending_signature ceremony. Used
        // for trusted recurring clients (corporate accounts, frequent
        // partners). Only 'draft' (default) and 'signed' are accepted as
        // initial states — other lifecycle states (active, terminated, etc.)
        // remain reachable only via the update endpoint.
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
        if (!startDate || !endDate) {
          return res.status(400).json({ error: 'start_date and end_date required (YYYY-MM-DD)' });
        }
        if (new Date(endDate) <= new Date(startDate)) {
          return res.status(400).json({ error: 'end_date must be after start_date' });
        }
        if (monthlyRate == null || monthlyRate < 0) {
          return res.status(400).json({ error: 'monthly_rate required (non-negative)' });
        }
        if (totalValue == null || totalValue < 0) {
          return res.status(400).json({ error: 'total_value required (non-negative)' });
        }
        if (securityDeposit < 0) {
          return res.status(400).json({ error: 'security_deposit must be non-negative' });
        }
        if (!/^[A-Z]{3}$/.test(currencyCode)) {
          return res.status(400).json({ error: 'currency_code required (3-letter ISO)' });
        }

        // ─── Transaction ──────────────────────────────────────────────────────
        const client = await pool.connect();
        try {
          await client.query('BEGIN');

          // Load tenant (for prefix + isolation check)
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

          // Verify customer + resource belong to this tenant
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

          // Load + validate template (if provided). Platform templates (tenant_id IS NULL) allowed.
          let template = null;
          if (templateId) {
            const tplRow = await client.query(
              `SELECT id, tenant_id, name, milestones, stay_type_scope, active
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

          // Generate contract number (advisory-locked inside this tx)
          const prefix = resolveContractPrefix(tenant);
          const year = new Date(startDate).getUTCFullYear();
          const contractNumber = await generateContractNumber(client, {
            tenantId, tenantPrefix: prefix, year,
          });

          // Apply template (if any) to get payment_schedule_snapshot + invoice rows.
          // FAST-CONFIRM: when initial_status='signed' we pass signedAt so the
          // template's date triggers (e.g. "on_signing", "on_signing+30") resolve
          // to concrete dates. For 'draft' we pass null (matches prior behaviour).
          let snapshot = null;
          let invoiceRows = [];
          if (template) {
            const applied = applyTemplate({
              template,
              totalValue: roundMinor(totalValue),
              startDate, endDate,
              signedAt: initialStatus === 'signed' ? new Date() : null,
            });
            snapshot = applied.snapshot;
            invoiceRows = applied.invoiceRows;
          }

          // Insert contract.
          // FAST-CONFIRM: status, signed_at, signature_method are computed
          // from initial_status. We use $18/$19/$20 placeholders to keep the
          // shape uniform regardless of path.
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

          // ─── Fast-confirm side-effects (when initial_status='signed') ──
          // Mirror what update.js does for the pending_signature → signed
          // transition: emit invoices from the template, materialize the
          // phantom booking onto the calendar, sync resource lease fields.
          // All inside the same transaction — either everything commits or
          // nothing does.
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
          // For 'draft' contracts we deliberately do NOT create invoices yet
          // — they're emitted on the draft → signed (or pending_signature →
          // signed) transition. This keeps draft edits cheap; amounts/dates
          // can shift before signing without orphaning invoice rows.

          await client.query('COMMIT');

          logger.info({
            tenantId, contractId: contract.id, contractNumber,
            initialStatus, invoicesCreated,
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
        // Surface meaningful errors for known constraints
        if (err && err.code === '23P01') {
          // exclusion_violation — overlapping contract on same resource
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

// Expose insertContractInvoices for Session 2's sign flow (used when status → signed).
module.exports.signFlowHelpers = { insertContractInvoices };
