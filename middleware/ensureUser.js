// middleware/ensureUser.js
// Ensures there is a row in `users` for the authenticated identity.
//
// Requires one of:
//   - req.googleUser.email (from requireGoogleAuth)
//   - x-user-email header (fallback)
//
// Sets:
//   - req.user = { id, email, full_name, status }

const db = require("../db");

function extractEmail(req) {
  const g = req.googleUser?.email;
  const h = req.headers["x-user-email"];
  const email = String(g || h || "").trim().toLowerCase();
  return email || null;
}

module.exports = async function ensureUser(req, res, next) {
  try {
    const email = extractEmail(req);
    if (!email) {
      return res.status(401).json({ error: "Missing user identity." });
    }

    const fullName = String(req.googleUser?.name || "").trim() || null;

    const q = await db.query(
      `
      INSERT INTO users (email, full_name)
      VALUES ($1, $2)
      ON CONFLICT (email)
      DO UPDATE SET
        full_name = COALESCE(users.full_name, EXCLUDED.full_name),
        updated_at = now()
      RETURNING id, email, full_name, status
      `,
      [email, fullName]
    );

    const user = q.rows?.[0];
    if (!user) {
      return res.status(500).json({ error: "Failed to load user." });
    }

    if (String(user.status) === "disabled") {
      return res.status(403).json({ error: "User disabled." });
    }

    req.user = {
      id: Number(user.id),
      email: String(user.email),
      full_name: user.full_name ? String(user.full_name) : null,
      status: String(user.status),
    };

    return next();
  } catch (err) {
    console.error("ensureUser error:", err);
    return res.status(500).json({ error: "Failed to resolve user." });
  }
};
