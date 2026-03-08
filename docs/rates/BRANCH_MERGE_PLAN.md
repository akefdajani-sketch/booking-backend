# Branch / merge / deploy plan — Rates v1

## Merge order
1. **PR-RATES-1 (backend)** → deploy on Render
2. **PR-RATES-2 (owner UI)** → deploy owner dashboard on Vercel
3. **PR-RATES-3 (public booking UI + modals)** → deploy booking frontend on Vercel

## Gates
### Gate A (after backend deploy)
- `POST /api/public/:slug/pricing/quote` returns `{ adjusted_price_amount, currency_code, applied_rate_snapshot }`
- Booking create returns price fields
- Booking read/list return price fields

### Gate B (after owner UI deploy)
- Rates list loads, CRUD works, preview works

### Gate C (after public booking deploy)
- Estimate shows only when selections complete
- Confirmation + details show stored totals
- Historical stability verified (rate edits do not change existing booking totals)

