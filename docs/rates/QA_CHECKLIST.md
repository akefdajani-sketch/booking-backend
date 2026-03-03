# Rates v1 — One-page QA checklist + Debug

## A) Owner Rates (CRUD + Preview)
- Load Rates tab
- Create `Base Rate Test` (service-only)
- Create `Peak Hours Test` (time window, higher priority)
- Preview peak/off-peak selects correct winner

## B) Public booking estimate
- No estimate until selections complete
- Estimate updates when switching peak/off-peak
- Quote failures are non-blocking

## C) Confirmation + Details
- Confirmation shows stored totals + currency
- Details modal shows stored totals + snapshot

## D) Historical stability
- Edit peak rule amount
- Existing booking details remain unchanged

## Debug checklist
- Verify frontend calls quote endpoint and payload includes start_time + duration
- Verify booking create response includes price fields
- Verify booking details uses stored booking fields (not live quote)

