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
});

// Backward compatible exports
module.exports = {
  pool,
  query: (...args) => pool.query(...args),
  connect: (...args) => pool.connect(...args),
};
