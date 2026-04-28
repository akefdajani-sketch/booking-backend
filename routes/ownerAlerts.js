'use strict';

// routes/ownerAlerts.js
// PR I (Owner alerts: real signals).
//
// Replaces the mock alert data in /owner/dashboard's Overview tab with real
// platform-health signals derived from existing tables. No new schema, no
// new infrastructure — every alert maps to a SQL query against data that's
// already being maintained.
//
// Endpoint:
//   GET /api/owner-alerts
//
// Auth: ADMIN_API_KEY only. Frontend reaches here through the
// owner-cookie proxy at app/api/owner/alerts/.
//
// Returns an array of alerts (0 to N) in the AdminAlert shape the
// OverviewPanel already consumes. Each alert includes a `targetTab`
// hint so the panel's CTA button can navigate to the right tab on click.
//
// Alerts surfaced:
//   1. past_due_tenants     — count of tenants with status='past_due'
//   2. trials_no_warning    — trialing tenants ≤3 days with NULL warning stamp
//   3. failed_emails_24h    — count of failed email_log rows in last 24h
//   4. orphaned_tenants     — tenants with no subscription record (canary)
//
// Severity scaling:
//   - critical: hard outage signals (orphaned tenants, mass email failures)
//   - warn:     attention-required (past_due > 0, trials missing warning)
//   - info:     status callouts (none currently emitted)
//
// All queries run in parallel. Total cost ~30-50ms on a typical prod DB.

const express = require('express');
const router  = express.Router();

const db          = require('../db');
const logger      = require('../utils/logger');
const requireAdmin = require('../middleware/requireAdmin');

// Threshold: more than this many failed emails in 24h is a critical signal.
// Below this, it's a warning. Tunable; defaults chosen for low-volume early
// stage where any failed email is worth investigating.
const FAILED_EMAIL_CRITICAL_THRESHOLD = 10;

// ─── Per-alert evaluators ────────────────────────────────────────────────────

/**
 * Past-due tenants — anyone whose latest subscription row is past_due.
 * High-value signal because Stripe is actively retrying their charge and
 * they'll churn if not contacted.
 */
async function evalPastDueTenants() {
  try {
    const { rows } = await db.query(`
      WITH latest AS (
        SELECT DISTINCT ON (tenant_id) tenant_id, status
        FROM tenant_subscriptions
        ORDER BY tenant_id, COALESCE(started_at, NOW()) DESC
      )
      SELECT COUNT(*)::int AS n FROM latest WHERE status = 'past_due'
    `);
    const n = rows[0]?.n || 0;
    if (n === 0) return null;
    return {
      id: 'past_due_tenants',
      severity: 'warn',
      title: `${n} tenant${n === 1 ? '' : 's'} past due`,
      detail: `Stripe charge${n === 1 ? ' has' : 's have'} failed and the subscription${n === 1 ? ' is' : 's are'} in retry. Reach out before they churn.`,
      ctaLabel: 'Review past-due',
      targetTab: 'tenants',
      targetFilter: 'past_due',
    };
  } catch (err) {
    logger.warn({ err: err.message }, 'evalPastDueTenants failed');
    return null;
  }
}

/**
 * Trials ending with no warning sent — tenants on a trial expiring within
 * 3 days where trial_warning_sent_at is still NULL. This means the
 * customer.subscription.trial_will_end webhook either didn't fire (Stripe
 * delivery failure) or the warning email pipeline failed.
 *
 * Schema-compat: the trial_warning_sent_at column was added in F migration
 * 053. If the column doesn't exist, we silently skip this alert rather
 * than 500.
 */
async function evalTrialsNoWarning() {
  try {
    const { rows } = await db.query(`
      WITH latest AS (
        SELECT DISTINCT ON (tenant_id)
          tenant_id, status, trial_ends_at, trial_warning_sent_at
        FROM tenant_subscriptions
        ORDER BY tenant_id, COALESCE(started_at, NOW()) DESC
      )
      SELECT COUNT(*)::int AS n
      FROM latest
      WHERE status = 'trialing'
        AND trial_ends_at IS NOT NULL
        AND trial_ends_at <= NOW() + INTERVAL '3 days'
        AND trial_ends_at >  NOW()
        AND trial_warning_sent_at IS NULL
    `);
    const n = rows[0]?.n || 0;
    if (n === 0) return null;
    return {
      id: 'trials_no_warning',
      severity: 'warn',
      title: `${n} trial${n === 1 ? '' : 's'} ending soon — no warning sent`,
      detail: `Trial${n === 1 ? '' : 's'} expire within 3 days but the trial_will_end webhook hasn't fired. Check Stripe webhook delivery and consider reaching out manually.`,
      ctaLabel: 'Review trials',
      targetTab: 'tenants',
      targetFilter: 'trialEndingSoon',
    };
  } catch (err) {
    // Schema-compat — F migration 053 not run yet, column missing.
    if (/column .*trial_warning_sent_at.* does not exist/i.test(err.message || '')) {
      return null;
    }
    logger.warn({ err: err.message }, 'evalTrialsNoWarning failed');
    return null;
  }
}

/**
 * Failed email rate — count of email_log rows with status='failed' in the
 * last 24 hours. Anything above zero is a warning; above the critical
 * threshold is critical (suggests provider outage or auth misconfig).
 *
 * Schema-compat: G migration 054 may not be applied yet; in that case we
 * silently skip.
 */
async function evalFailedEmails24h() {
  try {
    const { rows } = await db.query(`
      SELECT COUNT(*)::int AS n
      FROM email_log
      WHERE status = 'failed'
        AND created_at > NOW() - INTERVAL '24 hours'
    `);
    const n = rows[0]?.n || 0;
    if (n === 0) return null;
    return {
      id: 'failed_emails_24h',
      severity: n >= FAILED_EMAIL_CRITICAL_THRESHOLD ? 'critical' : 'warn',
      title: `${n} email${n === 1 ? '' : 's'} failed in last 24h`,
      detail: n >= FAILED_EMAIL_CRITICAL_THRESHOLD
        ? `Significant delivery failure rate. Check Resend dashboard for provider issues and verify RESEND_API_KEY hasn't been rotated.`
        : `Some emails failed to deliver. Open the email log to see the specific error_message strings.`,
      ctaLabel: 'Open email log',
      targetTab: 'email',
      targetFilter: 'failed',
    };
  } catch (err) {
    if (/relation .*email_log.* does not exist/i.test(err.message || '')) {
      return null;
    }
    logger.warn({ err: err.message }, 'evalFailedEmails24h failed');
    return null;
  }
}

/**
 * Orphaned tenants — tenants with no subscription row at all. This should
 * be zero in normal operation: every tenant created via the onboarding
 * flow gets a subscription row from the Stripe webhook. A non-zero count
 * means either a bug in tenant creation or a manual DB insert that bypassed
 * the normal flow.
 *
 * Treated as critical because it indicates structural data drift. Even one
 * orphaned tenant is worth investigating.
 */
async function evalOrphanedTenants() {
  try {
    const { rows } = await db.query(`
      SELECT COUNT(*)::int AS n
      FROM tenants t
      WHERE NOT EXISTS (
        SELECT 1 FROM tenant_subscriptions ts WHERE ts.tenant_id = t.id
      )
    `);
    const n = rows[0]?.n || 0;
    if (n === 0) return null;
    return {
      id: 'orphaned_tenants',
      severity: 'critical',
      title: `${n} tenant${n === 1 ? '' : 's'} without a subscription`,
      detail: `Tenant${n === 1 ? '' : 's'} exist with no tenant_subscriptions row. Likely caused by a bug in onboarding or a manual DB insert. Investigate before they cause downstream issues.`,
      ctaLabel: 'Review tenants',
      targetTab: 'tenants',
    };
  } catch (err) {
    logger.warn({ err: err.message }, 'evalOrphanedTenants failed');
    return null;
  }
}

// ─── Route ───────────────────────────────────────────────────────────────────

router.get('/', requireAdmin, async (req, res) => {
  try {
    // Run all evaluators in parallel — independent queries, no shared state.
    const results = await Promise.all([
      evalPastDueTenants(),
      evalTrialsNoWarning(),
      evalFailedEmails24h(),
      evalOrphanedTenants(),
    ]);

    // Filter out nulls (alerts that didn't fire). Sort by severity:
    // critical first, then warn, then info.
    const severityOrder = { critical: 0, warn: 1, info: 2 };
    const alerts = results
      .filter(Boolean)
      .sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    res.setHeader('Cache-Control', 'private, max-age=20');
    return res.json({
      alerts,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'GET /api/owner-alerts failed');
    return res.status(500).json({ error: 'Failed to evaluate alerts.' });
  }
});

module.exports = router;
