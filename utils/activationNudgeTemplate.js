'use strict';

// utils/activationNudgeTemplate.js
// PR L — Activation nudge email.
//
// Sent to tenants who signed up 48h+ ago but haven't completed setup. The
// goal is to gently re-engage them and surface the dashboard link with a
// progress nudge ("3/6 done — finish your setup").
//
// Same shell as utils/emailTemplates.js, kept separate so platform-billing
// templates and tenant-onboarding templates don't accidentally share state.
// Doesn't reuse the customer-booking shell either — that one carries tenant
// branding which doesn't apply for platform-to-tenant emails.

const APP_BASE = (process.env.APP_BASE_URL || 'https://app.flexrz.com').replace(/\/+$/, '');
const BRAND = 'Flexrz';

function escape(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shell({ preheader, heading, bodyHtml, ctaLabel, ctaUrl }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escape(heading)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;line-height:1.5;">
  <span style="display:none;font-size:1px;color:#f1f5f9;">${escape(preheader || '')}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f1f5f9;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background-color:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,0.06);">
        <tr><td style="padding:24px 32px;border-bottom:1px solid #e2e8f0;background-color:#0f172a;">
          <div style="font-size:18px;font-weight:800;color:#ffffff;letter-spacing:-0.3px;">${BRAND}</div>
        </td></tr>
        <tr><td style="padding:32px;">
          <h1 style="margin:0 0 16px;font-size:22px;font-weight:800;color:#0f172a;letter-spacing:-0.4px;line-height:1.3;">${escape(heading)}</h1>
          ${bodyHtml}
          ${ctaUrl ? `
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:28px;">
            <tr><td>
              <a href="${escape(ctaUrl)}" style="display:inline-block;background-color:#0f172a;color:#ffffff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:800;font-size:14px;">
                ${escape(ctaLabel || 'Continue setup')}
              </a>
            </td></tr>
          </table>` : ''}
        </td></tr>
        <tr><td style="padding:20px 32px;border-top:1px solid #e2e8f0;background-color:#f8fafc;">
          <p style="margin:0;font-size:11px;color:#94a3b8;line-height:1.6;">
            You're receiving this because you started a Flexrz trial recently.<br />
            <span style="opacity:0.7;">Powered by Flexrz · <a href="${APP_BASE}" style="color:#94a3b8;text-decoration:none;">flexrz.com</a></span>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * @param {{ tenantName: string, completedCount: number, totalCount: number, dashboardUrl: string }} ctx
 */
function renderActivationNudge({ tenantName, completedCount, totalCount, dashboardUrl }) {
  const remaining = Math.max(0, totalCount - completedCount);
  const subject = `Finish setting up ${tenantName} — ${completedCount}/${totalCount} done`;
  const body = `
    <p style="margin:0 0 12px;font-size:15px;color:#334155;">
      Hi there — you started setting up <strong>${escape(tenantName)}</strong> a couple of days ago, and you're <strong>${completedCount} of ${totalCount} steps</strong> in. Finish the remaining ${remaining} ${remaining === 1 ? 'step' : 'steps'} and your booking page goes live.
    </p>
    <p style="margin:0 0 12px;font-size:15px;color:#334155;">
      The dashboard shows exactly what's left. Most tenants finish in under 15 minutes.
    </p>
  `;
  return {
    subject,
    html: shell({
      preheader: `${remaining} ${remaining === 1 ? 'step' : 'steps'} left to launch ${tenantName}`,
      heading: 'Almost there',
      bodyHtml: body,
      ctaLabel: 'Finish setup',
      ctaUrl: dashboardUrl,
    }),
    text: `Hi — you started setting up ${tenantName} a couple of days ago and you're ${completedCount}/${totalCount} done. Finish the remaining ${remaining} ${remaining === 1 ? 'step' : 'steps'} to launch.\n\n${dashboardUrl}\n\n— ${BRAND}`,
  };
}

module.exports = { renderActivationNudge };
