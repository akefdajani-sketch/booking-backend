// routes/debugGoogleAuth.js
// TEMP DEBUG ENDPOINT (remove after fixing auth)
// Purpose: explain *why* backend Google auth rejects the bearer token.
//
// Security note:
// - This endpoint does NOT require auth so you can debug broken auth.
// - It only returns token metadata (header/payload keys) and verification errors.
// - It does NOT return the raw token.

const express = require('express');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');

const router = express.Router();

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function splitBearer(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) return null;
  const token = authHeader.slice(7).trim();
  return token || null;
}

function decodeJwtNoVerify(token) {
  // Returns null if not a JWT
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const header = safeJsonParse(Buffer.from(parts[0], 'base64').toString('utf8'));
  const payload = safeJsonParse(Buffer.from(parts[1], 'base64').toString('utf8'));
  return { header, payload };
}

router.get('/google-auth', async (req, res) => {
  const token = splitBearer(req);
  if (!token) {
    return res.status(200).json({
      ok: false,
      reason: 'missing_authorization_bearer',
      hint: 'Send Authorization: Bearer <token> header',
    });
  }

  const decoded = decodeJwtNoVerify(token);
  const payloadKeys = decoded?.payload ? Object.keys(decoded.payload) : [];
  const headerKeys = decoded?.header ? Object.keys(decoded.header) : [];

  // Heuristics to help you recognize the token type.
  const hasGoogleStyleClaims = Boolean(decoded?.payload?.iss) || Boolean(decoded?.payload?.aud);
  const likelyNextAuthJwt = !hasGoogleStyleClaims && payloadKeys.includes('jti') && payloadKeys.includes('email');

  const out = {
    ok: true,
    tokenShape: {
      isJwt: Boolean(decoded),
      headerKeys,
      payloadKeys,
      likelyNextAuthJwt,
      hasGoogleStyleClaims,
      iss: decoded?.payload?.iss || null,
      aud: decoded?.payload?.aud || null,
      exp: decoded?.payload?.exp || null,
      iat: decoded?.payload?.iat || null,
    },
    verifyIdToken: null,
    userInfo: null,
  };

  // Attempt #1: Verify as Google ID token.
  try {
    const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

    // Important: This mirrors your requireGoogleAuth audience behavior (relaxed).
    const ticket = await client.verifyIdToken({
      idToken: token,
      // If you *want* to force audience later, uncomment:
      // audience: process.env.GOOGLE_CLIENT_ID,
    });

    const p = ticket.getPayload() || {};
    out.verifyIdToken = {
      ok: true,
      payload: {
        iss: p.iss,
        aud: p.aud,
        sub: p.sub,
        email: p.email,
        email_verified: p.email_verified,
        exp: p.exp,
        iat: p.iat,
        azp: p.azp,
      },
    };
  } catch (e) {
    out.verifyIdToken = {
      ok: false,
      error: e?.message || String(e),
    };
  }

  // Attempt #2: Treat as Google Access Token and call userinfo.
  // If this works, your middleware can use it.
  try {
    const resp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = await resp.text();
    out.userInfo = {
      ok: resp.ok,
      status: resp.status,
      body: resp.ok ? safeJsonParse(text) : text,
    };
  } catch (e) {
    out.userInfo = {
      ok: false,
      error: e?.message || String(e),
    };
  }

  // Optional: try to verify as *your* JWT (if you set NEXTAUTH_SECRET on backend)
  // This does NOT make it valid for your backend auth - it just helps identify it.
  if (process.env.NEXTAUTH_SECRET && decoded) {
    try {
      const verified = jwt.verify(token, process.env.NEXTAUTH_SECRET);
      out.nextAuthJwtVerify = {
        ok: true,
        verifiedKeys: Object.keys(verified || {}),
      };
    } catch (e) {
      out.nextAuthJwtVerify = {
        ok: false,
        error: e?.message || String(e),
      };
    }
  }

  return res.status(200).json(out);
});

module.exports = router;
