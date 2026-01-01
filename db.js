// src/db.js
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
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
