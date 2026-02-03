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

// Allow Vercel preview URLs automatically
function isAllowed(origin) {
  if (!origin) return true; // Postman/curl/no-origin

  if (allowedOrigins.includes(origin)) return true;

  // Allow any *.vercel.app (previews + new deployments)
  try {
    const { hostname } = new URL(origin);
    if (hostname.endsWith(".vercel.app")) return true;
  } catch {}

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
