// utils/customerQueryHelpers.js
//
// Schema-compatibility helpers shared by all routes/customers/ sub-files.
// These probe information_schema at runtime so queries never reference
// missing columns (the DB schema has evolved across several releases).
//
// Extracted from routes/customers.js.

const { pool } = require("../db");
const db = pool;

const _columnsCache = new Map(); // tableName -> Set(column_name)

async function getExistingColumns(tableName) {
  if (_columnsCache.has(tableName)) return _columnsCache.get(tableName);
  const res = await db.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1`,
    [tableName]
  );
  const set = new Set(res.rows.map((r) => r.column_name));
  _columnsCache.set(tableName, set);
  return set;
}

function firstExisting(colSet, candidates) {
  for (const c of candidates) {
    if (c && colSet.has(c)) return c;
  }
  return null;
}

async function pickCol(tableName, alias, candidates, fallbackSql = "NULL") {
  const cols = await getExistingColumns(tableName);
  const col = firstExisting(cols, candidates);
  return col ? `${alias}.${col}` : fallbackSql;
}

// PR-10: Soft-delete filter — only active (non-deleted) rows.
// Returns empty string if the deleted_at column doesn't exist yet (safe for
// environments that haven't run migration 005).
async function softDeleteClause(tableName, alias) {
  const cols = await getExistingColumns(tableName);
  return cols.has("deleted_at") ? `AND ${alias}.deleted_at IS NULL` : "";
}

function safeIntExpr(sql) {
  // Ensure numeric-ish expressions don't break JSON consumers
  return `COALESCE((${sql})::int, 0)`;
}

function getErrorCode(err) {
  return err?.code || err?.sqlState || err?.original?.code || null;
}

// ------------------------------------------------------------
// ADMIN: GET /api/customers/search?tenantSlug|tenantId&q=&limit=
// Lightweight search endpoint for autocomplete.
// ------------------------------------------------------------

module.exports = { getExistingColumns, firstExisting, pickCol, softDeleteClause, safeIntExpr, getErrorCode };
