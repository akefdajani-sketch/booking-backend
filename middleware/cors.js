// src/middleware/cors.js

const cors = require("cors");

const allowedOrigins = [
  "https://booking-frontend-psi.vercel.app",
  "http://localhost:3000",
];

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, origin);
    return cb(null, false);
  },
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
