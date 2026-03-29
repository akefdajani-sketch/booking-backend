// middleware/requireAppAuth.js
//
// PRIMARY auth middleware for customer-facing booking routes.
//
// Accepts tokens in this priority order:
//   1. Flexrz App JWT (HS256, signed with FLEXRZ_APP_JWT_SECRET)
//      — Long-lived (~30 days), minted by auth.flexrz.com on Google sign-in.
//      — This is the FIX for the ~1-hour auth drop caused by Google token expiry.
//   2. ADMIN_API_KEY  — Server-to-server / owner proxy bypass (same as requireGoogleAuth)
//   3. Google token   — Backward compat for existing sessions that predate this fix.
//
// Sets req.googleUser and req.auth for downstream route handlers (same shape as
// requireGoogleAuth so no route changes are needed for email/name extraction).
//
// DO NOT delete requireGoogleAuth.js — it is kept for direct usage in staff/owner
// routes and as the backward-compat fallback path here.

const crypto = require("crypto");
const requireGoogleAuth = require("./requireGoogleAuth");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractBearer(req) {
  const h = req.headers.authorization || req.headers.Authorization;
  if (!h) return null;
  const parts = String(h).split(" ");
  if (parts.length !== 2) return null;
  if (parts[0].toLowerCase() !== "bearer") return null;
  return parts[1];
}

function timingSafeEqualStr(a, b) {
  const aa = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function isValidAdminKey(req) {
  const rawAuth = String(req.headers.authorization || req.headers.Authorization || "");
  const bearer = rawAuth.toLowerCase().startsWith("bearer ")
    ? rawAuth.slice(7).trim()
    : null;
  const key =
    bearer ||
    String(req.headers["x-admin-key"] || "").trim() ||
    String(req.headers["x-api-key"] || "").trim();
  const expected = String(process.env.ADMIN_API_KEY || "").trim();
  if (!expected || !key) return false;
  return timingSafeEqualStr(key, expected);
}

function base64UrlDecode(input) {
  const s = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s + pad, "base64").toString("utf8");
}

function base64UrlEncode(buf) {
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function hmacSha256(input, secret) {
  return base64UrlEncode(crypto.createHmac("sha256", secret).update(input).digest());
}

function verifyHs256Jwt(token, secret) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [h, p, sig] = parts;
    const signingInput = `${h}.${p}`;
    const expected = hmacSha256(signingInput, secret);
    if (expected !== sig) return null;
    return JSON.parse(base64UrlDecode(p));
  } catch {
    return null;
  }
}

// Decode JWT header WITHOUT verification to check the algorithm.
// This lets us route HS256 (Flexrz) vs RS256 (Google) tokens correctly.
function decodeJwtHeader(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(base64UrlDecode(parts[0]));
  } catch {
    return null;
  }
}

function isFlexrzAppJwt(token) {
  // Flexrz App JWTs are always HS256
  const header = decodeJwtHeader(token);
  return header?.alg === "HS256";
}

// ---------------------------------------------------------------------------
// Main middleware
// ---------------------------------------------------------------------------

module.exports = async function requireAppAuth(req, res, next) {
  try {
    // 1. ADMIN_API_KEY bypass (server-to-server calls, owner proxy)
    if (isValidAdminKey(req)) {
      req.adminBypass = true;
      req.googleUser = { email: null, email_verified: false, name: "Admin", picture: null, sub: null };
      req.auth = req.googleUser;
      req.user = req.googleUser;
      return next();
    }

    const token =
      extractBearer(req) ||
      req.body?.googleIdToken ||
      req.query?.googleIdToken;

    if (!token) {
      return res.status(401).json({
        error: "Missing auth token.",
        code: "AUTH_TOKEN_MISSING",
      });
    }

    // 2. Flexrz App JWT path (preferred — no Google token expiry issue)
    if (isFlexrzAppJwt(token)) {
      const secret = (
        process.env.FLEXRZ_APP_JWT_SECRET ||
        process.env.NEXTAUTH_SECRET ||
        ""
      ).trim();

      if (!secret) {
        // Secret not configured — fall through to Google auth for backward compat
        console.warn("[requireAppAuth] FLEXRZ_APP_JWT_SECRET not set; falling back to Google auth");
        return requireGoogleAuth(req, res, next);
      }

      const payload = verifyHs256Jwt(token, secret);

      if (!payload) {
        // Signature invalid — could be a Google token misidentified as HS256 (unlikely).
        // Fall back to Google auth rather than hard-failing.
        return requireGoogleAuth(req, res, next);
      }

      // Check issuer — only accept tokens we minted
      if (payload.iss !== "auth.flexrz.com") {
        return res.status(401).json({
          error: "Invalid token issuer.",
          code: "APP_JWT_INVALID_ISS",
        });
      }

      // Check expiry
      const nowSec = Math.floor(Date.now() / 1000);
      if (payload.exp && nowSec >= payload.exp) {
        return res.status(401).json({
          error: "Session expired. Please sign in again.",
          code: "APP_JWT_EXPIRED",
          exp: payload.exp,
          now: nowSec,
        });
      }

      if (!payload.email) {
        return res.status(401).json({
          error: "Invalid auth token (no email).",
          code: "APP_JWT_NO_EMAIL",
        });
      }

      // Populate req.googleUser (backward compat — all routes use this field)
      const authUser = {
        email: String(payload.email).toLowerCase().trim(),
        email_verified: true,
        name: payload.name || null,
        picture: null,
        sub: payload.sub || null,
      };
      req.googleUser = authUser;
      req.auth = authUser;
      req.user = authUser;

      return next();
    }

    // 3. Google token fallback (backward compat for sessions created before this fix)
    return requireGoogleAuth(req, res, next);
  } catch (err) {
    const msg = String(err?.message || err);
    console.error("[requireAppAuth] unexpected error:", msg);
    return res.status(401).json({
      error: "Auth failed.",
      code: "AUTH_FAILED",
    });
  }
};
