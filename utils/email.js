'use strict';

// utils/email.js
// PR G (Transactional email foundation).
//
// Single transactional email sender. Resend-backed via fetch() — no new
// SDK dependency.
//
// Design priorities:
//   1. FAIL OPEN. If RESEND_API_KEY is unset (dev / staging / accidentally
//      missing in prod), sendEmail logs the attempt with status='skipped'
//      and resolves successfully. We do NOT want a missing email key to
//      break tenant invites or webhook handlers.
//   2. AUDIT EVERYTHING. Every attempt — success, failure, or skipped —
//      gets a row in email_log. That table is the source of truth for
//      "did we send X" questions. Provider-side delivery telemetry is
//      one click deeper, in Resend's dashboard.
//   3. ASYNC-SAFE. Webhook handlers can `await sendEmail(...)` without
//      worrying about Stripe webhook timeouts: the call is bounded
//      (~500ms typical) and a failure is non-fatal (caller code keeps
//      running; the failure is just logged).
//   4. NO HARD COUPLING. The kind/recipient/subject contract is plain
//      strings. Templates live in utils/emailTemplates.js — this file
//      just transports.
//
// Required env vars:
//   RESEND_API_KEY    — get at https://resend.com/api-keys
//   EMAIL_FROM        — default sender address, e.g. "Flexrz <noreply@flexrz.com>"
//                       Domain must be verified in Resend.
// Optional env vars:
//   EMAIL_REPLY_TO    — Reply-To header. Default: support@flexrz.com
//   EMAIL_KILL_SWITCH — set to "true" to skip ALL sends (status='skipped').
//                       Useful for incident response without rotating the API key.

const db     = require('../db');
const logger = require('./logger');

const RESEND_URL = 'https://api.resend.com/emails';

function getApiKey() {
  return String(process.env.RESEND_API_KEY || '').trim();
}

function getDefaultFrom() {
  return String(process.env.EMAIL_FROM || 'Flexrz <noreply@flexrz.com>').trim();
}

function getDefaultReplyTo() {
  return String(process.env.EMAIL_REPLY_TO || 'support@flexrz.com').trim();
}

function isKillSwitchActive() {
  return String(process.env.EMAIL_KILL_SWITCH || '').trim().toLowerCase() === 'true';
}

/**
 * Append a row to email_log. Never throws — log failures are swallowed and
 * surfaced via logger.error so a DB hiccup doesn't break the email path.
 */
async function recordAttempt({ tenantId, kind, recipient, subject, status, providerMessageId, errorMessage, meta }) {
  try {
    await db.query(
      `INSERT INTO email_log
         (tenant_id, kind, recipient, subject, status, provider_message_id, error_message, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        tenantId || null,
        kind,
        recipient,
        subject || null,
        status,
        providerMessageId || null,
        errorMessage || null,
        JSON.stringify(meta || {}),
      ]
    );
  } catch (err) {
    // Schema-compat: if migration 054 hasn't run yet, log to stdout and move on.
    if (/relation .* does not exist/i.test(err.message || '')) {
      logger.warn(
        { kind, recipient, status },
        'email_log table missing — migration 054 not applied yet; skipping audit row'
      );
    } else {
      logger.error({ err: err.message, kind, recipient }, 'recordAttempt failed (non-fatal)');
    }
  }
}

/**
 * Send a transactional email.
 *
 * @param {object} params
 * @param {string} params.kind        — Template key (invite|trial_warning|...).
 * @param {string} params.to          — Recipient email address.
 * @param {string} params.subject     — Subject line.
 * @param {string} params.html        — HTML body.
 * @param {string} [params.text]      — Plain-text alternate. If omitted, derived from HTML.
 * @param {number} [params.tenantId]  — For audit log + email_log row.
 * @param {object} [params.meta]      — Free-form context for email_log.meta.
 * @param {string} [params.from]      — Override sender. Defaults to EMAIL_FROM.
 * @param {string} [params.replyTo]   — Override reply-to. Defaults to EMAIL_REPLY_TO.
 *
 * @returns {Promise<{ ok: boolean, status: string, messageId?: string, error?: string }>}
 *   ok=true   → email accepted by Resend (delivery is provider's problem)
 *   ok=false  → send failed; reason in `error`
 *   status    → 'sent' | 'failed' | 'skipped'
 *
 * Never throws. Caller treats the result, doesn't try/catch.
 */
async function sendEmail(params) {
  const {
    kind,
    to,
    subject,
    html,
    text,
    tenantId,
    meta = {},
    from,
    replyTo,
  } = params || {};

  // Validate
  if (!kind)     return { ok: false, status: 'failed', error: 'missing kind' };
  if (!to)       return { ok: false, status: 'failed', error: 'missing recipient' };
  if (!subject)  return { ok: false, status: 'failed', error: 'missing subject' };
  if (!html)     return { ok: false, status: 'failed', error: 'missing html' };

  // Kill switch — skip all sends, audit as 'skipped'.
  if (isKillSwitchActive()) {
    logger.warn({ kind, to }, 'EMAIL_KILL_SWITCH active — skipping send');
    await recordAttempt({
      tenantId, kind, recipient: to, subject,
      status: 'skipped', errorMessage: 'EMAIL_KILL_SWITCH=true', meta,
    });
    return { ok: true, status: 'skipped' };
  }

  // No API key — fail open. This is the dev/staging path.
  const apiKey = getApiKey();
  if (!apiKey) {
    logger.warn({ kind, to }, 'RESEND_API_KEY not set — skipping send (fail open)');
    await recordAttempt({
      tenantId, kind, recipient: to, subject,
      status: 'skipped', errorMessage: 'RESEND_API_KEY not configured', meta,
    });
    return { ok: true, status: 'skipped' };
  }

  const fromAddr    = from    || getDefaultFrom();
  const replyToAddr = replyTo || getDefaultReplyTo();
  const textBody    = text    || stripHtml(html);

  // POST to Resend.
  let providerMessageId = null;
  let lastError = null;

  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromAddr,
        to: [to],
        subject,
        html,
        text: textBody,
        reply_to: replyToAddr,
        // Resend "tags" — searchable in their dashboard
        tags: [
          { name: 'kind', value: kind },
          ...(tenantId ? [{ name: 'tenant_id', value: String(tenantId) }] : []),
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      lastError = `HTTP ${res.status}: ${body.slice(0, 280)}`;
      logger.error({ kind, to, error: lastError }, 'Resend rejected email');
      await recordAttempt({
        tenantId, kind, recipient: to, subject,
        status: 'failed', errorMessage: lastError, meta,
      });
      return { ok: false, status: 'failed', error: lastError };
    }

    const json = await res.json().catch(() => ({}));
    providerMessageId = json?.id || null;

    logger.info(
      { kind, to, providerMessageId, tenantId },
      'Email sent'
    );
    await recordAttempt({
      tenantId, kind, recipient: to, subject,
      status: 'sent', providerMessageId, meta,
    });
    return { ok: true, status: 'sent', messageId: providerMessageId };

  } catch (err) {
    lastError = err?.message || 'unknown network error';
    logger.error({ kind, to, error: lastError }, 'sendEmail network error');
    await recordAttempt({
      tenantId, kind, recipient: to, subject,
      status: 'failed', errorMessage: lastError, meta,
    });
    return { ok: false, status: 'failed', error: lastError };
  }
}

/**
 * Quick-and-dirty HTML → text fallback. Good enough for accessibility/spam
 * scoring without pulling a full HTML parser. Templates can pass an explicit
 * `text` field when they want better formatting.
 */
function stripHtml(html) {
  return String(html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<\/?p>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/h\d>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = {
  sendEmail,
  // Internal helpers exported for tests:
  _stripHtml: stripHtml,
};
