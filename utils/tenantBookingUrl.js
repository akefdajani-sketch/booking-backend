'use strict';

// utils/tenantBookingUrl.js
// Resolve the public booking-page URL for a given tenant + optional booking
// deep-link reference. Shared by booking-confirmation / reminder /
// cancellation notifications across WhatsApp, SMS, and email channels.
//
// Resolution order:
//   1. tenant_domains row with status='active' AND is_primary=TRUE
//      → https://{domain}?ref={bookingCode}        (custom domain like birdiegolf-jo.com)
//   2. BOOKING_FRONTEND_URL || 'https://flexrz.com'
//      → https://flexrz.com/book/{slug}?ref={bookingCode}   (platform booking page)
//
// IMPORTANT: do NOT use FRONTEND_URL / APP_BASE_URL / FRONTEND_BASE_URL here.
// Those resolve to app.flexrz.com (the tenant-app host), where /book/* paths
// don't exist — the host's middleware rewrites everything to /tenant/*.
//
// 2026-05-24 incident: the customer email's "View booking" CTA used APP_BASE,
// produced https://app.flexrz.com/book/birdiegolf → 404. The WhatsApp + SMS
// blocks in the same file already did the tenant_domains lookup correctly;
// the email block had diverged. Routing every channel through this helper
// makes the next divergence impossible.

const db = require('../db');
const logger = require('./logger');

/**
 * @param {number|string} tenantId        — tenants.id
 * @param {string|null}   slug            — tenants.slug; required for the platform-fallback URL
 * @param {string|null}   [bookingCode]   — optional; when supplied, appended as ?ref=… for deep-link
 * @returns {Promise<string|null>}
 *   - URL string on success
 *   - null only when slug is missing AND no custom domain is set (so we
 *     genuinely can't construct any URL). Callers should treat null as
 *     "skip the View-booking CTA" rather than an error.
 *
 * Never throws — DB lookup errors fall through to the platform URL.
 */
async function resolveTenantBookingUrl(tenantId, slug, bookingCode = null) {
  const ref = bookingCode ? `?ref=${encodeURIComponent(bookingCode)}` : '';

  // 1. Custom primary domain (e.g. birdiegolf-jo.com)
  try {
    const r = await db.query(
      `SELECT domain FROM tenant_domains
       WHERE tenant_id = $1 AND status = 'active' AND is_primary = TRUE
       LIMIT 1`,
      [tenantId]
    );
    if (r.rows.length) {
      const d = String(r.rows[0].domain || '').trim().replace(/\/$/, '');
      if (d) {
        const base = /^https?:\/\//i.test(d) ? d : `https://${d}`;
        return `${base}${ref}`;
      }
    }
  } catch (err) {
    logger.warn(
      { err: err.message, tenantId },
      'tenant_domains lookup failed; falling back to platform URL'
    );
  }

  // 2. Platform fallback: BOOKING_FRONTEND_URL → https://flexrz.com/book/{slug}
  if (!slug) return null;
  const platformBase = String(
    process.env.BOOKING_FRONTEND_URL || 'https://flexrz.com'
  ).replace(/\/$/, '');
  return `${platformBase}/book/${encodeURIComponent(slug)}${ref}`;
}

module.exports = { resolveTenantBookingUrl };
