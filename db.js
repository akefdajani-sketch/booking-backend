// db.js
const { Pool } = require("pg");

const isProd = process.env.NODE_ENV === "production";
const useSSL =
  process.env.DATABASE_SSL != null
    ? String(process.env.DATABASE_SSL).toLowerCase() === "true"
    : isProd;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,

  // Helps prevent random drops / stalls
  max: Number(process.env.PGPOOL_MAX || 5),
  idleTimeoutMillis: Number(process.env.PGPOOL_IDLE || 30000),
  connectionTimeoutMillis: Number(process.env.PGPOOL_CONN_TIMEOUT || 10000),
});

// Log unexpected pool-level errors (Render will show these)
pool.on("error", (err) => {
  console.error("PG pool error:", err);
});

module.exports = {
  pool,
  query: (...args) => pool.query(...args),
  connect: (...args) => pool.connect(...args),
};
