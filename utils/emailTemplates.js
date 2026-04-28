'use strict';

// utils/emailTemplates.js
// PR G (Transactional email foundation).
//
// Five transactional email templates. Each export takes a context object and
// returns { subject, html, text }.
//
// Design choices:
//   1. Inline HTML, no MJML / template engine. Each template is ~80 lines.
//      A template engine is overkill for 5 templates.
//   2. Same shell wrapper for every email — header, footer, brand color.
//      Small template-specific body in the middle. The shell handles
//      cross-client compatibility (table-based layout, max-width 560px).
//   3. Dark-mode safe — uses light-mode-only colors. Email clients render
//      poorly when authors try to be "dark-mode aware".
//   4. Plain text fallback included for every template. utils/email.js
//      will derive one if absent, but explicit text reads better.
//   5. Templates ARE the canonical product copy. Marketing tweaks live here.

const BRAND = 'Flexrz';
const BRAND_PRIMARY = '#0f172a';
const BRAND_ACCENT = '#10b981';
const BRAND_ACCENT_DARK = '#047857';
const APP_BASE = (process.env.APP_BASE_URL || 'https://app.flexrz.com').replace(/\/+$/, '');
const SUPPORT_EMAIL = process.env.EMAIL_REPLY_TO || 'support@flexrz.com';

// ─── Shared shell ────────────────────────────────────────────────────────────

function shell({ preheader, heading, bodyHtml, ctaLabel, ctaUrl, footerNote }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="color-scheme" content="light only" />
  <meta name="supported-color-schemes" content="light" />
  <title>${escape(heading)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${BRAND_PRIMARY};line-height:1.5;">
  <span style="display:none;font-size:1px;color:#f1f5f9;">${escape(preheader || '')}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f1f5f9;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background-color:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,0.06);">
          <!-- Header -->
          <tr>
            <td style="padding:24px 32px;border-bottom:1px solid #e2e8f0;">
              <div style="font-size:18px;font-weight:800;color:${BRAND_PRIMARY};letter-spacing:-0.3px;">${BRAND}</div>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:32px;">
              <h1 style="margin:0 0 16px;font-size:22px;font-weight:800;color:${BRAND_PRIMARY};letter-spacing:-0.4px;line-height:1.3;">${escape(heading)}</h1>
              ${bodyHtml}

              ${ctaUrl ? `
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:28px;">
                <tr>
                  <td>
                    <a href="${escape(ctaUrl)}" style="display:inline-block;background-color:${BRAND_ACCENT};color:#022c22;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:800;font-size:14px;">
                      ${escape(ctaLabel || 'Open')}
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
                Sent by ${BRAND}. Questions? Reply to this email or write to <a href="mailto:${SUPPORT_EMAIL}" style="color:${BRAND_ACCENT_DARK};text-decoration:none;">${SUPPORT_EMAIL}</a>.
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

function fmtMoney(amountCents, currency = 'USD') {
  const v = Number(amountCents || 0) / 100;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: (currency || 'USD').toUpperCase(),
      maximumFractionDigits: 2,
    }).format(v);
  } catch {
    return `$${v.toFixed(2)}`;
  }
}

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

// ─── Template: tenant invite ─────────────────────────────────────────────────

function renderInvite({ tenantName, inviterName, role, inviteUrl, expiresAt }) {
  const subject = `${inviterName || 'Someone'} invited you to ${tenantName} on ${BRAND}`;
  const expiry = expiresAt ? fmtDate(expiresAt) : '';

  const body = `
    <p style="margin:0 0 12px;font-size:15px;color:#334155;">
      <strong>${escape(inviterName || 'A teammate')}</strong> has invited you to join <strong>${escape(tenantName)}</strong> on ${BRAND}${role ? ` as a <strong>${escape(role)}</strong>` : ''}.
    </p>
    <p style="margin:0 0 12px;font-size:15px;color:#334155;">
      Click the button below to accept the invite and set up your access.
    </p>
    ${expiry ? `<p style="margin:0;font-size:13px;color:#64748b;">This invite expires on <strong>${escape(expiry)}</strong>.</p>` : ''}
  `;

  return {
    subject,
    html: shell({
      preheader: `${inviterName || 'A teammate'} invited you to ${tenantName}`,
      heading: 'You\'ve been invited',
      bodyHtml: body,
      ctaLabel: 'Accept invite',
      ctaUrl: inviteUrl,
      footerNote: `If you weren't expecting this, you can safely ignore the email — the invite link only works for ${escape(role || 'the assigned')} access on ${escape(tenantName)}.`,
    }),
    text: `${inviterName || 'A teammate'} invited you to join ${tenantName} on ${BRAND}${role ? ` as ${role}` : ''}.\n\nAccept: ${inviteUrl}${expiry ? `\n\nExpires: ${expiry}` : ''}\n\n— ${BRAND}`,
  };
}

// ─── Template: trial warning (3 days before trial_ends_at) ───────────────────

function renderTrialWarning({ tenantName, trialEndsAt, planName, manageBillingUrl }) {
  const subject = `Your ${BRAND} trial ends ${fmtDate(trialEndsAt)}`;
  const body = `
    <p style="margin:0 0 12px;font-size:15px;color:#334155;">
      Heads up — your <strong>${escape(tenantName)}</strong> trial of ${escape(planName || 'Flexrz')} ends on <strong>${escape(fmtDate(trialEndsAt))}</strong>.
    </p>
    <p style="margin:0 0 12px;font-size:15px;color:#334155;">
      If you keep your subscription active, you'll be charged automatically and your booking system stays online with no interruption.
    </p>
    <p style="margin:0;font-size:15px;color:#334155;">
      Want to change plan or update your card? Use the link below.
    </p>
  `;
  return {
    subject,
    html: shell({
      preheader: `Trial ends ${fmtDate(trialEndsAt)} — no action needed if you want to continue`,
      heading: 'Trial ending soon',
      bodyHtml: body,
      ctaLabel: 'Manage subscription',
      ctaUrl: manageBillingUrl || `${APP_BASE}/owner/dashboard`,
      footerNote: 'Don\'t want to continue? You can cancel anytime from the Manage subscription link above. No charges will be made if you cancel before the trial ends.',
    }),
    text: `Your ${tenantName} trial of ${planName || BRAND} ends on ${fmtDate(trialEndsAt)}.\n\nIf you continue, you'll be charged automatically and the system stays online.\n\nManage subscription: ${manageBillingUrl || `${APP_BASE}/owner/dashboard`}\n\n— ${BRAND}`,
  };
}

// ─── Template: payment failed ────────────────────────────────────────────────

function renderPaymentFailed({ tenantName, amountCents, currency, manageBillingUrl }) {
  const amount = fmtMoney(amountCents, currency);
  const subject = `Payment failed for ${tenantName} — action needed`;
  const body = `
    <p style="margin:0 0 12px;font-size:15px;color:#334155;">
      We couldn't process your <strong>${escape(amount)}</strong> ${BRAND} subscription charge for <strong>${escape(tenantName)}</strong>.
    </p>
    <p style="margin:0 0 12px;font-size:15px;color:#334155;">
      Common causes: expired card, insufficient funds, or a bank-side fraud block. Please update your payment method to keep your subscription active.
    </p>
    <p style="margin:0;font-size:15px;color:#334155;font-weight:700;color:#b91c1c;">
      Stripe will retry automatically over the next several days. Update your card now to avoid service interruption.
    </p>
  `;
  return {
    subject,
    html: shell({
      preheader: `${amount} payment failed — please update your payment method`,
      heading: 'Payment failed',
      bodyHtml: body,
      ctaLabel: 'Update payment method',
      ctaUrl: manageBillingUrl || `${APP_BASE}/owner/dashboard`,
      footerNote: `If you've already updated your card, you can ignore this email — the next retry will go through automatically.`,
    }),
    text: `Payment failed for ${tenantName}.\n\nAmount: ${amount}\n\nPlease update your payment method: ${manageBillingUrl || `${APP_BASE}/owner/dashboard`}\n\nStripe will retry automatically over the next several days.\n\n— ${BRAND}`,
  };
}

// ─── Template: welcome (post-checkout) ───────────────────────────────────────

function renderWelcome({ tenantName, planName, trialEndsAt, dashboardUrl }) {
  const subject = `Welcome to ${BRAND} — your ${planName || ''} trial is active`.replace('  ', ' ');
  const trialBlock = trialEndsAt
    ? `<p style="margin:0 0 12px;font-size:15px;color:#334155;">Your 14-day free trial runs through <strong>${escape(fmtDate(trialEndsAt))}</strong>. We'll send a heads-up 3 days before the trial ends so there are no surprises.</p>`
    : '';
  const body = `
    <p style="margin:0 0 12px;font-size:15px;color:#334155;">
      Welcome to ${BRAND}! Your <strong>${escape(tenantName)}</strong> account is ready and your ${planName ? `<strong>${escape(planName)}</strong> ` : ''}subscription is active.
    </p>
    ${trialBlock}
    <p style="margin:0;font-size:15px;color:#334155;">
      Here's what to do first:
    </p>
    <ul style="margin:8px 0 0;padding-left:20px;color:#334155;font-size:14px;line-height:1.7;">
      <li>Set up your business hours, services, and resources in <strong>Setup</strong>.</li>
      <li>Customize your booking page with logo and theme in <strong>Appearance</strong>.</li>
      <li>Invite your team in <strong>Users &amp; Roles</strong>.</li>
    </ul>
  `;
  return {
    subject,
    html: shell({
      preheader: `Your ${tenantName} account is ready — let's set it up`,
      heading: `Welcome to ${BRAND}`,
      bodyHtml: body,
      ctaLabel: 'Open my dashboard',
      ctaUrl: dashboardUrl || `${APP_BASE}/owner/dashboard`,
    }),
    text: `Welcome to ${BRAND}!\n\nYour ${tenantName} account is ready and your ${planName || ''} subscription is active.\n${trialEndsAt ? `\nTrial runs through ${fmtDate(trialEndsAt)}.` : ''}\n\nNext steps:\n- Set up business hours, services, resources\n- Customize your booking page (logo, theme)\n- Invite your team\n\nDashboard: ${dashboardUrl || `${APP_BASE}/owner/dashboard`}\n\n— ${BRAND}`,
  };
}

// ─── Template: trial converted to paid ───────────────────────────────────────

function renderTrialConverted({ tenantName, planName, amountCents, currency, manageBillingUrl }) {
  const amount = fmtMoney(amountCents, currency);
  const subject = `Your ${BRAND} subscription is now active`;
  const body = `
    <p style="margin:0 0 12px;font-size:15px;color:#334155;">
      Your <strong>${escape(tenantName)}</strong> trial has converted to a paid <strong>${escape(planName || 'subscription')}</strong>. Thanks for choosing ${BRAND}.
    </p>
    <p style="margin:0;font-size:15px;color:#334155;">
      First charge: <strong>${escape(amount)}</strong>. You'll receive a Stripe receipt separately.
    </p>
  `;
  return {
    subject,
    html: shell({
      preheader: `Trial converted to paid — ${amount} charged`,
      heading: 'Subscription active',
      bodyHtml: body,
      ctaLabel: 'View billing',
      ctaUrl: manageBillingUrl || `${APP_BASE}/owner/dashboard`,
    }),
    text: `Your ${tenantName} trial converted to a paid ${planName || 'subscription'}.\n\nFirst charge: ${amount}\n\nView billing: ${manageBillingUrl || `${APP_BASE}/owner/dashboard`}\n\n— ${BRAND}`,
  };
}

module.exports = {
  renderInvite,
  renderTrialWarning,
  renderPaymentFailed,
  renderWelcome,
  renderTrialConverted,
  // Helpers exported for tests
  _shell: shell,
  _escape: escape,
};
