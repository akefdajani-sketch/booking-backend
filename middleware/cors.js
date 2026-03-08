// src/middleware/cors.js
const cors = require("cors");

// Put exact allowed production domains here
const allowedOrigins = [
  "http://localhost:3000",
  "https://booking-frontend-psi.vercel.app",
  "https://flexrz.com",
  "https://www.flexrz.com",
  "https://auth.flexrz.com",
];

const nodeEnv = String(process.env.NODE_ENV || "").toLowerCase();
const isProd = nodeEnv === "production";

// Allow Vercel preview URLs ONLY when explicitly enabled (or when not prod).
// In production, default is OFF.
const ALLOW_VERCEL_PREVIEWS =
  String(process.env.ALLOW_VERCEL_PREVIEWS || "").toLowerCase() === "true";

function isAllowed(origin) {
  if (!origin) return true; // Postman/curl/no-origin (not a browser CORS case)

  if (allowedOrigins.includes(origin)) return true;

  // Allow *.vercel.app only in non-prod, or when explicitly enabled.
  if (!isProd || ALLOW_VERCEL_PREVIEWS) {
    try {
      const { hostname } = new URL(origin);
      if (hostname.endsWith(".vercel.app")) return true;
    } catch {}
  }

  return false;
}

const corsOptions = {
  origin: (origin, cb) => cb(null, isAllowed(origin)),
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

const corsMiddleware = cors(corsOptions);

module.exports = {
  allowedOrigins,
  corsOptions,
  corsMiddleware,
};
