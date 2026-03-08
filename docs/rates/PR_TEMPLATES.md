# GitHub PR Templates — Rates v1

## PR-RATES-1 — Backend foundation

```md
# PR-RATES-1 — Rates v1 Backend Foundation

## Summary
Implements the backend pricing foundation for Rates v1:
- Deterministic rate evaluation (“winning rule”)
- Public quote endpoint for pricing estimates
- Booking creation stores final price + pricing snapshot
- Booking read/list endpoints return pricing fields required by UI

## Changes
- Pricing engine returns winning rule + total + snapshot/breakdown
- Added public pricing quote endpoint: `POST /api/public/:slug/pricing/quote`
- Booking create recomputes price server-side and persists:
  - `price_amount`
  - `charge_amount`
  - `currency_code`
  - `applied_rate_rule_id`
  - `applied_rate_snapshot`
- Booking read payload includes pricing fields (joined booking by id)
- Booking list payload includes pricing fields (for tenant ops + modals)

## Files Touched
- `utils/ratesEngine.js`
- `routes/publicPricing.js`
- `routes/bookings.js`
- `utils/bookings.js`
- `app.js`

## QA Steps
- Rates preview works (service-only, peak override)
- Quote endpoint returns computed price
- Booking create returns pricing fields
- Booking read/list include pricing fields

## Rollback Plan
- Revert endpoint wiring + response additions
- DB columns are safe to leave in place
```

## PR-RATES-2 — Owner UI
(Implemented in booking-frontend)

## PR-RATES-3 — Public booking + modals
(Implemented in booking-frontend)

