// db.js
const { Pool } = require("pg");

const isProd = process.env.NODE_ENV === "production";

// Default to SSL in prod unless explicitly disabled
const useSSL =
  process.env.DATABASE_SSL
    ? process.env.DATABASE_SSL === "true"
    : isProd;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
});

module.exports = { pool };
