'use strict';

/*
 * SPIKE — REMOVE BEFORE PROD ADAPTER MERGE
 *
 * Two endpoints to validate the full Cybersource Flex Microform v2 flow against
 * Bank al Etihad's test environment, end to end. No DB writes, no tenant lookup,
 * no booking integration. Feature-flagged by BAE_SPIKE_ENABLED === "true".
 *
 *   POST /api/payments/_spike/capture-context
 *     Proxies to BAE's capture-context endpoint and returns the JWT + SDK info.
 *
 *   POST /api/payments/_spike/finalize
 *     Calls Cybersource /pts/v2/payments with the transient token to authorize.
 *     NOTE: auth model for /pts/v2/* is not the same bearer used for capture-
 *     context. See comments in finalize handler.
 *
 * Owned: spike. Do not import from non-spike code.
 */

const express = require('express');
const logger = require('../../utils/logger');

const router = express.Router();

// ─── Feature flag gate (mandatory) ────────────────────────────────────────────
// Both endpoints return 404 — not 403 — when the flag is off. We want the
// surface to be invisible unless explicitly enabled.
router.use((req, res, next) => {
  if (process.env.BAE_SPIKE_ENABLED !== 'true') {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
});

const BAE_CAPTURE_CONTEXT_URL =
  'https://merchant-order-token.baelab.net/v1/payments/capture-context';

// Redact any value whose key looks like a PAN/CVV/secret. Defensive — the
// /pts/v2/payments happy-path response does not normally include PAN, but the
// shape is large and BAE's white-label may differ.
const SENSITIVE_KEY_RE = /(card.*number|pan|cvv|cvc|securityCode|secret|password|authorization)/i;
function redact(obj) {
  if (obj == null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redact);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEY_RE.test(k)) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = redact(v);
    }
  }
  return out;
}

// ─── A: capture-context proxy ─────────────────────────────────────────────────
router.post('/capture-context', async (req, res) => {
  const auth = process.env.ETIHAD_TEST_AUTH;
  if (!auth) {
    return res.status(500).json({
      error: 'spike_misconfigured',
      detail: 'ETIHAD_TEST_AUTH env var not set on backend',
    });
  }

  // targetOrigin must match where the SDK iframe will be embedded. For
  // file:// (the standalone HTML page) Cybersource accepts the literal "null"
  // origin; otherwise echo the request Origin header.
  const origin = req.get('origin') || req.body?.targetOrigin || 'http://localhost:3001';
  const targetOrigins = [origin];

const payload = {
  targetOrigins,
  totalAmount: '1.00',
  currency: 'JOD',
  withDecode: true,
};

  logger.info(
  { targetOrigins, totalAmount: payload.totalAmount },
  '[bae-spike] requesting capture-context'
);

  let upstream;
  try {
    upstream = await fetch(BAE_CAPTURE_CONTEXT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: auth,
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    logger.error({ err }, '[bae-spike] capture-context fetch failed');
    return res.status(502).json({
      error: 'capture_context_network_error',
      detail: err.message,
    });
  }

  const text = await upstream.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }

  logger.info(
    { status: upstream.status, hasJwt: !!(body && (body.token || body.keyId)) },
    '[bae-spike] capture-context response received'
  );

  if (!upstream.ok) {
    return res.status(upstream.status).json({
      error: 'capture_context_upstream_error',
      status: upstream.status,
      body: redact(body),
    });
  }

  // BAE response (per smoke test) is shaped like:
  //   { token: "<jwt>", clientLibrary: "https://testup.cybersource.com/...",
  //     clientLibraryIntegrity: "sha256-..." }
  // BAE renames Cybersource's standard "keyId" field to "token" in their
  // wrapper — read defensively (token || keyId) on the client.
  return res.json(body);
});

// ─── B: finalize (server-side authorize) ──────────────────────────────────────
//
// AUTH NOTE:
//   The standard Cybersource /pts/v2/payments endpoint uses HTTP Signature
//   (key id + shared secret, HMAC-SHA256 over digest + date + host + request-
//   target) or JWT with a P12 cert. The bearer token in ETIHAD_TEST_AUTH was
//   issued for the capture-context flow and is unlikely to work here.
//
//   This handler is intentionally configurable:
//     BAE_PTS_HOST          default "apitest.cybersource.com"
//     BAE_PTS_AUTH_MODE     "bearer" (default — uses ETIHAD_TEST_AUTH; the
//                                     "reach for the obvious" attempt) or
//                           "http-signature" (requires merchant id/key/secret)
//     BAE_PTS_MERCHANT_ID   required when AUTH_MODE=http-signature
//     BAE_PTS_KEY           required when AUTH_MODE=http-signature
//     BAE_PTS_SECRET        required when AUTH_MODE=http-signature (base64)
//
//   If AUTH_MODE=http-signature and any of MID/KEY/SECRET are missing, we
//   return 501 — no silent fallback.
router.post('/finalize', async (req, res) => {
  const { transientToken, clientReferenceCode } = req.body || {};
  if (!transientToken || typeof transientToken !== 'string') {
    return res
      .status(400)
      .json({ error: 'transientToken (string) is required' });
  }

  const host = process.env.BAE_PTS_HOST || 'apitest.cybersource.com';
  const mode = (process.env.BAE_PTS_AUTH_MODE || 'bearer').toLowerCase();
  const url = `https://${host}/pts/v2/payments`;
  const refCode = clientReferenceCode || `bae-spike-${Date.now()}`;

  const body = {
    clientReferenceInformation: { code: refCode },
    processingInformation: {
      capture: true,
      commerceIndicator: 'internet',
    },
    orderInformation: {
      amountDetails: { totalAmount: '1.00', currency: 'JOD' },
      billTo: {
        firstName: 'Spike',
        lastName: 'Tester',
        address1: '1 Test St',
        locality: 'Amman',
        administrativeArea: 'AM',
        postalCode: '11181',
        country: 'JO',
        email: 'spike@example.com',
        phoneNumber: '0790000000',
      },
    },
    tokenInformation: { transientTokenJwt: transientToken },
  };
  const rawBody = JSON.stringify(body);

  let headers;
  if (mode === 'bearer') {
    const auth = process.env.ETIHAD_TEST_AUTH;
    if (!auth) {
      return res.status(500).json({
        error: 'spike_misconfigured',
        detail: 'ETIHAD_TEST_AUTH not set',
      });
    }
    headers = {
      'Content-Type': 'application/json',
      Accept: 'application/hal+json;charset=utf-8',
      Authorization: `Bearer ${auth}`,
    };
  } else if (mode === 'http-signature') {
    const mid = process.env.BAE_PTS_MERCHANT_ID;
    const key = process.env.BAE_PTS_KEY;
    const secret = process.env.BAE_PTS_SECRET;
    if (!mid || !key || !secret) {
      return res.status(501).json({
        error: 'missing_credentials',
        detail:
          'BAE_PTS_AUTH_MODE=http-signature requires BAE_PTS_MERCHANT_ID, BAE_PTS_KEY, BAE_PTS_SECRET. Not guessing — STOP and supply credentials.',
      });
    }
    headers = buildHttpSignatureHeaders({
      method: 'POST',
      host,
      requestTarget: '/pts/v2/payments',
      rawBody,
      merchantId: mid,
      key,
      secret,
    });
  } else {
    return res.status(400).json({
      error: 'invalid_auth_mode',
      detail: `BAE_PTS_AUTH_MODE must be 'bearer' or 'http-signature', got ${mode}`,
    });
  }

  logger.info(
    { url, mode, refCode, transientTokenPrefix: transientToken.slice(0, 16) + '…' },
    '[bae-spike] calling /pts/v2/payments'
  );

  let upstream;
  try {
    upstream = await fetch(url, { method: 'POST', headers, body: rawBody });
  } catch (err) {
    logger.error({ err, url }, '[bae-spike] /pts/v2/payments network error');
    return res.status(502).json({
      error: 'finalize_network_error',
      detail: err.message,
      url,
      mode,
    });
  }

  const respText = await upstream.text();
  let respBody;
  try {
    respBody = JSON.parse(respText);
  } catch {
    respBody = { raw: respText };
  }

  logger.info(
    { status: upstream.status, mode, url },
    '[bae-spike] /pts/v2/payments response'
  );

  return res.status(200).json({
    requested: { url, mode, refCode },
    upstream: { status: upstream.status, body: redact(respBody) },
  });
});

// HTTP Signature (Cybersource flavor) — minimal implementation. Returns the
// header set required by /pts/v2/payments. Only invoked when the operator
// explicitly opts in via BAE_PTS_AUTH_MODE=http-signature AND supplies a key
// + secret. We do not auto-discover; if no creds, the handler short-circuits
// above with 501.
function buildHttpSignatureHeaders({
  method,
  host,
  requestTarget,
  rawBody,
  merchantId,
  key,
  secret,
}) {
  const crypto = require('crypto');
  const digest =
    'SHA-256=' + crypto.createHash('sha256').update(rawBody).digest('base64');
  const date = new Date().toUTCString();
  const signingString = [
    `host: ${host}`,
    `date: ${date}`,
    `(request-target): ${method.toLowerCase()} ${requestTarget}`,
    `digest: ${digest}`,
    `v-c-merchant-id: ${merchantId}`,
  ].join('\n');
  const signatureBytes = crypto
    .createHmac('sha256', Buffer.from(secret, 'base64'))
    .update(signingString)
    .digest('base64');
  const signature =
    `keyid="${key}", algorithm="HmacSHA256", ` +
    `headers="host date (request-target) digest v-c-merchant-id", ` +
    `signature="${signatureBytes}"`;
  return {
    'Content-Type': 'application/json',
    Accept: 'application/hal+json;charset=utf-8',
    Host: host,
    Date: date,
    Digest: digest,
    Signature: signature,
    'v-c-merchant-id': merchantId,
  };
}

module.exports = router;
