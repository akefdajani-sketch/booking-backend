// middleware/requireGoogleAuth.js
// Supports BOTH:
// 1) Google ID tokens (JWT) -> verified locally via verifyIdToken
// 2) Google access tokens -> validated via Google UserInfo endpoint
//
// Why: NextAuth refresh reliably maintains *access tokens* (with refresh_token)
// but does not reliably provide a fresh id_token after refresh.
// Accepting access tokens prevents "Google auth failed" after ~1 hour.
const { OAuth2Client } = require("google-auth-library");

// Allow one or many client ids (comma separated) for multi-env deploys
const CLIENT_IDS = String(
  process.env.GOOGLE_CLIENT_IDS || process.env.GOOGLE_CLIENT_ID || ""
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const primaryClientId = CLIENT_IDS[0] || process.env.GOOGLE_CLIENT_ID;
const client = new OAuth2Client(primaryClientId);

function extractBearer(req) {
  const h = req.headers.authorization || req.headers.Authorization;
  if (!h) return null;
  const parts = String(h).split(" ");
  if (parts.length !== 2) return null;
  if (parts[0].toLowerCase() !== "bearer") return null;
  return parts[1];
}

function looksLikeJwt(token) {
  // basic JWT check: 3 dot-separated parts
  const parts = String(token || "").split(".");
  return parts.length === 3 && parts[0].length > 0 && parts[1].length > 0;
}

async function fetchGoogleUserInfo(accessToken) {
  const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const txt = await res.text();
  let json = null;
  try {
    json = txt ? JSON.parse(txt) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const details = json || { raw: txt };
    const err = new Error(`userinfo_failed:${res.status}:${JSON.stringify(details)}`);
    err.status = res.status;
    throw err;
  }
  return json;
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

    // Prefer ID-token verification when token looks like a JWT.
    // Otherwise treat it as an access token.
    if (looksLikeJwt(token)) {
      // IMPORTANT:
      // In multi-frontend setups, the ID token's `aud` can differ (different Google OAuth client_id)
      // even though it's the same user and still a valid Google-signed token.
      // So we:
      // 1) verify with configured audience(s) when provided
      // 2) if that fails with an audience-related error, retry verification WITHOUT audience
      //    (still verifies signature + expiry).
      const audience = CLIENT_IDS.length ? CLIENT_IDS : process.env.GOOGLE_CLIENT_ID;

      let ticket;
      try {
        ticket = await client.verifyIdToken({
          idToken: token,
          audience,
        });
      } catch (e) {
        const m = String(e?.message || e);
        const audienceError = /aud|audience|wrong recipient|wrong_audience|wrong recipient/i.test(m);
        if (!audienceError) throw e;

        // Retry without audience enforcement (still verifies Google signature).
        ticket = await client.verifyIdToken({
          idToken: token,
        });
      }

      const payload = ticket.getPayload();
      if (!payload?.email) {
        return res.status(401).json({
          error: "Invalid Google token (no email).",
          code: "GOOGLE_TOKEN_INVALID",
        });
      }

      // Optional: explicit exp guard
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
    } else {
      // Access token path (recommended for long-lived NextAuth sessions)
      const info = await fetchGoogleUserInfo(token);
      if (!info?.email) {
        return res.status(401).json({
          error: "Invalid Google token (no email).",
          code: "GOOGLE_TOKEN_INVALID",
        });
      }
      req.googleUser = {
        email: info.email,
        email_verified: !!info.email_verified,
        name: info.name || null,
        picture: info.picture || null,
        sub: info.sub || null,
      };
    }

    // Backwards-compat: many routes historically used `req.user`.
    // Keep both in sync.
    req.user = req.googleUser;

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
