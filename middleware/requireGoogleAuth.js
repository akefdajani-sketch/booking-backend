// middleware/requireGoogleAuth.js
const { OAuth2Client } = require("google-auth-library");

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

async function tryUserInfo(accessToken) {
  // Fallback path when the frontend sends an access token (or when ID token
  // verification fails due to key rotation / unexpected `kid`).
  // Requires scopes: openid email profile.
  const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    const err = new Error(`userinfo_failed:${res.status}:${txt || res.statusText}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json().catch(() => null);
  if (!data?.email) {
    throw new Error("userinfo_missing_email");
  }

  return {
    email: data.email,
    email_verified: !!data.email_verified,
    name: data.name || null,
    picture: data.picture || null,
    sub: data.sub || null,
  };
}

function extractBearer(req) {
  const h = req.headers.authorization || req.headers.Authorization;
  if (!h) return null;
  const parts = String(h).split(" ");
  if (parts.length !== 2) return null;
  if (parts[0].toLowerCase() !== "bearer") return null;
  return parts[1];
}

module.exports = async function requireGoogleAuth(req, res, next) {
  try {
    const token =
      extractBearer(req) ||
      req.body?.googleIdToken ||
      req.query?.googleIdToken;

    if (!token) {
      return res.status(401).json({
        error: "Missing Google token.",
        code: "GOOGLE_TOKEN_MISSING",
      });
    }

    // Primary path: treat token as an ID token (JWT) and verify it.
    // Fallback: if it's actually an access token (or key rotation makes the JWT
    // unverifiable), validate via OpenID userinfo.
    try {
      const ticket = await client.verifyIdToken({
        idToken: token,
        audience: process.env.GOOGLE_CLIENT_ID,
      });

      const payload = ticket.getPayload();
      if (!payload?.email) {
        return res.status(401).json({
          error: "Invalid Google token (no email).",
          code: "GOOGLE_TOKEN_INVALID",
        });
      }

      // Optional: basic exp guard (verifyIdToken already checks, but keep explicit)
      const nowSec = Math.floor(Date.now() / 1000);
      if (payload.exp && nowSec >= payload.exp) {
        return res.status(401).json({
          error: "Google token expired. Please sign in again.",
          code: "GOOGLE_TOKEN_EXPIRED",
          exp: payload.exp,
          now: nowSec,
        });
      }

      req.googleUser = {
        email: payload.email,
        email_verified: !!payload.email_verified,
        name: payload.name || null,
        picture: payload.picture || null,
        sub: payload.sub || null,
      };
    } catch (e) {
      const msg = String(e?.message || e);
      // Your current production symptom:
      // "No pem found for envelope" (kid not found / key rotation / non-id token)
      if (msg.toLowerCase().includes("no pem found") || msg.toLowerCase().includes("wrong recipient") || msg.toLowerCase().includes("jwt")) {
        req.googleUser = await tryUserInfo(token);
      } else {
        throw e;
      }
    }

    return next();
  } catch (err) {
    const msg = String(err?.message || err);

    // Most common failure in your logs
    if (msg.toLowerCase().includes("used too late") || msg.toLowerCase().includes("expired")) {
      return res.status(401).json({
        error: "Google token expired. Please sign in again.",
        code: "GOOGLE_TOKEN_EXPIRED",
      });
    }

    console.error("Auth error:", msg);
    return res.status(401).json({
      error: "Google auth failed.",
      code: "GOOGLE_AUTH_FAILED",
    });
  }
};
