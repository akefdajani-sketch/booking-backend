'use strict';

// utils/customerBookingEmailTemplates.js
// PR H (Customer booking emails).
//
// Customer-facing email templates. Distinct from utils/emailTemplates.js
// (G) which holds platform-side templates (invites, trial warnings,
// receipts). These templates are sent FROM the tenant's brand TO the
// customer who made a booking — confirmation, 24h/1h reminders, cancel.
//
// Each template takes a context object and returns { subject, html, text }.
//
// Branding strategy:
//   - Subject prefixed with tenant name so customer mailbox grouping
//     stays sane: "Birdie Golf · Booking confirmed for Friday, May 1"
//   - Body shell uses tenant name in the header instead of "Flexrz"
//     (the platform stays invisible to end customers)
//   - "Powered by Flexrz" footnote is small, neutral — the email feels
//     like it's from the venue, not from us
//   - Tenant logo would be ideal — deferred to a follow-up that loads
//     tenants.logo_url and embeds it via CID or remote URL. Today the
//     header is text-only.
//
// Compatibility:
//   - Light-mode-only (Gmail dark mode + Apple Mail dark mode often
//     mangle "smart" dark-mode CSS). Hardcoded light palette.
//   - Table-based layout for max-width 560px — still the most reliable
//     pattern across desktop Outlook, mobile Gmail, etc.
//   - Plain-text fallback explicit for every template (utils/email.js
//     would derive one but explicit is more readable)

const APP_BASE = (process.env.APP_BASE_URL || 'https://app.flexrz.com').replace(/\/+$/, '');
const SUPPORT_HINT = 'Reply to this email if you have questions about your booking.';

// ─── Shared shell ────────────────────────────────────────────────────────────

function shell({ tenantName, tenantLogoUrl, preheader, heading, bodyHtml, ctaLabel, ctaUrl, footerNote, accentColor }) {
  const accent = accentColor || '#0f172a';
  // J.3: When the tenant has a logo URL, render a small <img> alongside the
  // name. Falls back to text-only header if no URL provided. Logo is sized
  // conservatively (24px tall, max 120px wide) so it works in all email
  // clients including Outlook's brittle table renderer.
  const headerInner = tenantLogoUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
         <tr>
           <td style="padding-right:10px;vertical-align:middle;">
             <img src="${escape(tenantLogoUrl)}" alt="${escape(tenantName || '')}" height="24" style="display:block;height:24px;max-width:120px;width:auto;border:0;outline:none;" />
           </td>
           <td style="vertical-align:middle;">
             <div style="font-size:18px;font-weight:800;color:#ffffff;letter-spacing:-0.3px;">${escape(tenantName || 'Booking')}</div>
           </td>
         </tr>
       </table>`
    : `<div style="font-size:18px;font-weight:800;color:#ffffff;letter-spacing:-0.3px;">${escape(tenantName || 'Booking')}</div>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="color-scheme" content="light only" />
  <meta name="supported-color-schemes" content="light" />
  <title>${escape(heading)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;line-height:1.5;">
  <span style="display:none;font-size:1px;color:#f1f5f9;">${escape(preheader || '')}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f1f5f9;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background-color:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,0.06);">
          <!-- Header -->
          <tr>
            <td style="padding:24px 32px;border-bottom:1px solid #e2e8f0;background-color:${accent};">
              ${headerInner}
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:32px;">
              <h1 style="margin:0 0 16px;font-size:22px;font-weight:800;color:#0f172a;letter-spacing:-0.4px;line-height:1.3;">${escape(heading)}</h1>
              ${bodyHtml}

              ${ctaUrl ? `
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:28px;">
                <tr>
                  <td>
                    <a href="${escape(ctaUrl)}" style="display:inline-block;background-color:${accent};color:#ffffff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:800;font-size:14px;">
                      ${escape(ctaLabel || 'View booking')}
                    </a>
                  </td>
                </tr>
              </table>
              ` : ''}

              ${footerNote ? `<p style="margin:24px 0 0;color:#64748b;font-size:12px;line-height:1.5;">${footerNote}</p>` : ''}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 32px;border-top:1px solid #e2e8f0;background-color:#f8fafc;">
              <p style="margin:0;font-size:11px;color:#94a3b8;line-height:1.6;">
                ${escape(SUPPORT_HINT)}<br />
                <span style="opacity:0.7;">Powered by Flexrz · <a href="https://flexrz.com" style="color:#94a3b8;text-decoration:none;">flexrz.com</a></span>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function escape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtDateTime(dt, tz) {
  if (!dt) return '';
  const d = new Date(dt);
  if (isNaN(d.getTime())) return '';
  try {
    return d.toLocaleString(undefined, {
      timeZone: tz || 'UTC',
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  } catch {
    return d.toUTCString();
  }
}

// Build the booking-summary block used by all 4 templates. Single source so
// styling stays consistent and one fix updates every template.
function bookingSummaryBlock({ serviceName, resourceName, startTime, tenantTimezone, bookingCode, customerName }) {
  const when = fmtDateTime(startTime, tenantTimezone);
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;">
      <tr>
        <td style="padding:16px 18px;">
          ${customerName ? `<div style="margin-bottom:10px;font-size:14px;color:#475569;">For <strong style="color:#0f172a;">${escape(customerName)}</strong></div>` : ''}
          ${serviceName ? `<div style="margin-bottom:6px;"><span style="color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:0.4px;font-weight:700;">Service</span><br /><span style="font-size:15px;font-weight:600;">${escape(serviceName)}</span></div>` : ''}
          ${resourceName ? `<div style="margin-bottom:6px;"><span style="color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:0.4px;font-weight:700;">Resource</span><br /><span style="font-size:15px;font-weight:600;">${escape(resourceName)}</span></div>` : ''}
          ${when ? `<div style="margin-bottom:6px;"><span style="color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:0.4px;font-weight:700;">When</span><br /><span style="font-size:15px;font-weight:600;">${escape(when)}</span></div>` : ''}
          ${bookingCode ? `<div style="margin-top:10px;padding-top:10px;border-top:1px dashed #cbd5e1;"><span style="color:#64748b;font-size:11px;font-weight:700;">Reference: </span><span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;font-weight:700;color:#0f172a;">${escape(bookingCode)}</span></div>` : ''}
        </td>
      </tr>
    </table>
  `;
}

function plainTextSummary({ serviceName, resourceName, startTime, tenantTimezone, bookingCode, customerName }) {
  const when = fmtDateTime(startTime, tenantTimezone);
  const lines = [];
  if (customerName) lines.push(`For: ${customerName}`);
  if (serviceName)  lines.push(`Service: ${serviceName}`);
  if (resourceName) lines.push(`Resource: ${resourceName}`);
  if (when)         lines.push(`When: ${when}`);
  if (bookingCode)  lines.push(`Reference: ${bookingCode}`);
  return lines.join('\n');
}

// ─── Template: booking confirmation ──────────────────────────────────────────

function renderBookingConfirmation(ctx) {
  const {
    tenantName, tenantLogoUrl, tenantTimezone, bookingUrl,
    customerName, serviceName, resourceName, startTime, bookingCode,
    accentColor,
  } = ctx;
  const subject = `${tenantName ? tenantName + ' · ' : ''}Booking confirmed${startTime ? ` for ${fmtDateTime(startTime, tenantTimezone).split(' at ')[0] || ''}` : ''}`;
  const body = `
    <p style="margin:0 0 8px;font-size:15px;color:#334155;">
      Your booking is confirmed${customerName ? `, ${escape(customerName)}` : ''}. Here are the details:
    </p>
    ${bookingSummaryBlock({ serviceName, resourceName, startTime, tenantTimezone, bookingCode, customerName: null })}
  `;
  return {
    subject: subject.trim(),
    html: shell({
      tenantName,
      tenantLogoUrl,
      preheader: `Your booking with ${tenantName || 'us'} is confirmed`,
      heading: 'Booking confirmed',
      bodyHtml: body,
      ctaLabel: bookingUrl ? 'View booking' : null,
      ctaUrl: bookingUrl || null,
      footerNote: 'Need to reschedule or cancel? Reply to this email or contact the venue directly.',
      accentColor,
    }),
    text: `Your booking is confirmed${customerName ? `, ${customerName}` : ''}.\n\n${plainTextSummary({ serviceName, resourceName, startTime, tenantTimezone, bookingCode, customerName: null })}\n\n${bookingUrl ? `View booking: ${bookingUrl}\n\n` : ''}— ${tenantName || 'Flexrz'}`,
  };
}

// ─── Template: 24-hour reminder ──────────────────────────────────────────────

function renderBookingReminder24h(ctx) {
  const {
    tenantName, tenantLogoUrl, tenantTimezone, bookingUrl,
    customerName, serviceName, resourceName, startTime, bookingCode,
    accentColor,
  } = ctx;
  const subject = `${tenantName ? tenantName + ' · ' : ''}Reminder: your booking tomorrow`;
  const body = `
    <p style="margin:0 0 8px;font-size:15px;color:#334155;">
      Quick reminder${customerName ? `, ${escape(customerName)}` : ''} — you have a booking with ${escape(tenantName || 'us')} tomorrow.
    </p>
    ${bookingSummaryBlock({ serviceName, resourceName, startTime, tenantTimezone, bookingCode, customerName: null })}
    <p style="margin:18px 0 0;font-size:14px;color:#475569;">
      We're looking forward to seeing you. If anything's changed, please let us know as soon as possible.
    </p>
  `;
  return {
    subject,
    html: shell({
      tenantName,
      tenantLogoUrl,
      preheader: `Booking tomorrow with ${tenantName || 'us'}`,
      heading: 'See you tomorrow',
      bodyHtml: body,
      ctaLabel: bookingUrl ? 'View booking' : null,
      ctaUrl: bookingUrl || null,
      accentColor,
    }),
    text: `Quick reminder${customerName ? `, ${customerName}` : ''} — you have a booking with ${tenantName || 'us'} tomorrow.\n\n${plainTextSummary({ serviceName, resourceName, startTime, tenantTimezone, bookingCode, customerName: null })}\n\n${bookingUrl ? `View: ${bookingUrl}\n\n` : ''}— ${tenantName || 'Flexrz'}`,
  };
}

// ─── Template: 1-hour reminder ───────────────────────────────────────────────

function renderBookingReminder1h(ctx) {
  const {
    tenantName, tenantLogoUrl, tenantTimezone, bookingUrl,
    customerName, serviceName, resourceName, startTime, bookingCode,
    accentColor,
  } = ctx;
  const subject = `${tenantName ? tenantName + ' · ' : ''}Your booking starts in 1 hour`;
  const body = `
    <p style="margin:0 0 8px;font-size:15px;color:#334155;">
      ${customerName ? `Hi ${escape(customerName)}, ` : ''}your booking with ${escape(tenantName || 'us')} starts in about an hour.
    </p>
    ${bookingSummaryBlock({ serviceName, resourceName, startTime, tenantTimezone, bookingCode, customerName: null })}
    <p style="margin:18px 0 0;font-size:14px;color:#475569;">
      Allow time for travel and parking — see you soon.
    </p>
  `;
  return {
    subject,
    html: shell({
      tenantName,
      tenantLogoUrl,
      preheader: `Booking starts in 1 hour`,
      heading: 'See you in an hour',
      bodyHtml: body,
      ctaLabel: bookingUrl ? 'View booking' : null,
      ctaUrl: bookingUrl || null,
      accentColor,
    }),
    text: `${customerName ? `Hi ${customerName}, ` : ''}your booking with ${tenantName || 'us'} starts in about an hour.\n\n${plainTextSummary({ serviceName, resourceName, startTime, tenantTimezone, bookingCode, customerName: null })}\n\n${bookingUrl ? `View: ${bookingUrl}\n\n` : ''}— ${tenantName || 'Flexrz'}`,
  };
}

// ─── Template: cancellation ──────────────────────────────────────────────────

function renderBookingCancellation(ctx) {
  const {
    tenantName, tenantLogoUrl, tenantTimezone, bookingUrl,
    customerName, serviceName, resourceName, startTime, bookingCode,
    accentColor,
  } = ctx;
  const subject = `${tenantName ? tenantName + ' · ' : ''}Booking cancelled`;
  const body = `
    <p style="margin:0 0 8px;font-size:15px;color:#334155;">
      ${customerName ? `Hi ${escape(customerName)}, ` : ''}your booking with ${escape(tenantName || 'us')} has been cancelled.
    </p>
    ${bookingSummaryBlock({ serviceName, resourceName, startTime, tenantTimezone, bookingCode, customerName: null })}
    <p style="margin:18px 0 0;font-size:14px;color:#475569;">
      If this wasn't expected, please contact us — we may be able to help reschedule.
    </p>
  `;
  return {
    subject,
    html: shell({
      tenantName,
      tenantLogoUrl,
      preheader: `Your ${tenantName || ''} booking has been cancelled`,
      heading: 'Booking cancelled',
      bodyHtml: body,
      ctaLabel: bookingUrl ? 'Make a new booking' : null,
      ctaUrl: bookingUrl || null,
      accentColor,
    }),
    text: `${customerName ? `Hi ${customerName}, ` : ''}your booking with ${tenantName || 'us'} has been cancelled.\n\n${plainTextSummary({ serviceName, resourceName, startTime, tenantTimezone, bookingCode, customerName: null })}\n\nContact us if this wasn't expected.\n\n— ${tenantName || 'Flexrz'}`,
  };
}

module.exports = {
  renderBookingConfirmation,
  renderBookingReminder24h,
  renderBookingReminder1h,
  renderBookingCancellation,
  // Helpers exported for tests
  _escape: escape,
  _fmtDateTime: fmtDateTime,
};
