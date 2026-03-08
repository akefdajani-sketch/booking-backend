// utils/ensureBookingRateColumns.js
// Stores which rate rule (if any) was applied + a JSON snapshot.
//
// Columns:
// - applied_rate_rule_id INT (nullable)
// - applied_rate_snapshot JSONB (nullable)
//
// This mirrors the philosophy of ensureBookingMoneyColumns:
// - Never fatal
// - Best-effort ALTER for backwards compatibility

const db = require("../db");

let _checked = false;
let _hasCols = false;

async function bookingRateColsAvailable() {
  if (_checked) return _hasCols;
  try {
    const r = await db.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema='public'
          AND table_name='bookings'
          AND column_name IN ('applied_rate_rule_id','applied_rate_snapshot')`
    );
    const set = new Set((r.rows || []).map((x) => String(x.column_name)));
    _hasCols = set.has("applied_rate_rule_id") && set.has("applied_rate_snapshot");
    _checked = true;
    return _hasCols;
  } catch (err) {
    console.warn(
      "bookingRateColsAvailable: could not read information_schema (non-fatal):",
      err?.message || err
    );
    _checked = true;
    _hasCols = false;
    return false;
  }
}

async function ensureBookingRateColumns() {
  const has = await bookingRateColsAvailable();
  if (has) return true;
  try {
    const exists = await db.query(`SELECT to_regclass('public.bookings') AS reg`);
    if (!exists.rows?.[0]?.reg) return false;

    await db.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS applied_rate_rule_id INT;`);
    await db.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS applied_rate_snapshot JSONB;`);
  } catch (err) {
    console.warn(
      "ensureBookingRateColumns: could not ALTER bookings (non-fatal). Apply migration manually. Error:",
      err?.message || err
    );
  }
  _checked = false;
  return bookingRateColsAvailable();
}

module.exports = { ensureBookingRateColumns, bookingRateColsAvailable };
