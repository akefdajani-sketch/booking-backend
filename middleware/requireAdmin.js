// src/middleware/requireAdmin.js

// Minimal admin auth (use for owner/tenant-admin operations)
// Client must send one of:
//   - Authorization: Bearer <ADMIN_API_KEY>
//   - x-admin-key: <ADMIN_API_KEY>
//   - x-api-key: <ADMIN_API_KEY>
module.exports = function requireAdmin(req, res, next) {
  const rawAuth = String(req.headers.authorization || "");
  const bearer = rawAuth.toLowerCase().startsWith("bearer ")
    ? rawAuth.slice(7).trim()
    : null;

  const key =
    bearer ||
    String(req.headers["x-admin-key"] || "").trim() ||
    String(req.headers["x-api-key"] || "").trim();

  const expected = String(process.env.ADMIN_API_KEY || "").trim();

  if (!expected) {
    // Fail closed in production-like environments
    return res.status(500).json({
      error:
        "Server misconfigured: ADMIN_API_KEY is not set. Upload/admin routes are disabled.",
    });
  }

  if (!key || key !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  return next();
};
