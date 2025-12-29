// middleware/requireGoogleAuth.js
const { OAuth2Client } = require("google-auth-library");

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

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
    const idToken =
      extractBearer(req) ||
      req.body?.googleIdToken ||
      req.query?.googleIdToken;

    if (!idToken) {
      return res.status(401).json({
        error: "Missing Google token.",
        code: "GOOGLE_TOKEN_MISSING",
      });
    }

    const ticket = await client.verifyIdToken({
      idToken,
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
