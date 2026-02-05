// routes/debugGoogleAuth.js
// TEMP DEBUG ENDPOINT (remove after fixing auth)
// Purpose: explain *why* backend Google auth rejects the bearer token.
//
// Security note:
// - This endpoint does NOT require auth so you can debug broken auth.
// - It only returns token metadata (header/payload keys) and verification errors.
// - It does NOT return the raw token.

const express = require('express');
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

function base64UrlToJson(part) {
  try {
    // base64url -> base64
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    const jsonStr = Buffer.from(b64, 'base64').toString('utf8');
    return safeJsonParse(jsonStr);
  } catch {
    return null;
  }
}

function decodeJwtNoVerify(token) {
  // Returns null if not a JWT
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const header = base64UrlToJson(parts[0]);
  const payload = base64UrlToJson(parts[1]);
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

  // Note:
  // We intentionally do NOT verify the token with jsonwebtoken here.
  // Your backend currently does not list "jsonwebtoken" as a dependency, and
  // requiring it will crash the server on Render.
  //
  // If you later want to test "is this a NextAuth JWT signed with NEXTAUTH_SECRET",
  // either (A) add jsonwebtoken to package.json, or (B) add a small verifier using jose.
  out.nextAuthJwtVerify = {
    skipped: true,
    reason: 'jsonwebtoken not installed on backend',
    hasNextAuthSecretEnv: Boolean(process.env.NEXTAUTH_SECRET),
  };

  return res.status(200).json(out);
});

module.exports = router;
