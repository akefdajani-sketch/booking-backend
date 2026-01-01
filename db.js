// db.js
const { Pool } = require("pg");

const isProd = process.env.NODE_ENV === "production";

// DATABASE_SSL can override (recommended on Render)
const useSSL = process.env.DATABASE_SSL
  ? process.env.DATABASE_SSL === "true"
  : isProd;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,

  // ✅ Render-friendly tuning (optional but safe)
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  console.error("PG POOL ERROR:", err);
});

// ✅ backward compatible exports (routes can do pool.query or db.query)
module.exports = {
  pool,
  query: (...args) => pool.query(...args),
  connect: (...args) => pool.connect(...args),
};
