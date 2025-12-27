// db.js
const { Pool } = require("pg");

const isProd = process.env.NODE_ENV === "production";
const useSSL = process.env.DATABASE_SSL
  ? process.env.DATABASE_SSL === "true"
  : isProd;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
});

// ✅ Backward compatible: db.query + db.connect still work
module.exports = {
  pool,
  query: (...args) => pool.query(...args),
  connect: (...args) => pool.connect(...args),
};
