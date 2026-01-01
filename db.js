// src/db.js
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  console.error("PG POOL ERROR", err);
});

// Convenience helpers so routes can do: db.query(...) and db.connect()
function query(text, params) {
  return pool.query(text, params);
}
function connect() {
  return pool.connect();
}

module.exports = {
  pool,
  query,
  connect,
};
