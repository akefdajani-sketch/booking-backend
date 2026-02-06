// utils/ensureBookingMoneyColumns.js
// Money-related columns for price + revenue reporting.
//
// IMPORTANT (SaaS-grade):
// - Production schema changes should be applied via migrations.
// - This helper exists to be backwards-compatible across environments.
// - It MUST NEVER crash requests if the DB user lacks ALTER privileges.
//
// Money model (v1):
// - price_amount: list price/value for the booking
// - charge_amount: amount actually charged (0 if covered by membership)
// - currency_code: ISO-ish currency code (e.g. JOD, USD)

const db = require("../db");

let _checked = false;
let _hasCols = false;

async function bookingMoneyColsAvailable() {
  if (_checked) return _hasCols;

  try {
    const r = await db.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema='public'
          AND table_name='bookings'
          AND column_name IN ('price_amount','charge_amount','currency_code')`
    );
    const set = new Set((r.rows || []).map((x) => String(x.column_name)));
    _hasCols =
      set.has("price_amount") && set.has("charge_amount") && set.has("currency_code");
    _checked = true;
    return _hasCols;
  } catch (err) {
    // If information_schema is not accessible (rare), treat as missing.
    console.warn(
      "bookingMoneyColsAvailable: could not read information_schema (non-fatal):",
      err?.message || err
    );
    _checked = true;
    _hasCols = false;
    return false;
  }
}

/**
 * Best-effort schema ensure.
 * - If columns already exist: resolves immediately.
 * - If not, attempts ALTER TABLE (may fail due to permissions).
 * - Never throws; returns boolean indicating whether columns exist after attempt.
 */
async function ensureBookingMoneyColumns() {
  const has = await bookingMoneyColsAvailable();
  if (has) return true;

  // Try best-effort ALTER TABLE (safe, never fatal).
  try {
    const exists = await db.query(`SELECT to_regclass('public.bookings') AS reg`);
    if (!exists.rows?.[0]?.reg) return false;

    await db.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS price_amount NUMERIC;`);
    await db.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS charge_amount NUMERIC;`);
    await db.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS currency_code TEXT;`);

    // Helpful indexes for dashboard queries at scale.
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_bookings_tenant_start_time ON bookings (tenant_id, start_time);`
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_bookings_tenant_status_start_time ON bookings (tenant_id, status, start_time);`
    );
  } catch (err) {
    // Most common: insufficient privileges in production.
    console.warn(
      "ensureBookingMoneyColumns: could not ALTER bookings (non-fatal). Apply migration manually. Error:",
      err?.message || err
    );
  }

  // Re-check after attempt
  _checked = false;
  return bookingMoneyColsAvailable();
}

module.exports = { ensureBookingMoneyColumns, bookingMoneyColsAvailable };
