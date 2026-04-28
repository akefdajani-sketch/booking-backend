'use strict';

// routes/activationStatus.js
// PR L — Tenant activation flow.
//
// Two endpoints:
//
//   GET /api/tenant/:slug/activation-status
//     Computes 6 setup milestones for the tenant and returns a structured
//     checklist. Powers the in-dashboard activation checklist component on
//     the tenant ops UI. Authed via tenant role 'viewer' (anyone with access
//     to the dashboard can see what's left to set up).
//
//   POST /api/jobs/activation-nudge
//     Cron-friendly. Finds tenants where:
//       - latest subscription started_at is between 48h and 7d ago
//         (recent enough to nudge, old enough they had time to set up)
//       - activation is incomplete (some milestone unmet)
//       - no nudge email already sent (email_log dedup, kind='activation_nudge')
//     Sends a "Get started with Flexrz" email. Authed via x-cron-secret
//     header (same env var pattern as F's trial-sweep job).
//
// No new schema. Uses existing tables: tenant_hours, services, resources,
// bookings, tenants, tenant_subscriptions, email_log.

const express = require('express');
const router  = express.Router();

const db          = require('../db');
const logger      = require('../utils/logger');
const requireAppAuth = require('../middleware/requireAppAuth');
const ensureUser  = require('../middleware/ensureUser');
const { requireTenant } = require('../middleware/requireTenant');
const { requireTenantRole } = require('../middleware/requireTenantRole');

const { sendEmail } = require('../utils/email');
const { renderActivationNudge } = require('../utils/activationNudgeTemplate');

const APP_BASE = (process.env.APP_BASE_URL || 'https://app.flexrz.com').replace(/\/+$/, '');

// ─── Milestone evaluators ────────────────────────────────────────────────────

/**
 * Compute activation status from a single composite query so we hit the DB
 * once instead of N times. Each EXISTS check is short-circuited — the planner
 * stops at the first row found.
 */
async function computeActivationStatus(tenantId) {
  const { rows } = await db.query(`
    SELECT
      EXISTS (SELECT 1 FROM tenant_hours WHERE tenant_id = $1)                    AS hours_set,
      EXISTS (SELECT 1 FROM services WHERE tenant_id = $1 AND active = true)      AS services_set,
      EXISTS (SELECT 1 FROM resources WHERE tenant_id = $1 AND active = true)     AS resources_set,
      EXISTS (SELECT 1 FROM bookings WHERE tenant_id = $1 AND deleted_at IS NULL) AS first_booking,
      (
        SELECT logo_url IS NOT NULL OR (branding->>'primary_color') IS NOT NULL
          FROM tenants WHERE id = $1
      )                                                                            AS branding_set,
      (
        SELECT (branding->>'theme') IS NOT NULL OR (branding->>'theme_id') IS NOT NULL
          FROM tenants WHERE id = $1
      )                                                                            AS theme_set
  `, [tenantId]);

  const r = rows[0] || {};

  // Build the checklist. Each item has:
  //   key, label, complete, ctaPath (relative — frontend resolves to slug-prefixed URL)
  const items = [
    { key: 'hours',         label: 'Set business hours',     complete: !!r.hours_set,     ctaPath: 'setup#hours' },
    { key: 'services',      label: 'Add a service',          complete: !!r.services_set,  ctaPath: 'setup#services' },
    { key: 'resources',     label: 'Add a resource',         complete: !!r.resources_set, ctaPath: 'setup#resources' },
    { key: 'branding',      label: 'Upload logo / brand',    complete: !!r.branding_set,  ctaPath: 'setup#images' },
    { key: 'theme',         label: 'Pick a theme',           complete: !!r.theme_set,     ctaPath: 'setup#theme' },
    { key: 'firstBooking',  label: 'Receive your first booking', complete: !!r.first_booking, ctaPath: 'bookings' },
  ];
  const completedCount = items.filter((x) => x.complete).length;
  const overallPercent = Math.round((completedCount / items.length) * 100);
  return {
    items,
    completedCount,
    totalCount: items.length,
    overallPercent,
    isComplete: completedCount === items.length,
  };
}

// ─── GET /api/tenant/:slug/activation-status ─────────────────────────────────

function bridgeSlug(req, _res, next) {
  req.query = req.query || {};
  req.query.tenantSlug = req.params.slug;
  next();
}

router.get(
  '/:slug/activation-status',
  requireAppAuth,
  ensureUser,
  bridgeSlug,
  requireTenant,
  requireTenantRole('viewer'),
  async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const status = await computeActivationStatus(tenantId);
      res.setHeader('Cache-Control', 'private, max-age=30');
      return res.json(status);
    } catch (err) {
      logger.error({ err: err.message }, 'GET activation-status failed');
      return res.status(500).json({ error: 'Failed to load activation status.' });
    }
  }
);

// ─── POST /api/jobs/activation-nudge ─────────────────────────────────────────
// Cron-friendly. Sweeps for tenants in the activation window with no nudge
// sent and emails them. Idempotent via email_log dedup.

function requireCronSecret(req, res, next) {
  const expected = process.env.ACTIVATION_NUDGE_SECRET || process.env.EMAIL_REMINDER_JOB_SECRET || '';
  const provided = req.headers['x-cron-secret'] || '';
  if (!expected) return res.status(503).json({ error: 'ACTIVATION_NUDGE_SECRET (or EMAIL_REMINDER_JOB_SECRET) not configured.' });
  if (provided !== expected) return res.status(401).json({ error: 'Bad cron secret' });
  next();
}

router.post('/activation-nudge', requireCronSecret, async (req, res) => {
  try {
    // Find candidate tenants: newest sub started 48h–7d ago AND no nudge sent.
    // (Wider 7d ceiling so a missed job run still catches the tenant.)
    const { rows: candidates } = await db.query(`
      WITH latest AS (
        SELECT DISTINCT ON (tenant_id) tenant_id, started_at, status
          FROM tenant_subscriptions
        ORDER BY tenant_id, COALESCE(started_at, NOW()) DESC
      )
      SELECT
        t.id, t.slug, t.name, t.admin_email, t.billing_email
      FROM tenants t
      JOIN latest l ON l.tenant_id = t.id
      WHERE l.started_at IS NOT NULL
        AND l.started_at <= NOW() - INTERVAL '48 hours'
        AND l.started_at >  NOW() - INTERVAL '7 days'
        AND l.status IN ('trialing', 'active')
        AND NOT EXISTS (
          SELECT 1 FROM email_log el
           WHERE el.tenant_id = t.id
             AND el.kind = 'activation_nudge'
             AND el.status = 'sent'
        )
      LIMIT 200
    `);

    const stats = { candidates: candidates.length, sent: 0, skipped: 0, failed: 0 };

    for (const tenant of candidates) {
      try {
        // Re-check activation status. If it's already complete, skip.
        const status = await computeActivationStatus(tenant.id);
        if (status.isComplete) {
          stats.skipped++;
          continue;
        }

        const recipient = tenant.admin_email || tenant.billing_email;
        if (!recipient) {
          stats.skipped++;
          continue;
        }

        const tpl = renderActivationNudge({
          tenantName: tenant.name,
          completedCount: status.completedCount,
          totalCount: status.totalCount,
          dashboardUrl: `${APP_BASE}/owner/${encodeURIComponent(tenant.slug)}`,
        });
        const result = await sendEmail({
          kind: 'activation_nudge',
          to: recipient,
          subject: tpl.subject,
          html: tpl.html,
          text: tpl.text,
          tenantId: tenant.id,
          meta: {
            completed_count: status.completedCount,
            total_count: status.totalCount,
            source: 'activation-nudge-job',
          },
        });
        if (result.status === 'sent') stats.sent++;
        else if (result.status === 'skipped') stats.skipped++;
        else stats.failed++;
      } catch (err) {
        logger.error({ err: err.message, tenantId: tenant.id }, 'activation-nudge: send failed');
        stats.failed++;
      }
    }

    logger.info({ stats }, 'activation-nudge run complete');
    return res.json({ ok: true, ...stats, generatedAt: new Date().toISOString() });
  } catch (err) {
    // Schema-compat: tolerate missing email_log
    if (/relation .*email_log.* does not exist/i.test(err.message || '')) {
      return res.json({ ok: false, schemaMissing: true, message: 'email_log table missing — run migration 054 first.' });
    }
    logger.error({ err: err.message }, 'activation-nudge job failed');
    return res.status(500).json({ error: 'Activation nudge job failed.' });
  }
});

module.exports = router;
