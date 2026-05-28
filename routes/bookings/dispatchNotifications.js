'use strict';

// routes/bookings/dispatchNotifications.js
//
// Post-COMMIT notification dispatch for a confirmed booking.
// Extracted from routes/bookings/create.js (PR 1, Phase 1 refactor).
//
// Behavior contract:
// - Three setImmediate callbacks fire after the HTTP response: WhatsApp, SMS,
//   email confirmation. Each checks its notification gate first and bails on
//   { ok: false }. Per-callback errors are logged but never thrown — the
//   booking is already committed.
// - After scheduling the three callbacks, the customer's AI context cache is
//   busted synchronously (matches pre-extraction behavior).
//
// Inputs (ctx) — pure read-only data; no req/res/db client crossing the boundary:
//   tenantId      — resolved tenant id (number)
//   tenantSlug    — tenant slug, used for the booking URL fallback
//   bookingId     — newly created booking id
//   created       — boolean; only dispatches when true (mirrors the orchestrator gate)
//   joined        — loaded joined booking row (customer_phone, customer_email,
//                   customer_name, service_name, resource_name, start_time,
//                   booking_code, currency_code, tenant_id, email)
//   authEmail     — req.auth?.email, used as the second fallback for AI cache bust
//   reqTenantId   — req.tenantId, used as the second fallback for AI cache bust
//
// Returns: void (fire-and-forget).

const db = require('../../db');
const logger = require('../../utils/logger');
const aiContextCache = require('../../utils/aiContextCache');
const { resolveTenantBookingUrl } = require('../../utils/tenantBookingUrl');

module.exports = function dispatchNotifications(ctx) {
  const {
    tenantId: resolvedTenantId,
    tenantSlug: slug,
    bookingId,
    created,
    joined,
    authEmail,
    reqTenantId,
  } = ctx || {};

  // ── WhatsApp booking confirmation (non-fatal, fires after response) ──
  // D5: gating composed in utils/notificationGates.js. The pre-D5 inline
  // check used isWhatsAppEnabledForTenant() with isWhatsAppConfigured()
  // env-var fallback; that fallback now lives inside shouldSendWA's creds
  // resolver so behavior is unchanged.
  if (created && joined?.customer_phone) {
    setImmediate(async () => {
      try {
        const { shouldSendWA } = require('../../utils/notificationGates');
        const gate = await shouldSendWA(resolvedTenantId, 'confirmations');
        if (!gate.ok) return;

        const { sendBookingConfirmation } = require('../../utils/whatsapp');

        // Load tenant name + timezone for the message
        const tRes = await require('../../db').query('SELECT name, timezone FROM tenants WHERE id = $1', [resolvedTenantId]);
        const tenantName     = tRes.rows?.[0]?.name     || 'Flexrz';
        const tenantTimezone = tRes.rows?.[0]?.timezone || 'Asia/Amman';

        // Check for a pending payment link on this booking — include in confirmation if found
        let paymentUrl = null;
        let amountDue  = null;
        let currency   = joined.currency_code || 'JOD';
        try {
          const plRes = await require('../../db').query(
            `SELECT token, amount_requested, currency_code
             FROM rental_payment_links
             WHERE booking_id = $1
               AND status = 'pending'
               AND (expires_at IS NULL OR expires_at > NOW())
             ORDER BY created_at DESC LIMIT 1`,
            [bookingId]
          );
          if (plRes.rows.length) {
          const frontendUrl = process.env.BOOKING_FRONTEND_URL || 'https://flexrz.com';
            paymentUrl = `${frontendUrl}/pay/${plRes.rows[0].token}`;
            amountDue  = plRes.rows[0].amount_requested;
            currency   = plRes.rows[0].currency_code || currency;
          }
        } catch (_plErr) { /* non-fatal — confirmation still sends without link */ }

        const waResult = await sendBookingConfirmation({
          booking: joined,
          tenantName,
          tenantTimezone,
          tenantId: resolvedTenantId,
          paymentUrl,
          amountDue,
          currency,
          bookingUrl: await resolveTenantBookingUrl(resolvedTenantId, slug, joined.booking_code),
        });
        if (waResult.ok) {
          require('../../utils/logger').info({ bookingId, phone: joined.customer_phone, msgId: waResult.messageId, hasPaymentLink: !!paymentUrl }, 'WhatsApp confirmation sent');
        } else {
          require('../../utils/logger').warn({ bookingId, reason: waResult.reason }, 'WhatsApp confirmation skipped');
        }
      } catch (waErr) {
        // Non-fatal — log but never crash the booking response
        require('../../utils/logger').error({ err: waErr, bookingId }, 'WhatsApp confirmation error (non-fatal)');
      }
    });
  }
  // ── End WhatsApp ──────────────────────────────────────────────────────

  // ── H3.5: Twilio SMS booking confirmation (non-fatal, fires after response) ──
  // D5: gating composed in utils/notificationGates.js (plan + creds +
  // per-event toggle). Replaces the pre-D5 separate hasFeature() and
  // isTwilioEnabledForTenant() calls inline below.
  //
  // G2-PL-4 Track A: SMS now includes a URL — payment link if a pending
  // payment_link exists for this booking, otherwise the booking URL.
  // Per product decision, payment link REPLACES booking link (one URL
  // per SMS). Lookup is independent of the WhatsApp block above so SMS
  // still works correctly if WA was disabled or its gate failed.
  if (created && joined?.customer_phone) {
    setImmediate(async () => {
      try {
        const { shouldSendSMS } = require('../../utils/notificationGates');
        const gate = await shouldSendSMS(resolvedTenantId, 'confirmations');
        if (!gate.ok) return;

        const { sendBookingConfirmation: sendSmsConfirmation } = require('../../utils/twilioSms');

        const tRes = await require('../../db').query(
          'SELECT name, timezone FROM tenants WHERE id = $1',
          [resolvedTenantId]
        );
        const tenantName     = tRes.rows?.[0]?.name     || 'Flexrz';
        const tenantTimezone = tRes.rows?.[0]?.timezone || 'Asia/Amman';

        // Check for a pending payment link on this booking — if found, it
        // replaces the booking URL in the SMS (one URL per spec).
        let paymentUrl = null;
        let amountDue  = null;
        let currency   = joined.currency_code || 'JOD';
        try {
          const plRes = await require('../../db').query(
            `SELECT token, amount_requested, currency_code
             FROM rental_payment_links
             WHERE booking_id = $1
               AND status = 'pending'
               AND (expires_at IS NULL OR expires_at > NOW())
             ORDER BY created_at DESC LIMIT 1`,
            [bookingId]
          );
          if (plRes.rows.length) {
            const frontendUrl = process.env.BOOKING_FRONTEND_URL || 'https://flexrz.com';
            paymentUrl = `${frontendUrl}/pay/${plRes.rows[0].token}`;
            amountDue  = plRes.rows[0].amount_requested;
            currency   = plRes.rows[0].currency_code || currency;
          }
        } catch (_plErr) { /* non-fatal — confirmation still sends without link */ }

        // Build booking URL via shared resolver: custom primary domain first,
        // BOOKING_FRONTEND_URL || flexrz.com fallback. Single source of truth
        // shared with WhatsApp + email so the three channels can't drift again.
        const bookingUrl = await resolveTenantBookingUrl(
          resolvedTenantId,
          slug,
          joined.booking_code
        );

        const smsResult = await sendSmsConfirmation({
          booking: joined,
          tenantName,
          tenantTimezone,
          tenantId: resolvedTenantId,
          bookingUrl,
          paymentUrl,
          amountDue,
          currency,
        });

        if (smsResult.ok) {
          require('../../utils/logger').info(
            {
              bookingId,
              phone: joined.customer_phone,
              msgSid: smsResult.messageSid,
              hasPaymentLink: !!paymentUrl,
              hasBookingUrl: !!bookingUrl && !paymentUrl,
            },
            'SMS confirmation sent'
          );
        } else {
          require('../../utils/logger').warn(
            { bookingId, reason: smsResult.reason },
            'SMS confirmation skipped'
          );
        }
      } catch (smsErr) {
        require('../../utils/logger').error(
          { err: smsErr.message, bookingId },
          'SMS confirmation error (non-fatal)'
        );
      }
    });
  }
  // ── End SMS ───────────────────────────────────────────────────────────

  // ── H: Customer email booking confirmation (non-fatal, fires after response) ──
  // Same setImmediate pattern as SMS/WA so the email send never blocks
  // the booking response. Gated through shouldSendEmail (plan + creds +
  // per-event toggle). Customer must have an email on file.
  if (created && joined?.customer_email) {
    setImmediate(async () => {
      try {
        const { shouldSendEmail } = require('../../utils/notificationGates');
        const gate = await shouldSendEmail(resolvedTenantId, 'confirmations');
        if (!gate.ok) return;

        const { sendEmail } = require('../../utils/email');
        const { renderBookingConfirmation } = require('../../utils/customerBookingEmailTemplates');

        const tRes = await require('../../db').query(
          `SELECT name, slug, logo_url, branding->>'timezone' AS timezone, branding->>'primary_color' AS primary_color
             FROM tenants WHERE id = $1`,
          [resolvedTenantId]
        );
        const tRow = tRes.rows?.[0] || {};

        // 2026-05-24 fix: the previous build used APP_BASE_URL (app.flexrz.com),
        // whose middleware rewrites /book/* → /tenant/* → 404. Route through the
        // shared helper so email matches WhatsApp + SMS: custom primary domain
        // if present, BOOKING_FRONTEND_URL || flexrz.com otherwise, plus
        // ?ref={booking_code} the email block previously lacked.
        const bookingUrl = await resolveTenantBookingUrl(
          resolvedTenantId,
          slug || tRow.slug,
          joined.booking_code
        );
        const tpl = renderBookingConfirmation({
          tenantName:     tRow.name || 'Flexrz',
          tenantLogoUrl:  tRow.logo_url || null, // J.3: brand the email
          tenantTimezone: tRow.timezone || 'Asia/Amman',
          bookingUrl,
          customerName:   joined.customer_name,
          serviceName:    joined.service_name,
          resourceName:   joined.resource_name,
          startTime:      joined.start_time,
          bookingCode:    joined.booking_code,
          accentColor:    tRow.primary_color,
        });

        const emailResult = await sendEmail({
          kind: 'booking_confirmation',
          to: joined.customer_email,
          subject: tpl.subject,
          html: tpl.html,
          text: tpl.text,
          tenantId: resolvedTenantId,
          meta: { booking_id: bookingId },
        });

        if (emailResult.status === 'sent') {
          require('../../utils/logger').info(
            { bookingId, recipient: joined.customer_email, messageId: emailResult.messageId },
            'Email confirmation sent'
          );
        } else if (emailResult.status === 'skipped') {
          require('../../utils/logger').info(
            { bookingId, reason: emailResult.error || 'no api key / kill switch' },
            'Email confirmation skipped'
          );
        } else {
          require('../../utils/logger').warn(
            { bookingId, error: emailResult.error },
            'Email confirmation failed'
          );
        }
      } catch (emailErr) {
        require('../../utils/logger').error(
          { err: emailErr.message, bookingId },
          'Email confirmation error (non-fatal)'
        );
      }
    });
  }
  // ── End email ─────────────────────────────────────────────────────────

  // VOICE-PERF-1: Invalidate the customer's AI context cache. The new
  // booking + any membership/package debit needs to surface to the next
  // voice/chat turn instantly. Email comes from the booking's customer
  // record (joined.customer_email) or falls back to the auth user.
  try {
    const custEmail = joined?.customer_email || joined?.email || authEmail || null;
    const tenantIdForBust = joined?.tenant_id ?? reqTenantId ?? null;
    if (tenantIdForBust && custEmail) {
      aiContextCache.bustCustomer(tenantIdForBust, custEmail);
    } else if (tenantIdForBust) {
      // Fallback: bust whole tenant's customer cache rather than risk staleness.
      aiContextCache.bustCustomer(tenantIdForBust);
    }
  } catch (_) { /* never block booking response on cache hygiene */ }
};

// Module-level `db` and `logger` requires above are intentional even though
// the dispatch blocks re-require them inline (`require('../../db')`,
// `require('../../utils/logger')`). The re-requires preserve byte-identical
// behavior with the pre-extraction code; the top-level requires keep them
// resolved eagerly so jest.mock() bindings established by tests apply
// uniformly. Both resolve to the same singleton via Node's module cache.
void db; void logger;
