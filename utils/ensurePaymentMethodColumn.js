'use strict';

// utils/ensurePaymentMethodColumn.js
// PAY-2: Defensive check for payment_method column on bookings.
//
// Same pattern as ensureBookingMoneyColumns — prevents 500 errors if
// migration 019 hasn't been run yet in a given environment.

const db = require('../db');

let _checked = false;
let _hasCol  = false;

async function paymentMethodColAvailable() {
  if (_checked) return _hasCol;

  try {
    const r = await db.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = 'bookings'
         AND column_name  = 'payment_method'`
    );
    _hasCol  = r.rows.length > 0;
    _checked = true;
    return _hasCol;
  } catch (err) {
    console.warn('ensurePaymentMethodColumn: could not read information_schema (non-fatal):', err?.message || err);
    _checked = true;
    _hasCol  = false;
    return false;
  }
}

async function ensurePaymentMethodColumn() {
  const available = await paymentMethodColAvailable();
  if (available) return true;

  try {
    await db.query(`
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_method TEXT
        CHECK (payment_method IN ('card','cliq','cash','membership','package','free'))
    `);
    _hasCol  = true;
    _checked = true;
    return true;
  } catch (err) {
    console.warn('ensurePaymentMethodColumn: could not ALTER bookings (non-fatal). Run migration 019. Error:', err?.message || err);
    return false;
  }
}

module.exports = { ensurePaymentMethodColumn };
