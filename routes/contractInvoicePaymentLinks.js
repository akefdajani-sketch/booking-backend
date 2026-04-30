'use strict';

// routes/contractInvoicePaymentLinks.js
// ---------------------------------------------------------------------------
// G2-PL-2: Payment link system for long-term contract invoices.
//
// Mirrors routes/rentalPaymentLinks.js (the proven short-term booking flow)
// but bound to contract_invoices instead of bookings. Public-facing token
// resolves to a pay page; mark-paid endpoints update BOTH the link AND the
// underlying contract_invoice row (the invoice is the source of truth for
// payment metadata; this table only tracks URL-token state).
//
// Mount in app.js:
//   app.use('/api/contract-invoice-payment-links', require('./routes/contractInvoicePaymentLinks'));
//
// OWNER endpoints (require tenant auth):
//   POST   /api/contract-invoice-payment-links           — create a link for an invoice
//   GET    /api/contract-invoice-payment-links           — list all links for a tenant (filter by contractInvoiceId, status)
//   GET    /api/contract-invoice-payment-links/:id       — get one link
//   PATCH  /api/contract-invoice-payment-links/:id       — cancel a link
//   POST   /api/contract-invoice-payment-links/expire-sweep — auto-expire stale pending links (cron-callable)
//
// PUBLIC endpoint (no auth — accessed via the public payment portal page):
//   GET    /api/contract-invoice-payment-links/public/:token       — get link details for the pay page
//   POST   /api/contract-invoice-payment-links/public/:token/pay   — initiate MPGS card payment
//   POST   /api/contract-invoice-payment-links/public/:token/record-payment — rep records cliq/cash receipt
//
// Payment philosophy:
//   - Card  → MPGS hosted checkout, settled via webhook (TODO in G2-PL-2.1)
//   - Cliq  → rep manually records the transfer reference + amount
//   - Cash  → rep manually records the receipt
//
// On full payment, BOTH the link (status='paid', paid_at) AND the invoice
// (status='paid', amount_paid, payment_method, payment_ref, paid_at) are
// updated atomically. Partial payments update the invoice's amount_paid
// and status='partial' but the LINK remains 'pending' (stays clickable until
// fully paid).
// ---------------------------------------------------------------------------

const express = require('express');
const router  = express.Router();
const db      = require('../db');
const logger  = require('../utils/logger');

const requireAppAuth           = require('../middleware/requireAppAuth');
const { requireTenant }        = require('../middleware/requireTenant');
const requireAdminOrTenantRole = require('../middleware/requireAdminOrTenantRole');

const {
  getOrCreatePendingLink,
  getLinkByToken,
} = require('../utils/contractInvoicePaymentLinks');

// Lazy-load MPGS payment utils — same pattern as rentalPaymentLinks.js
let isTenantMpgsEnabled, createCheckoutSession;
try {
  ({ isTenantMpgsEnabled, createCheckoutSession } = require('../utils/network'));
} catch { /* payment gateway optional */ }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateOrderId(tenantSlug) {
  const ts   = Date.now().toString(36).toUpperCase();
  const rand = require('crypto').randomBytes(3).toString('hex').toUpperCase();
  const slug = String(tenantSlug || 'T').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase();
  return `FRZ-CI-${slug}-${ts}-${rand}`.slice(0, 40);
}

async function getTenantIdFromReq(req) {
  return Number(req.tenantId || 0);
}

function buildPortalUrl(token) {
  const frontendUrl = process.env.FRONTEND_URL || 'https://app.flexrz.com';
  return `${frontendUrl}/pay-invoice/${token}`;
}

// ---------------------------------------------------------------------------
// POST /api/contract-invoice-payment-links
// Owner: create (or reuse) a payment link for a contract invoice.
// Body: { contractInvoiceId, expiresInDays? }
//
// Returns the EXISTING pending link if one is already active for this
// invoice (per the lifecycle binding rule from G2-PL-1). The reminder cron
// will rely on this same idempotent behaviour.
// ---------------------------------------------------------------------------
router.post(
  '/',
  requireAppAuth,
  requireTenant,
  requireAdminOrTenantRole('staff'),
  async (req, res) => {
    try {
      const tenantId = await getTenantIdFromReq(req);
      if (!tenantId) return res.status(400).json({ error: 'Tenant required' });

      const { contractInvoiceId, expiresInDays } = req.body || {};
      if (!contractInvoiceId) {
        return res.status(400).json({ error: 'contractInvoiceId is required' });
      }

      // Tenant ownership check on the invoice — defence in depth.
      // getOrCreatePendingLink also derives tenant_id from the invoice itself,
      // but checking here gives us a clean 403 before doing any work.
      const invCheck = await db.query(
        `SELECT id, tenant_id FROM contract_invoices WHERE id = $1`,
        [Number(contractInvoiceId)]
      );
      if (!invCheck.rows.length) {
        return res.status(404).json({ error: 'Contract invoice not found' });
      }
      if (Number(invCheck.rows[0].tenant_id) !== tenantId) {
        return res.status(403).json({ error: 'Invoice does not belong to this tenant' });
      }

      // Resolve expiry override. undefined → utility default (due_date + 90 days).
      let expiresAt;
      if (expiresInDays != null) {
        const days = Number(expiresInDays);
        if (!Number.isFinite(days) || days < 0) {
          return res.status(400).json({ error: 'expiresInDays must be a non-negative number' });
        }
        expiresAt = days === 0 ? null : new Date(Date.now() + days * 86400000);
      }

      const link = await getOrCreatePendingLink({
        contractInvoiceId: Number(contractInvoiceId),
        ...(typeof expiresAt !== 'undefined' ? { expiresAt } : {}),
      });

      logger.info(
        {
          tenantId,
          contractInvoiceId,
          linkId: link.id,
          wasExisting: link.wasExisting,
        },
        link.wasExisting ? 'Contract invoice payment link reused' : 'Contract invoice payment link created'
      );

      return res.status(link.wasExisting ? 200 : 201).json({
        ok:           true,
        link:         { ...link, portal_url: buildPortalUrl(link.token) },
        portalUrl:    buildPortalUrl(link.token),
        wasExisting:  link.wasExisting,
      });
    } catch (err) {
      // Distinguish business-rule errors thrown by the utility (paid invoice,
      // void invoice, etc.) from real server errors.
      const msg = err && err.message ? err.message : '';
      if (/already paid|is void|is cancelled|not found/i.test(msg)) {
        return res.status(409).json({ error: msg });
      }
      logger.error({ err: msg }, 'POST /contract-invoice-payment-links error');
      return res.status(500).json({ error: 'Failed to create contract invoice payment link' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/contract-invoice-payment-links
// Owner: list payment links for the tenant.
// Query: ?contractInvoiceId=&status=&limit=&offset=
// ---------------------------------------------------------------------------
router.get(
  '/',
  requireAppAuth,
  requireTenant,
  requireAdminOrTenantRole('staff'),
  async (req, res) => {
    try {
      const tenantId = await getTenantIdFromReq(req);
      if (!tenantId) return res.status(400).json({ error: 'Tenant required' });

      const {
        contractInvoiceId,
        status,
        limit  = 50,
        offset = 0,
      } = req.query;

      const where  = ['cipl.tenant_id = $1'];
      const params = [tenantId];

      if (contractInvoiceId) {
        params.push(Number(contractInvoiceId));
        where.push(`cipl.contract_invoice_id = $${params.length}`);
      }
      if (status) {
        params.push(String(status));
        where.push(`cipl.status = $${params.length}`);
      }

      params.push(Number(limit));
      params.push(Number(offset));

      const { rows } = await db.query(
        `SELECT cipl.*,
                ci.milestone_index, ci.milestone_label, ci.due_date,
                ci.amount AS invoice_amount, ci.amount_paid AS invoice_amount_paid,
                ci.status AS invoice_status,
                c.contract_number, c.start_date AS contract_start, c.end_date AS contract_end,
                cust.name  AS customer_name,
                cust.phone AS customer_phone
         FROM contract_invoice_payment_links cipl
         JOIN contract_invoices ci ON ci.id = cipl.contract_invoice_id
         JOIN contracts         c  ON c.id  = ci.contract_id
         JOIN customers        cust ON cust.id = c.customer_id
         WHERE ${where.join(' AND ')}
         ORDER BY cipl.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );

      return res.json({
        ok: true,
        links: rows.map((row) => ({ ...row, portal_url: buildPortalUrl(row.token) })),
      });
    } catch (err) {
      logger.error({ err: err.message }, 'GET /contract-invoice-payment-links error');
      return res.status(500).json({ error: 'Failed to load contract invoice payment links' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/contract-invoice-payment-links/:id
// Owner: get one link.
// ---------------------------------------------------------------------------
router.get(
  '/:id',
  requireAppAuth,
  requireTenant,
  requireAdminOrTenantRole('staff'),
  async (req, res) => {
    try {
      const tenantId = await getTenantIdFromReq(req);
      const id       = Number(req.params.id);
      // Reject non-numeric ids (e.g. /public/:token reaches the public handler
      // because it's defined first; this guard catches any other strings).
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' });

      const { rows } = await db.query(
        `SELECT cipl.*,
                ci.milestone_index, ci.milestone_label, ci.due_date,
                ci.amount AS invoice_amount, ci.amount_paid AS invoice_amount_paid,
                ci.status AS invoice_status,
                c.contract_number,
                cust.name  AS customer_name,
                cust.phone AS customer_phone
         FROM contract_invoice_payment_links cipl
         JOIN contract_invoices ci ON ci.id = cipl.contract_invoice_id
         JOIN contracts         c  ON c.id  = ci.contract_id
         JOIN customers        cust ON cust.id = c.customer_id
         WHERE cipl.id = $1 AND cipl.tenant_id = $2`,
        [id, tenantId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Link not found' });

      const link = rows[0];
      return res.json({ ok: true, link: { ...link, portal_url: buildPortalUrl(link.token) } });
    } catch (err) {
      logger.error({ err: err.message }, 'GET /contract-invoice-payment-links/:id error');
      return res.status(500).json({ error: 'Failed to load link' });
    }
  }
);

// ---------------------------------------------------------------------------
// PATCH /api/contract-invoice-payment-links/:id
// Owner: cancel a payment link. Only 'cancelled' is supported for status —
// other transitions are driven by the public endpoints (paid) or the expiry
// sweep job. This is intentional: keeps the invoice and link in sync.
// Body: { status: 'cancelled' }
// ---------------------------------------------------------------------------
router.patch(
  '/:id',
  requireAppAuth,
  requireTenant,
  requireAdminOrTenantRole('staff'),
  async (req, res) => {
    try {
      const tenantId = await getTenantIdFromReq(req);
      const id       = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' });

      const { status } = req.body || {};
      if (status !== 'cancelled') {
        return res.status(400).json({
          error: "Only status='cancelled' is allowed via PATCH. Use the public endpoints to mark paid.",
        });
      }

      const r = await db.query(
        `UPDATE contract_invoice_payment_links
            SET status = 'cancelled', cancelled_at = NOW()
          WHERE id = $1 AND tenant_id = $2 AND status = 'pending'
        RETURNING *`,
        [id, tenantId]
      );
      if (!r.rows.length) {
        // Either the link doesn't exist, doesn't belong to this tenant, or
        // isn't in 'pending' state. Return 409 to distinguish from "not found".
        const probe = await db.query(
          `SELECT status FROM contract_invoice_payment_links WHERE id = $1 AND tenant_id = $2`,
          [id, tenantId]
        );
        if (!probe.rows.length) return res.status(404).json({ error: 'Link not found' });
        return res.status(409).json({
          error: `Cannot cancel link in '${probe.rows[0].status}' state`,
          currentStatus: probe.rows[0].status,
        });
      }

      logger.info({ tenantId, linkId: id }, 'Contract invoice payment link cancelled');
      return res.json({ ok: true, link: { ...r.rows[0], portal_url: buildPortalUrl(r.rows[0].token) } });
    } catch (err) {
      logger.error({ err: err.message }, 'PATCH /contract-invoice-payment-links/:id error');
      return res.status(500).json({ error: 'Failed to cancel link' });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/contract-invoice-payment-links/expire-sweep
// Cron-callable: marks all pending links past their expires_at as 'expired'.
// Protected by header X-Cron-Secret matching CRON_SECRET env var.
// ---------------------------------------------------------------------------
router.post('/expire-sweep', async (req, res) => {
  try {
    const provided = req.headers['x-cron-secret'] || '';
    const expected = process.env.CRON_SECRET || '';
    if (!expected) {
      return res.status(503).json({ error: 'Expire sweep not configured (missing CRON_SECRET)' });
    }
    if (provided !== expected) {
      logger.warn({ ip: req.ip }, 'Contract invoice payment link expire-sweep: unauthorized');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const r = await db.query(
      `UPDATE contract_invoice_payment_links
          SET status = 'expired', expired_at = NOW()
        WHERE status = 'pending'
          AND expires_at IS NOT NULL
          AND expires_at < NOW()
        RETURNING id, contract_invoice_id, tenant_id, expires_at`
    );

    logger.info({ expiredCount: r.rows.length }, 'Contract invoice payment link expire sweep complete');
    return res.json({ ok: true, expiredCount: r.rows.length, expired: r.rows });
  } catch (err) {
    logger.error({ err: err.message }, 'POST /contract-invoice-payment-links/expire-sweep error');
    return res.status(500).json({ error: 'Failed to run expire sweep' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/contract-invoice-payment-links/public/:token
// PUBLIC — no auth. Returns link + invoice + contract + tenant context for
// the pay page. Auto-expires the link if expires_at has passed.
// ---------------------------------------------------------------------------
router.get('/public/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    if (!token) return res.status(400).json({ error: 'Token required' });

    const link = await getLinkByToken(token);
    if (!link) return res.status(404).json({ error: 'Payment link not found' });

    // Auto-expire if past the expiry window.
    if (link.status === 'pending' && link.expiresAt && new Date(link.expiresAt) < new Date()) {
      await db.query(
        `UPDATE contract_invoice_payment_links
            SET status = 'expired', expired_at = NOW()
          WHERE token = $1 AND status = 'pending'`,
        [token]
      );
      return res.status(410).json({
        error: 'This payment link has expired',
        expired: true,
        link: { ...link, status: 'expired' },
      });
    }

    return res.json({ ok: true, link });
  } catch (err) {
    logger.error({ err: err.message }, 'GET /contract-invoice-payment-links/public/:token error');
    return res.status(500).json({ error: 'Failed to load payment link' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/contract-invoice-payment-links/public/:token/pay
// PUBLIC — initiates an MPGS card checkout. Returns the session config the
// frontend mounts the hosted form against. Same flow as rentalPaymentLinks.
// Body: { method: 'card' | 'cliq' | 'cash' }
// ---------------------------------------------------------------------------
router.post('/public/:token/pay', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    const { method } = req.body || {};

    const link = await getLinkByToken(token);
    if (!link) return res.status(404).json({ error: 'Payment link not found' });

    if (link.status === 'paid')      return res.status(409).json({ error: 'This invoice has already been paid.' });
    if (link.status === 'cancelled') return res.status(410).json({ error: 'This payment link has been cancelled.' });
    if (link.status === 'expired')   return res.status(410).json({ error: 'This payment link has expired.' });

    if (method === 'card') {
      if (!isTenantMpgsEnabled || !createCheckoutSession) {
        return res.status(503).json({ error: 'Card payment gateway not available.' });
      }
      const mpgsEnabled = await isTenantMpgsEnabled(link.tenant.id);
      if (!mpgsEnabled) {
        return res.status(503).json({ error: 'Card payments not configured for this property.' });
      }

      const orderId    = generateOrderId(link.tenant.slug);
      const frontendUrl = process.env.FRONTEND_URL || 'https://app.flexrz.com';
      const returnUrl  = `${frontendUrl}/pay-invoice/${token}/result?orderId=${encodeURIComponent(orderId)}`;
      const currency   = link.currencyCode || 'JOD';

      // Outstanding amount = invoice.amount - invoice.amount_paid (handles
      // partial payments — the link reactivates an unpaid balance).
      const outstanding = Number(link.invoice.outstanding);
      if (!Number.isFinite(outstanding) || outstanding <= 0) {
        return res.status(409).json({ error: 'Nothing left to pay on this invoice.' });
      }

      const session = await createCheckoutSession(link.tenant.id, {
        orderId,
        amount:       outstanding.toFixed(3),
        currency,
        description:  `${link.contract.contractNumber} · ${link.invoice.milestoneLabel || 'Contract payment'}`,
        returnUrl,
        merchantName: link.tenant.name || 'Flexrz',
      });

      // Stash the orderId on the invoice for result lookup. We use the invoice
      // (not the link) because payment_ref is the invoice's audit field.
      // The webhook handler in G2-PL-2.1 will use this to find the invoice.
      await db.query(
        `UPDATE contract_invoices
            SET payment_ref = $1, payment_method = 'card'
          WHERE id = $2 AND tenant_id = $3`,
        [orderId, link.invoice.id, link.tenant.id]
      );

      return res.json({
        ok:         true,
        method:     'card',
        orderId,
        sessionId:  session.sessionId,
        merchantId: session.merchantId,
        checkoutJsUrl: `${session.gatewayUrl}/static/checkout/checkout.min.js`,
        checkoutConfig: {
          session:     { id: session.sessionId },
          interaction: {
            operation: 'PURCHASE',
            merchant:  { name: link.tenant.name || 'Flexrz' },
            displayControl: { billingAddress: 'HIDE', customerEmail: 'OPTIONAL' },
          },
        },
      });
    }

    // For cliq/cash we just return the link details so the frontend renders
    // payment instructions. The actual receipt is recorded via record-payment.
    return res.json({ ok: true, method: method || 'cliq', link });
  } catch (err) {
    logger.error({ err: err.message }, 'POST /contract-invoice-payment-links/public/:token/pay error');
    return res.status(500).json({ error: 'Failed to initiate payment' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/contract-invoice-payment-links/public/:token/record-payment
// Semi-public — rep records a cliq or cash payment receipt against the
// invoice. Updates BOTH the invoice (source of truth) AND the link (UI state).
// Body: { paidVia: 'cliq' | 'cash', amountPaid, paymentRef?, notes? }
// ---------------------------------------------------------------------------
router.post('/public/:token/record-payment', async (req, res) => {
  const client = await db.pool.connect();
  try {
    const token = String(req.params.token || '').trim();
    const { paidVia, amountPaid, paymentRef, notes } = req.body || {};

    if (!['cliq', 'cash'].includes(paidVia)) {
      return res.status(400).json({ error: "paidVia must be 'cliq' or 'cash'" });
    }
    const amount = Number(amountPaid);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'amountPaid must be a positive number' });
    }

    await client.query('BEGIN');

    // Lock the link row + look up the invoice. SELECT FOR UPDATE prevents
    // two concurrent record-payment calls from double-counting.
    const linkRes = await client.query(
      `SELECT cipl.id            AS link_id,
              cipl.token,
              cipl.status        AS link_status,
              cipl.contract_invoice_id,
              cipl.tenant_id,
              ci.amount          AS invoice_amount,
              ci.amount_paid     AS invoice_amount_paid,
              ci.status          AS invoice_status,
              ci.currency_code
         FROM contract_invoice_payment_links cipl
         JOIN contract_invoices ci ON ci.id = cipl.contract_invoice_id
        WHERE cipl.token = $1
          FOR UPDATE OF cipl, ci`,
      [token]
    );
    if (!linkRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Payment link not found' });
    }
    const r = linkRes.rows[0];

    if (r.link_status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Link is in '${r.link_status}' state, cannot record payment` });
    }
    if (r.invoice_status === 'paid') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Invoice already fully paid' });
    }
    if (['void', 'cancelled'].includes(r.invoice_status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Invoice is ${r.invoice_status}` });
    }

    const newPaid    = Number(r.invoice_amount_paid) + amount;
    const remaining  = Number(r.invoice_amount) - newPaid;
    // Tolerance for floating-point — JOD has 3 decimals (fils), so 0.001 is one fils.
    const fullyPaid  = remaining <= 0.001;
    const newInvoiceStatus = fullyPaid ? 'paid' : 'partial';

    // 1. Update the invoice (the source of truth for payment metadata).
    await client.query(
      `UPDATE contract_invoices
          SET amount_paid    = $1,
              status         = $2,
              payment_method = $3,
              payment_ref    = COALESCE($4, payment_ref),
              payment_notes  = COALESCE($5, payment_notes),
              paid_at        = CASE WHEN $2 = 'paid' THEN NOW() ELSE paid_at END
        WHERE id = $6`,
      [
        newPaid.toFixed(3),
        newInvoiceStatus,
        paidVia,
        paymentRef || null,
        notes || null,
        r.contract_invoice_id,
      ]
    );

    // 2. Update the LINK only when fully paid. Partial payments keep the
    //    link 'pending' so the customer can come back and finish paying.
    if (fullyPaid) {
      await client.query(
        `UPDATE contract_invoice_payment_links
            SET status = 'paid', paid_at = NOW()
          WHERE id = $1`,
        [r.link_id]
      );
    }

    await client.query('COMMIT');

    logger.info(
      {
        token,
        linkId:            r.link_id,
        contractInvoiceId: r.contract_invoice_id,
        paidVia,
        amountPaid:        amount,
        newInvoiceStatus,
        fullyPaid,
      },
      'Contract invoice payment recorded'
    );

    return res.json({
      ok: true,
      fullyPaid,
      remaining: Math.max(0, remaining),
      invoice: {
        id:           r.contract_invoice_id,
        amount:       r.invoice_amount,
        amountPaid:   newPaid.toFixed(3),
        status:       newInvoiceStatus,
        currencyCode: r.currency_code,
      },
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* best-effort */ }
    logger.error({ err: err.message }, 'POST /contract-invoice-payment-links/public/:token/record-payment error');
    return res.status(500).json({ error: 'Failed to record payment' });
  } finally {
    client.release();
  }
});

module.exports = router;
