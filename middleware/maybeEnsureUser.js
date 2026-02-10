// middleware/maybeEnsureUser.js
// Optional version of ensureUser.
//
// If we can resolve an authenticated identity (googleUser.email or x-user-email),
// we upsert/load the user row and set req.user.
// If we cannot resolve an identity, we DO NOT block the request; we simply
// continue without req.user.

const db = require("../db");

function extractEmail(req) {
  // 1) Prefer the decoded Google identity (set by requireGoogleAuth / proxy).
  const googleEmail = req.googleUser && req.googleUser.email;
  if (googleEmail) return googleEmail;

  // 2) Fallback to forwarded header (some proxy flows use this).
  const headerEmail = req.headers["x-user-email"];
  if (typeof headerEmail === "string" && headerEmail.trim()) return headerEmail.trim();

  return null;
}

module.exports = async function maybeEnsureUser(req, res, next) {
  try {
    const email = extractEmail(req);
    if (!email) return next();

    const result = await db.query(
      `INSERT INTO users (email)
       VALUES ($1)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING id, email, created_at`,
      [email]
    );

    req.user = result.rows[0];
    return next();
  } catch (err) {
    // Optional middleware should not hard-fail the request.
    console.error("maybeEnsureUser error:", err);
    return next();
  }
};
