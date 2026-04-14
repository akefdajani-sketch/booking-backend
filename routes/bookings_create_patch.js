// routes/bookings/create.js — PR-TAX-1 PATCH
//
// This file documents the EXACT changes to make to routes/bookings/create.js.
// It is NOT a full rewrite — apply these targeted additions to the existing file.
//
// ─────────────────────────────────────────────────────────────────────────────
// CHANGE 1: Add taxEngine import at the top of the file (after ratesEngine import)
// ─────────────────────────────────────────────────────────────────────────────
//
// FIND this existing line (around line 18):
//   const { computeRateForBookingLike } = require("../../utils/ratesEngine");
//
// ADD immediately after it:
//   const { computeTaxForBooking } = require("../../utils/taxEngine");
//
//
// ─────────────────────────────────────────────────────────────────────────────
// CHANGE 2: Add tax computation after charge_amount is determined
// ─────────────────────────────────────────────────────────────────────────────
//
// FIND this existing block (around line 669):
//
//   const charge_amount = (finalCustomerMembershipId || prepaidApplied) ? 0 : price_amount;
//
// ADD the following block immediately after it:
//
// ── PR-TAX-1: Compute tax breakdown ──────────────────────────────────────────
// Tax is computed on the charge_amount (what is actually being charged).
// For membership / prepaid bookings where charge_amount = 0, tax is also 0.
// The full config is stored as an immutable snapshot so historical records
// are never affected by future rate changes.

/*
  let taxData = {
    subtotal_amount:        null,
    vat_amount:             null,
    service_charge_amount:  null,
    total_amount:           null,
    tax_snapshot:           null,
  };

  const taxableAmount = charge_amount;
  if (taxableAmount != null && Number.isFinite(taxableAmount) && taxableAmount > 0) {
    try {
      const taxResult = await computeTaxForBooking({
        tenantId:      resolvedTenantId,
        serviceId:     resolvedServiceId,
        chargedAmount: taxableAmount,
      });
      taxData = {
        subtotal_amount:       taxResult.subtotal,
        vat_amount:            taxResult.vat_amount,
        service_charge_amount: taxResult.service_charge_amount,
        total_amount:          taxResult.total,
        tax_snapshot:          taxResult.snapshot,
      };
    } catch (taxErr) {
      // Non-fatal: tax failure must never block booking creation.
      console.warn("taxEngine non-fatal error (booking create):", taxErr?.message || taxErr);
    }
  }
*/
//
//
// ─────────────────────────────────────────────────────────────────────────────
// CHANGE 3: Check for tax columns and add them to the INSERT
// ─────────────────────────────────────────────────────────────────────────────
//
// FIND this existing line (around line 684):
//   const hasMoneyCols = await ensureBookingMoneyColumns();
//
// ADD after ensureBookingMoneyColumns / ensureBookingRateColumns calls:
//
/*
  // PR-TAX-1: detect tax columns (added by migration 030)
  const hasTaxCols = await (async () => {
    try {
      const r = await db.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name='bookings'
            AND column_name IN ('subtotal_amount','vat_amount','service_charge_amount','total_amount','tax_snapshot')`,
        []
      );
      return r.rows.length >= 5;
    } catch (_) { return false; }
  })();
*/
//
//
// ─────────────────────────────────────────────────────────────────────────────
// CHANGE 4: Extend the INSERT SQL to include tax columns when available
// ─────────────────────────────────────────────────────────────────────────────
//
// FIND the existing INSERT block (around line 776):
//
//   if (hasMoneyCols && hasRateCols) {
//     insertParams = [...baseVals, price_amount, charge_amount, tenantCurrencyCode,
//                    applied_rate_rule_id, applied_rate_snapshot];
//     insertSql = `
//       INSERT INTO bookings
//         (${baseCols}, price_amount, charge_amount, currency_code,
//          applied_rate_rule_id, applied_rate_snapshot)
//       VALUES (${makePlaceholders(insertParams)})
//       RETURNING id;
//     `;
//   }
//
// REPLACE with:
//
/*
  if (hasMoneyCols && hasRateCols && hasTaxCols) {
    insertParams = [
      ...baseVals,
      price_amount, charge_amount, tenantCurrencyCode,
      applied_rate_rule_id, applied_rate_snapshot,
      taxData.subtotal_amount, taxData.vat_amount,
      taxData.service_charge_amount, taxData.total_amount,
      taxData.tax_snapshot ? JSON.stringify(taxData.tax_snapshot) : null,
    ];
    insertSql = `
    INSERT INTO bookings
      (${baseCols}, price_amount, charge_amount, currency_code,
       applied_rate_rule_id, applied_rate_snapshot,
       subtotal_amount, vat_amount, service_charge_amount, total_amount, tax_snapshot)
    VALUES
      (${makePlaceholders(insertParams)})
    RETURNING id;
    `;
  } else if (hasMoneyCols && hasRateCols) {
    insertParams = [...baseVals, price_amount, charge_amount, tenantCurrencyCode,
                   applied_rate_rule_id, applied_rate_snapshot];
    insertSql = `
    INSERT INTO bookings
      (${baseCols}, price_amount, charge_amount, currency_code,
       applied_rate_rule_id, applied_rate_snapshot)
    VALUES
      (${makePlaceholders(insertParams)})
    RETURNING id;
    `;
  } else if (hasMoneyCols) {
    insertParams = [...baseVals, price_amount, charge_amount, tenantCurrencyCode];
    insertSql = `
    INSERT INTO bookings
      (${baseCols}, price_amount, charge_amount, currency_code)
    VALUES
      (${makePlaceholders(insertParams)})
    RETURNING id;
    `;
  } else {
    insertParams = baseVals;
    insertSql = `
    INSERT INTO bookings
      (${baseCols})
    VALUES
      (${makePlaceholders(insertParams)})
    RETURNING id;
    `;
  }
*/
//
//
// ─────────────────────────────────────────────────────────────────────────────
// CHANGE 5: Include tax data in the booking response payload
// ─────────────────────────────────────────────────────────────────────────────
//
// FIND the return res.json({ ... }) success response near the end of the route.
// It currently includes fields like: booking_id, status, price_amount, etc.
//
// ADD to that response object:
//
/*
    tax: {
      subtotal_amount:       taxData.subtotal_amount,
      vat_amount:            taxData.vat_amount,
      service_charge_amount: taxData.service_charge_amount,
      total_amount:          taxData.total_amount,
    },
*/
//
// ─────────────────────────────────────────────────────────────────────────────
// END OF PATCH
// ─────────────────────────────────────────────────────────────────────────────
//
// Summary of changes:
//   1. Import taxEngine
//   2. Compute tax after charge_amount is known (non-fatal)
//   3. Detect tax columns via information_schema (safe on old DBs)
//   4. INSERT tax columns when available (hasTaxCols guard)
//   5. Include tax breakdown in response
//
// All changes are backward-compatible:
//   - Old DBs (pre-migration 030) → hasTaxCols = false, INSERT skips tax cols
//   - Zero-rate tenants → taxData all nulls, stored cleanly
//   - Membership/prepaid bookings → charge_amount = 0 → tax is also 0

module.exports = {};
