'use strict';

// utils/bankEtihad.js
// PAY-BAE: Cybersource Unified Checkout gateway wrapper for Bank al Etihad.
//
// Mirrors the surface of utils/network.js (MPGS reference):
//   isTenantBaeEnabled(tenantId)
//   createCaptureContext(tenantId, { amount, currency, targetOrigin, orderId })
//   getPaymentStatus(tenantId, { transactionId | orderId })   // STUB — see below
//
// Reuses utils/bankEtihadCredentials.js for per-tenant creds. NO env-var creds
// reads in this file. Routes mount the public surface; this file owns the HTTP
// contract with Cybersource / the BAE proxy.
//
// Architecture (decided): Unified Checkout, in-SDK up.complete(), no webhooks,
// no JWKS. The browser SDK authorizes against Cybersource directly using the
// capture-context JWT minted by createCaptureContext. The backend's role on
// the return leg is a server-side payment-status verify against Cybersource —
// see getPaymentStatus stub note below.

const logger = require('./logger');
const { getBankEtihadCredentials } = require('./bankEtihadCredentials');

// ─── Capture-context URL ──────────────────────────────────────────────────────
// The spike (branch feat/bae-microform-spike, commit 172b72b) hits the BAE
// white-label TEST proxy. Bearer auth uses the bank_etihad_cc_token credential
// (raw token, no "Bearer " prefix — confirmed by spike).
//
// !! UNRESOLVED FOR PROD !!  The prod-equivalent BAE proxy host is not stored
// in tenants.bank_etihad_host (that column holds the Cybersource direct host
// for /pts/v2/* calls — defaults to api.cybersource.com). The spike URL was
// only validated against BAE test. Override via BAE_CAPTURE_CONTEXT_URL until
// the prod host is confirmed.
const BAE_CAPTURE_CONTEXT_URL =
  process.env.BAE_CAPTURE_CONTEXT_URL ||
  'https://merchant-order-token.baelab.net/v1/payments/capture-context';

// ─── isTenantBaeEnabled ───────────────────────────────────────────────────────
// Parallels isTenantMpgsEnabled in utils/networkCredentials.js — true when the
// tenant has usable BAE credentials (merchant id + decrypted api secret).
async function isTenantBaeEnabled(tenantId) {
  const creds = await getBankEtihadCredentials(tenantId);
  return creds != null;
}

// ─── createCaptureContext ─────────────────────────────────────────────────────
// Mirrors the spike's capture-context request EXACTLY:
//   POST  https://merchant-order-token.baelab.net/v1/payments/capture-context
//   Headers: Content-Type, Accept: application/json, Authorization: <cc_token>
//   Body:   { targetOrigins:[origin], totalAmount, currency, withDecode:true }
//
// BAE renames Cybersource's standard `keyId` to `token` in the response wrapper
// (spike comment, line ~115). We return both under `captureContext` and pass the
// raw upstream body through for the caller to persist on bank_etihad_payments.
//
// opts:
//   amount        — decimal string (currency dictates digits, e.g. '1.000')
//   currency      — ISO 4217 (e.g. 'JOD'); defaults 'JOD'
//   targetOrigin  — single origin string; spike sends [targetOrigin] to BAE.
//                   Caller (route) is responsible for picking this — utils MUST
//                   NOT read req here. Required.
//   orderId       — our merchant reference code. NOT forwarded to BAE (the
//                   spike did not forward it). Accepted on the signature so the
//                   caller can log + persist it alongside the response.
async function createCaptureContext(tenantId, opts) {
  const creds = await getBankEtihadCredentials(tenantId);
  if (!creds) {
    throw new Error('Bank al Etihad credentials not configured for this tenant.');
  }
  if (!creds.ccToken) {
    throw new Error('Bank al Etihad capture-context auth token (cc_token) not set.');
  }

  const amount       = String(opts?.amount ?? '').trim();
  const currency     = String(opts?.currency ?? 'JOD').trim().toUpperCase();
  const targetOrigin = String(opts?.targetOrigin ?? '').trim();

  if (!amount)       throw new Error('createCaptureContext: amount is required.');
  if (!targetOrigin) throw new Error('createCaptureContext: targetOrigin is required.');

  const payload = {
    targetOrigins: [targetOrigin],
    totalAmount:   amount,
    currency,
    withDecode:    true,
  };

  logger.info(
    { tenantId, currency, totalAmount: amount, targetOrigin, orderId: opts?.orderId || null },
    '[bae] requesting capture-context'
  );

  let upstream;
  try {
    upstream = await fetch(BAE_CAPTURE_CONTEXT_URL, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        Accept:          'application/json',
        // Spike confirmed: Authorization is the raw cc_token — no "Bearer "
        // prefix. BAE proxy validates the bearer-style token directly.
        Authorization:   creds.ccToken,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    logger.error({ err, tenantId }, '[bae] capture-context fetch failed');
    const e = new Error('Bank al Etihad capture-context network error.');
    e.cause = err;
    throw e;
  }

  const text = await upstream.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }

  if (!upstream.ok) {
    logger.warn(
      { tenantId, status: upstream.status },
      '[bae] capture-context upstream non-2xx'
    );
    const e = new Error('Bank al Etihad capture-context upstream error.');
    e.statusCode = upstream.status;
    e.body = body;
    throw e;
  }

  // Response shape (per spike smoke test):
  //   { token: '<jwt>', clientLibrary: 'https://…cybersource.com/…',
  //     clientLibraryIntegrity: 'sha256-…' }
  // BAE wraps Cybersource's `keyId` as `token` — read defensively.
  return {
    captureContext:         body?.token || body?.keyId || null,
    clientLibrary:          body?.clientLibrary || null,
    clientLibraryIntegrity: body?.clientLibraryIntegrity || null,
    raw:                    body,
  };
}

// ─── getPaymentStatus ─────────────────────────────────────────────────────────
// !! STUB — VALIDATE BEFORE WIRING !!
// The spike did NOT exercise a server-side payment-status verify against
// Cybersource. The spike's only Cybersource-direct call was POST /pts/v2/
// payments (authorize) — and even that had the HTTP-Signature path behind an
// opt-in flag (BAE_PTS_AUTH_MODE=http-signature) that returned 501 when the
// MID/KEY/SECRET trio wasn't supplied.
//
// Standard Cybersource convention is GET /pts/v2/payments/{id} authenticated
// with HTTP Signature (HMAC-SHA256 over host + date + (request-target) +
// digest + v-c-merchant-id) using merchantId + apiSecret (base64). However:
//   - We do NOT have a separate Cybersource keyId stored — bankEtihadCredentials
//     stores merchantId + apiSecret + ccToken + host only. The spike's signature
//     helper used a *third* value (BAE_PTS_KEY) distinct from MID. Unclear
//     whether for the BAE white-label, MID also doubles as keyId.
//   - We have not validated this GET-by-id shape against BAE test.
// Resolution path: run the spike's signature helper against BAE test pointed
// at GET /pts/v2/payments/{id}, confirm MID-vs-keyId, then wire here.
async function getPaymentStatus(tenantId, opts) {
  void tenantId; void opts;
  throw new Error(
    'getPaymentStatus is not implemented — Cybersource payment-status verify ' +
    'shape was not exercised by the spike (and we may be missing a separate ' +
    'keyId credential). STOP and validate against BAE test before wiring.'
  );
}

// ─── refund ──────────────────────────────────────────────────────────────────
// Omitted for v1 per spec. Cybersource refund is POST /pts/v2/payments/{id}/
// refunds with HTTP Signature — same auth as the status-verify call above, so
// same blocker (keyId question). Add once getPaymentStatus is validated.

module.exports = {
  isTenantBaeEnabled,
  createCaptureContext,
  getPaymentStatus,
};
