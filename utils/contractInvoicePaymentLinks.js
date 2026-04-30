'use strict';

// utils/contractInvoicePaymentLinks.js
// G2-PL-1: Token utility for contract_invoice_payment_links.
//
// Two infrastructure functions exposed in this patch:
//
//   getOrCreatePendingLink({ contractInvoiceId, expiresAt? })
//     The lifecycle workhorse. If the invoice already has a pending link,
//     returns it. Otherwise creates a new one. This is what the reminder
//     cron and the contract-sign hook will both call — they always get the
//     same token back across all reminders for the same invoice.
//
//   getLinkByToken(token)
//     Public-portal lookup. Returns the link joined with invoice + contract +
//     tenant context needed to render the pay page. Read-only; doesn't mutate
//     state.
//
// Routes that mutate state (mark-paid, cancel, expire-sweep) come in G2-PL-2.
//
// Tenant isolation: getLinkByToken returns the tenant_id in the result so
// callers can scope subsequent queries. getOrCreatePendingLink derives the
// tenant_id from the invoice itself (via INSERT ... SELECT) so it cannot be
// spoofed by the caller.

const db     = require('../db');
const logger = require('./logger');

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

// Days after invoice due_date that a generated link auto-expires by default.
// 90 days is generous enough to absorb late payments and rep-driven recovery
// flows. Caller can override via { expiresAt }.
const DEFAULT_EXPIRY_DAYS_AFTER_DUE = 90;

// ---------------------------------------------------------------------------
// getOrCreatePendingLink
// ---------------------------------------------------------------------------

/**
 * Get the existing pending payment link for a contract invoice, or create
 * one if none exists.
 *
 * Atomic via the partial unique index uq_cipl_pending_per_invoice — even
 * under concurrent calls (e.g. two reminder cron ticks racing), only one
 * pending row is ever created per invoice.
 *
 * @param {Object} args
 * @param {number} args.contractInvoiceId  contract_invoices.id
 * @param {Date|string|null} [args.expiresAt]  Override default expiry. Pass
 *   `null` explicitly to make the link non-expiring. Omit to use default
 *   (invoice.due_date + DEFAULT_EXPIRY_DAYS_AFTER_DUE).
 *
 * @returns {Promise<{
 *   id: number,
 *   tenant_id: number,
 *   contract_invoice_id: number,
 *   token: string,
 *   amount_requested: string,
 *   currency_code: string,
 *   status: 'pending',
 *   expires_at: Date|null,
 *   created_at: Date,
 *   wasExisting: boolean
 * }>}
 *
 * @throws {Error} if the invoice doesn't exist, is voided/cancelled, or
 *   already fully paid (in which case a payment link is meaningless).
 */
async function getOrCreatePendingLink({ contractInvoiceId, expiresAt } = {}) {
  if (!contractInvoiceId || !Number.isFinite(Number(contractInvoiceId))) {
    throw new Error('getOrCreatePendingLink: contractInvoiceId is required');
  }

  // 1. Look up the invoice. We need amount, currency, due_date, tenant_id,
  //    and current status to decide whether a link can be created.
  const invRes = await db.query(
    `SELECT id, tenant_id, amount, amount_paid, currency_code,
            status, due_date
     FROM contract_invoices
     WHERE id = $1`,
    [contractInvoiceId]
  );
  if (!invRes.rows.length) {
    throw new Error(`getOrCreatePendingLink: contract_invoice ${contractInvoiceId} not found`);
  }
  const inv = invRes.rows[0];

  if (inv.status === 'paid') {
    throw new Error(`getOrCreatePendingLink: invoice ${contractInvoiceId} is already paid`);
  }
  if (inv.status === 'void' || inv.status === 'cancelled') {
    throw new Error(`getOrCreatePendingLink: invoice ${contractInvoiceId} is ${inv.status}`);
  }

  // 2. If a pending link already exists, return it. (Cheap single-query path
  //    that avoids the INSERT round-trip for the hot reminder-reuse case.)
  const existing = await db.query(
    `SELECT id, tenant_id, contract_invoice_id, token,
            amount_requested, currency_code, status,
            expires_at, created_at
     FROM contract_invoice_payment_links
     WHERE contract_invoice_id = $1 AND status = 'pending'
     LIMIT 1`,
    [contractInvoiceId]
  );
  if (existing.rows.length) {
    return { ...existing.rows[0], wasExisting: true };
  }

  // 3. Resolve expiry. Three cases:
  //    - expiresAt undefined  → default: invoice.due_date + 90 days
  //    - expiresAt === null   → explicit non-expiring
  //    - expiresAt provided   → use as-is (Date or ISO string)
  let resolvedExpiresAt;
  if (typeof expiresAt === 'undefined') {
    if (inv.due_date) {
      const due = new Date(inv.due_date);
      due.setUTCDate(due.getUTCDate() + DEFAULT_EXPIRY_DAYS_AFTER_DUE);
      resolvedExpiresAt = due;
    } else {
      resolvedExpiresAt = null;
    }
  } else if (expiresAt === null) {
    resolvedExpiresAt = null;
  } else {
    resolvedExpiresAt = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
    if (Number.isNaN(resolvedExpiresAt.getTime())) {
      throw new Error('getOrCreatePendingLink: invalid expiresAt');
    }
  }

  // 4. Insert. Race-safe: if a concurrent caller inserted between step 2 and
  //    here, the partial unique index will reject our insert; we re-select
  //    and return the winning row.
  try {
    const ins = await db.query(
      `INSERT INTO contract_invoice_payment_links (
         tenant_id, contract_invoice_id,
         amount_requested, currency_code,
         expires_at
       )
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, tenant_id, contract_invoice_id, token,
                 amount_requested, currency_code, status,
                 expires_at, created_at`,
      [
        inv.tenant_id,
        contractInvoiceId,
        inv.amount,
        inv.currency_code,
        resolvedExpiresAt,
      ]
    );
    logger.info(
      {
        contractInvoiceId,
        tenantId: inv.tenant_id,
        linkId: ins.rows[0].id,
        amount: inv.amount,
        currency: inv.currency_code,
        expiresAt: resolvedExpiresAt,
      },
      'Contract invoice payment link created'
    );
    return { ...ins.rows[0], wasExisting: false };
  } catch (err) {
    // Postgres error 23505 = unique_violation. Means a concurrent caller
    // beat us to creating the pending link. Re-select and return.
    if (err && err.code === '23505') {
      const winner = await db.query(
        `SELECT id, tenant_id, contract_invoice_id, token,
                amount_requested, currency_code, status,
                expires_at, created_at
         FROM contract_invoice_payment_links
         WHERE contract_invoice_id = $1 AND status = 'pending'
         LIMIT 1`,
        [contractInvoiceId]
      );
      if (winner.rows.length) {
        return { ...winner.rows[0], wasExisting: true };
      }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// getLinkByToken
// ---------------------------------------------------------------------------

/**
 * Public-portal lookup. Resolves a token to the full context needed to
 * render the pay-invoice page: link state, invoice details, contract
 * details, tenant name + slug + branding signals.
 *
 * @param {string} token  The token from the URL path.
 *
 * @returns {Promise<Object|null>} Combined record, or null if token unknown.
 *
 * Returned shape (camelCase, public-safe — no internal IDs leaked beyond
 * what's needed for the pay page):
 *
 *   {
 *     // Link state
 *     token, status, amountRequested, currencyCode, expiresAt,
 *     createdAt, paidAt, cancelledAt, expiredAt,
 *
 *     // Invoice (current state — may differ from snapshot)
 *     invoice: {
 *       id, milestoneIndex, milestoneLabel,
 *       amount, amountPaid, outstanding,    // outstanding = amount - amountPaid
 *       status, dueDate
 *     },
 *
 *     // Contract context for display
 *     contract: {
 *       id, contractNumber, startDate, endDate, monthlyRate
 *     },
 *
 *     // Tenant context for branding
 *     tenant: {
 *       id, slug, name, timezone
 *     },
 *
 *     // Customer context (used to render greeting on pay page)
 *     customer: {
 *       id, name, phone
 *     }
 *   }
 *
 * Returns null when the token doesn't exist. Caller decides how to render
 * "expired" vs "cancelled" vs "paid" — all three are valid token states
 * that the page should handle gracefully (not 404).
 */
async function getLinkByToken(token) {
  if (!token || typeof token !== 'string') return null;

  const res = await db.query(
    `SELECT
       cipl.token,
       cipl.status                 AS link_status,
       cipl.amount_requested,
       cipl.currency_code          AS link_currency,
       cipl.expires_at,
       cipl.created_at             AS link_created_at,
       cipl.paid_at,
       cipl.cancelled_at,
       cipl.expired_at,

       ci.id                       AS invoice_id,
       ci.milestone_index,
       ci.milestone_label,
       ci.amount                   AS invoice_amount,
       ci.amount_paid              AS invoice_amount_paid,
       ci.status                   AS invoice_status,
       ci.due_date,

       c.id                        AS contract_id,
       c.contract_number,
       c.start_date                AS contract_start,
       c.end_date                  AS contract_end,
       c.monthly_rate,

       t.id                        AS tenant_id,
       t.slug                      AS tenant_slug,
       t.name                      AS tenant_name,
       t.timezone                  AS tenant_timezone,

       cu.id                       AS customer_id,
       cu.name                     AS customer_name,
       cu.phone                    AS customer_phone

     FROM contract_invoice_payment_links cipl
     INNER JOIN contract_invoices ci ON ci.id = cipl.contract_invoice_id
     INNER JOIN contracts         c  ON c.id  = ci.contract_id
     INNER JOIN tenants           t  ON t.id  = c.tenant_id
     INNER JOIN customers         cu ON cu.id = c.customer_id
     WHERE cipl.token = $1
     LIMIT 1`,
    [token]
  );

  if (!res.rows.length) return null;
  const r = res.rows[0];

  const amount     = Number(r.invoice_amount);
  const amountPaid = Number(r.invoice_amount_paid);
  const outstanding = Number.isFinite(amount) && Number.isFinite(amountPaid)
    ? Math.max(0, amount - amountPaid)
    : null;

  return {
    // Link state
    token:           r.token,
    status:          r.link_status,
    amountRequested: r.amount_requested,
    currencyCode:    r.link_currency,
    expiresAt:       r.expires_at,
    createdAt:       r.link_created_at,
    paidAt:          r.paid_at,
    cancelledAt:     r.cancelled_at,
    expiredAt:       r.expired_at,

    invoice: {
      id:             r.invoice_id,
      milestoneIndex: r.milestone_index,
      milestoneLabel: r.milestone_label,
      amount:         r.invoice_amount,
      amountPaid:     r.invoice_amount_paid,
      outstanding,
      status:         r.invoice_status,
      dueDate:        r.due_date,
    },

    contract: {
      id:             r.contract_id,
      contractNumber: r.contract_number,
      startDate:      r.contract_start,
      endDate:        r.contract_end,
      monthlyRate:    r.monthly_rate,
    },

    tenant: {
      id:       r.tenant_id,
      slug:     r.tenant_slug,
      name:     r.tenant_name,
      timezone: r.tenant_timezone,
    },

    customer: {
      id:    r.customer_id,
      name:  r.customer_name,
      phone: r.customer_phone,
    },
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  getOrCreatePendingLink,
  getLinkByToken,
  // Exposed for tests / future expiry sweep logic
  DEFAULT_EXPIRY_DAYS_AFTER_DUE,
};
