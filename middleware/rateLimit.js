// middleware/rateLimit.js
const crypto = require("crypto");

function getKey(req) {
  // Prefer CF-Connecting-IP (Cloudflare) then X-Forwarded-For then req.ip
  const cf = req.headers["cf-connecting-ip"];
  const xff = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = cf || xff || req.ip || "unknown";

  // Add a little “route specificity” so one noisy endpoint doesn’t block all
  const route = req.baseUrl + (req.path || "");
  return `${ip}:${route}`;
}

// Simple sliding window in-memory limiter
function createRateLimiter({ windowMs, max, name }) {
  const hits = new Map(); // key -> { count, resetAt }

  // cleanup occasionally
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits.entries()) {
      if (!v || v.resetAt <= now) hits.delete(k);
    }
  }, Math.min(windowMs, 60_000)).unref?.();

  return function rateLimit(req, res, next) {
    const now = Date.now();
    const key = getKey(req);

    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }

    entry.count += 1;

    // Helpful headers
    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - entry.count)));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > max) {
      return res.status(429).json({
        error: "Too many requests. Please slow down.",
        code: "RATE_LIMITED",
        limiter: name || "default",
      });
    }

    return next();
  };
}

// Prebuilt limiters
const limiters = {
  auth: createRateLimiter({ name: "auth", windowMs: 60_000, max: 60 }),           // 60/min per endpoint+IP
  invites: createRateLimiter({ name: "invites", windowMs: 60_000, max: 20 }),     // 20/min
  bookingsWrite: createRateLimiter({ name: "bookingsWrite", windowMs: 60_000, max: 30 }), // 30/min
  uploads: createRateLimiter({ name: "uploads", windowMs: 60_000, max: 15 }),     // 15/min
  publicRead: createRateLimiter({ name: "publicRead", windowMs: 60_000, max: 120 }) // 120/min
};

module.exports = { createRateLimiter, limiters };
