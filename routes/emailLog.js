'use strict';

// routes/emailLog.js
// PR G2 (Email log panel for owner dashboard).
//
// Surfaces the email_log table (created in G migration 054) through a
// admin-key-authed REST endpoint so the platform owner can see every email
// the system has attempted to send, with filters and pagination.
//
// Endpoints:
//   GET /api/email-log              — paginated row list with filters
//   GET /api/email-log/stats        — aggregate counts by kind+status (last 7d)
//
// Auth: ADMIN_API_KEY only. Owner-cookie → admin-key proxy lives on the
// frontend at app/api/owner/email-log/.
//
// Design notes:
//   - cursor pagination using created_at, not OFFSET — large logs would
//     make OFFSET slow over time
//   - LIMIT clamped to 200 max so a malicious caller can't request all
//     million rows in one go
//   - aggregate stats query is small (7-day window) and computes the
//     counts the dashboard needs to render filter chip badges

const express = require('express');
const router  = express.Router();

const db          = require('../db');
const logger      = require('../utils/logger');
const requireAdmin = require('../middleware/requireAdmin');

// ─── Small validation helpers ────────────────────────────────────────────────

const VALID_KINDS = new Set([
  // Platform-side (G)
  'invite', 'trial_warning', 'payment_failed', 'welcome', 'trial_converted',
  // Customer-side (H)
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

// ─── GET /api/email-log ──────────────────────────────────────────────────────

router.get('/', requireAdmin, async (req, res) => {
  try {
    const tenantId  = req.query.tenant_id ? Number(req.query.tenant_id) : null;
    const kind      = String(req.query.kind || '').trim() || null;
    const status    = String(req.query.status || '').trim() || null;
    const recipient = String(req.query.recipient || '').trim() || null;
    const before    = safeDateString(req.query.before);
    const limit     = clampLimit(req.query.limit, 50, 200);

    if (kind     && !VALID_KINDS.has(kind))         return res.status(400).json({ error: 'Invalid kind' });
    if (status   && !VALID_STATUSES.has(status))    return res.status(400).json({ error: 'Invalid status' });
    if (tenantId !== null && !Number.isFinite(tenantId)) return res.status(400).json({ error: 'Invalid tenant_id' });

    // Build WHERE clauses dynamically — only include non-null filters.
    const where = [];
    const params = [];
    let p = 0;

    if (tenantId !== null) {
      params.push(tenantId);
      where.push(`el.tenant_id = $${++p}`);
    }
    if (kind) {
      params.push(kind);
      where.push(`el.kind = $${++p}`);
    }
    if (status) {
      params.push(status);
      where.push(`el.status = $${++p}`);
    }
    if (recipient) {
      // Case-insensitive prefix match — useful for "all emails to alex@..."
      params.push(recipient.toLowerCase() + '%');
      where.push(`LOWER(el.recipient) LIKE $${++p}`);
    }
    if (before) {
      params.push(before);
      where.push(`el.created_at < $${++p}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(limit);
    const limitParam = `$${++p}`;

    const sql = `
      SELECT
        el.id,
        el.tenant_id,
        t.slug AS tenant_slug,
        t.name AS tenant_name,
        el.kind,
        el.recipient,
        el.subject,
        el.status,
        el.provider_message_id,
        el.error_message,
        el.meta,
        el.created_at
      FROM email_log el
      LEFT JOIN tenants t ON t.id = el.tenant_id
      ${whereSql}
      ORDER BY el.created_at DESC
      LIMIT ${limitParam}
    `;

    const result = await db.query(sql, params);
    const rows = result.rows;

    // nextCursor = oldest created_at returned (caller passes back as `before`).
    // null when fewer than `limit` rows came back (= reached the end).
    const nextCursor = rows.length === limit ? rows[rows.length - 1].created_at : null;

    res.setHeader('Cache-Control', 'private, max-age=10');
    return res.json({ rows, nextCursor, limit });
  } catch (err) {
    // Schema-compat: if migration 054 hasn't run, return empty result rather
    // than 500 — the dashboard will render an empty state with a hint.
    if (/relation .*email_log.* does not exist/i.test(err.message || '')) {
      logger.warn('email_log table missing — migration 054 not applied yet');
      return res.json({ rows: [], nextCursor: null, limit: 0, schemaMissing: true });
    }
    logger.error({ err: err.message, stack: err.stack }, 'GET /api/email-log failed');
    return res.status(500).json({ error: 'Failed to load email log.' });
  }
});

// ─── GET /api/email-log/stats ────────────────────────────────────────────────
// Aggregate counts over last 7 days, grouped by kind+status. Used to render
// filter chip badges on the dashboard.

router.get('/stats', requireAdmin, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT kind, status, COUNT(*)::int AS n
      FROM email_log
      WHERE created_at > NOW() - INTERVAL '7 days'
      GROUP BY kind, status
      ORDER BY kind, status
    `);

    // Reshape into nested map: { [kind]: { sent, failed, skipped, total } }
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
    logger.error({ err: err.message }, 'GET /api/email-log/stats failed');
    return res.status(500).json({ error: 'Failed to load email log stats.' });
  }
});

module.exports = router;
