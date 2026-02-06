// utils/ensureBookingMoneyColumns.js
// Adds money-related columns needed for price + revenue reporting.
//
// Why this exists:
// - Older DBs may not have these columns.
// - This repo already uses "ensure schema" helpers to evolve the schema safely.
//
// Money model (v1):
// - price_amount: the list price/value for the booking (what the service is worth)
// - charge_amount: what was actually charged for this booking
//   (e.g. 0 if covered by a membership)
// - currency_code: ISO-ish currency code (e.g. JOD, USD)

const db = require("../db");

let _done = false;

async function ensureBookingMoneyColumns() {
  if (_done) return;

  // Ensure bookings table exists. If it doesn't, we can't safely proceed.
  const exists = await db.query(`SELECT to_regclass('public.bookings') AS reg`);
  if (!exists.rows?.[0]?.reg) return;

  // Add missing columns.
  await db.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS price_amount NUMERIC;`);
  await db.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS charge_amount NUMERIC;`);
  await db.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS currency_code TEXT;`);

  // Helpful indexes for dashboard queries at scale.
  await db.query(`CREATE INDEX IF NOT EXISTS idx_bookings_tenant_start_time ON bookings (tenant_id, start_time);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_bookings_tenant_status_start_time ON bookings (tenant_id, status, start_time);`);

  _done = true;
}

module.exports = { ensureBookingMoneyColumns };
