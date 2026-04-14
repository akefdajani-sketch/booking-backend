// routes/services/crud.js — PR-TAX-1 PATCH
//
// Add vat_rate, vat_label, and service_charge_rate to both
// the POST (create) and PATCH (update) service endpoints.
//
// This is a targeted patch — apply the changes described below.
// All changes follow the same idempotent column-guard pattern
// already used throughout this file (svcCols.has(...)).
//
// ─────────────────────────────────────────────────────────────────────────────
// CHANGE 1: Add vat_rate / vat_label / service_charge_rate to POST destructure
// ─────────────────────────────────────────────────────────────────────────────
//
// FIND the existing destructure (around line 232):
//
//   const {
//     ...
//     price_per_night,          ← last existing field
//   } = req.body || {};
//
// ADD inside the destructure, after price_per_night:
//
//   // PR-TAX-1: per-service VAT overrides
//   vat_rate,
//   vat_label,
//   service_charge_rate,
//
//
// ─────────────────────────────────────────────────────────────────────────────
// CHANGE 2: Persist vat fields in POST INSERT block
// ─────────────────────────────────────────────────────────────────────────────
//
// FIND the rental block near the end of the INSERT builder (around line 360):
//
//   // RENTAL-1: nightly rental columns
//   if (svcCols.has("booking_mode") && booking_mode !== undefined) {
//     ...
//   }
//
// ADD immediately after that block, before the INSERT query:

/*
  // PR-TAX-1: per-service VAT override columns (added by migration 030)
  if (svcCols.has("vat_rate") && vat_rate !== undefined) {
    add("vat_rate", vat_rate == null ? null : Number(vat_rate));
  }
  if (svcCols.has("vat_label") && vat_label !== undefined) {
    add("vat_label", vat_label == null ? null : String(vat_label).trim().slice(0, 50));
  }
  if (svcCols.has("service_charge_rate") && service_charge_rate !== undefined) {
    add("service_charge_rate", service_charge_rate == null ? null : Number(service_charge_rate));
  }
*/
//
//
// ─────────────────────────────────────────────────────────────────────────────
// CHANGE 3: Add vat fields to PATCH destructure
// ─────────────────────────────────────────────────────────────────────────────
//
// FIND the PATCH endpoint destructure (around line 390):
//   The PATCH endpoint comment says "Body: any of { name, description, ... }"
//
// ADD to the PATCH destructure, alongside the other fields:
//
//   // PR-TAX-1
//   vat_rate,
//   vat_label,
//   service_charge_rate,
//
//
// ─────────────────────────────────────────────────────────────────────────────
// CHANGE 4: Persist vat fields in PATCH UPDATE builder
// ─────────────────────────────────────────────────────────────────────────────
//
// The PATCH endpoint uses a similar dynamic SET builder pattern.
// FIND the section where it conditionally sets columns (the block with
// things like: if (svcCols.has("slot_interval_minutes") && ...) add(...)
//
// ADD after the last existing PATCH field assignment:

/*
  // PR-TAX-1: vat override fields
  if (svcCols.has("vat_rate") && vat_rate !== undefined) {
    add("vat_rate", vat_rate === null ? null : Number(vat_rate));
  }
  if (svcCols.has("vat_label") && vat_label !== undefined) {
    add("vat_label", vat_label === null ? null : String(vat_label).trim().slice(0, 50));
  }
  if (svcCols.has("service_charge_rate") && service_charge_rate !== undefined) {
    add("service_charge_rate", service_charge_rate === null ? null : Number(service_charge_rate));
  }
*/
//
//
// ─────────────────────────────────────────────────────────────────────────────
// CHANGE 5: Include vat columns in the GET SELECT
// ─────────────────────────────────────────────────────────────────────────────
//
// FIND the dynamic column detection for SELECT (around line 50-150 in GET /):
//
//   const slotIntervalExpr = svcCols.has("slot_interval_minutes")
//     ? "s.slot_interval_minutes AS slot_interval_minutes"
//     : "NULL::int AS slot_interval_minutes";
//
// ADD similar expressions after slotIntervalExpr (or the last similar block):

/*
  // PR-TAX-1: per-service VAT overrides
  const vatRateExpr = svcCols.has("vat_rate")
    ? "s.vat_rate AS vat_rate"
    : "NULL::numeric AS vat_rate";
  const vatLabelExpr = svcCols.has("vat_label")
    ? "s.vat_label AS vat_label"
    : "NULL::text AS vat_label";
  const svcChargeRateExpr = svcCols.has("service_charge_rate")
    ? "s.service_charge_rate AS service_charge_rate"
    : "NULL::numeric AS service_charge_rate";
*/
//
// Then ADD to the SELECT column list inside the query string:
//   ${vatRateExpr},
//   ${vatLabelExpr},
//   ${svcChargeRateExpr},
//
//
// ─────────────────────────────────────────────────────────────────────────────
// END OF PATCH
// ─────────────────────────────────────────────────────────────────────────────
//
// Summary:
//   POST /api/services   → accepts vat_rate, vat_label, service_charge_rate
//   PATCH /api/services/:id → accepts and persists them
//   GET /api/services    → returns them (NULL if columns not yet added)
//
// Backward safety:
//   All additions are guarded by svcCols.has("vat_rate") which checks via
//   information_schema at runtime. Old DBs (pre-migration 030) silently skip
//   these fields without error.

module.exports = {};
