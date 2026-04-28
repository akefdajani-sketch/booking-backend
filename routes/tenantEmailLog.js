'use strict';

// routes/tenantEmailLog.js
// PR K — Tenant-side email log for owners.
//
// Mirror of G2's platform-admin /api/email-log endpoint, but scoped to a
// single tenant and authed via the tenant-user JWT (not the platform admin
// key). Tenant owners use this to debug "did my customer get the booking
// confirmation?" without asking the platform team.
//
// Endpoints:
//   GET /api/tenant/:slug/email-log              — paginated rows (owner only)
//   GET /api/tenant/:slug/email-log/stats        — 7-day rollup
//
// Auth chain:
//   requireAppAuth + ensureUser + requireTenant + requireTenantRole(['owner'])
//
// Why owner-only (not viewer/staff): email log can include billing-flow
// emails (welcome, trial_warning, payment_failed) which contain plan/billing
// information staff shouldn't necessarily see. Keep it owner-scoped for now.
//
// Same query/filter shape as G2 (kind / status / recipient / before cursor)
// minus the tenant_id filter (tenant_id is fixed by URL slug → middleware).

const express = require('express');
const router  = express.Router();

const db          = require('../db');
const logger      = require('../utils/logger');
const requireAppAuth = require('../middleware/requireAppAuth');
const ensureUser  = require('../middleware/ensureUser');
const { requireTenant } = require('../middleware/requireTenant');
const { requireTenantRole } = require('../middleware/requireTenantRole');

const VALID_KINDS = new Set([
  'invite', 'trial_warning', 'payment_failed', 'welcome', 'trial_converted',
  'booking_confirmation', 'booking_reminder_24h', 'booking_reminder_1h',
  'booking_cancellation',
]);
const VALID_STATUSES = new Set(['sent', 'failed', 'skipped']);

function clampLimit(n, def = 50, max = 200) {
  const parsed = Number(n);
  if (!Number.isFinite(parsed)) return def;
  if (parsed < 1) return def;
  if (parsed > max) return max;
  return Math.floor(parsed);
}

function safeDateString(s) {
  if (!s) return null;
  const d = new Date(String(s));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// Middleware chain — copy the slug into req.query.tenantSlug so requireTenant
// (which expects ?tenantSlug=) works without us breaking that contract.
function bridgeSlug(req, _res, next) {
  req.query = req.query || {};
  req.query.tenantSlug = req.params.slug;
  next();
}

const ownerChain = [
  requireAppAuth,
  ensureUser,
  bridgeSlug,
  requireTenant,
  requireTenantRole(['owner']),
];

// ─── GET /api/tenant/:slug/email-log ─────────────────────────────────────────

router.get('/:slug/email-log', ownerChain, async (req, res) => {
  try {
    const tenantId  = Number(req.tenantId);
    const kind      = String(req.query.kind || '').trim() || null;
    const status    = String(req.query.status || '').trim() || null;
    const recipient = String(req.query.recipient || '').trim() || null;
    const before    = safeDateString(req.query.before);
    const limit     = clampLimit(req.query.limit, 50, 200);

    if (kind   && !VALID_KINDS.has(kind))      return res.status(400).json({ error: 'Invalid kind' });
    if (status && !VALID_STATUSES.has(status)) return res.status(400).json({ error: 'Invalid status' });

    // Always scoped to tenantId — never trust a body/query tenant_id here.
    const where  = ['el.tenant_id = $1'];
    const params = [tenantId];
    let p = 1;

    if (kind)      { params.push(kind);                          where.push(`el.kind = $${++p}`); }
    if (status)    { params.push(status);                        where.push(`el.status = $${++p}`); }
    if (recipient) { params.push(recipient.toLowerCase() + '%'); where.push(`LOWER(el.recipient) LIKE $${++p}`); }
    if (before)    { params.push(before);                        where.push(`el.created_at < $${++p}`); }

    params.push(limit);
    const limitParam = `$${++p}`;

    // Note: NO subject column exposed if it might leak billing-flow content.
    // For tenant-side use we keep subject (it's already shown in their own
    // app sidebar via SMS/WA channels). Drop only if a leak surfaces.
    const sql = `
      SELECT
        el.id,
        el.kind,
        el.recipient,
        el.subject,
        el.status,
        el.provider_message_id,
        el.error_message,
        el.meta,
        el.created_at
      FROM email_log el
      WHERE ${where.join(' AND ')}
      ORDER BY el.created_at DESC
      LIMIT ${limitParam}
    `;

    const result = await db.query(sql, params);
    const rows = result.rows;
    const nextCursor = rows.length === limit ? rows[rows.length - 1].created_at : null;

    res.setHeader('Cache-Control', 'private, max-age=10');
    return res.json({ rows, nextCursor, limit });
  } catch (err) {
    if (/relation .*email_log.* does not exist/i.test(err.message || '')) {
      return res.json({ rows: [], nextCursor: null, limit: 0, schemaMissing: true });
    }
    logger.error({ err: err.message }, 'GET /api/tenant/:slug/email-log failed');
    return res.status(500).json({ error: 'Failed to load email log.' });
  }
});

// ─── GET /api/tenant/:slug/email-log/stats ───────────────────────────────────

router.get('/:slug/email-log/stats', ownerChain, async (req, res) => {
  try {
    const tenantId = Number(req.tenantId);
    const result = await db.query(`
      SELECT kind, status, COUNT(*)::int AS n
      FROM email_log
      WHERE tenant_id = $1
        AND created_at > NOW() - INTERVAL '7 days'
      GROUP BY kind, status
      ORDER BY kind, status
    `, [tenantId]);

    const byKind = {};
    let totalSent = 0, totalFailed = 0, totalSkipped = 0;
    for (const row of result.rows) {
      const k = row.kind;
      if (!byKind[k]) byKind[k] = { sent: 0, failed: 0, skipped: 0, total: 0 };
      byKind[k][row.status] = row.n;
      byKind[k].total += row.n;
      if (row.status === 'sent')    totalSent += row.n;
      if (row.status === 'failed')  totalFailed += row.n;
      if (row.status === 'skipped') totalSkipped += row.n;
    }

    res.setHeader('Cache-Control', 'private, max-age=30');
    return res.json({
      windowDays: 7,
      byKind,
      total: { sent: totalSent, failed: totalFailed, skipped: totalSkipped },
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    if (/relation .*email_log.* does not exist/i.test(err.message || '')) {
      return res.json({ windowDays: 7, byKind: {}, total: { sent: 0, failed: 0, skipped: 0 }, schemaMissing: true });
    }
    logger.error({ err: err.message }, 'GET /api/tenant/:slug/email-log/stats failed');
    return res.status(500).json({ error: 'Failed to load email log stats.' });
  }
});

module.exports = router;
