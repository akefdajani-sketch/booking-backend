# ✅ SYSTEM_CHECKLIST.md
## BookFlow — Pull Request Quality Gates

> Use this checklist before merging any PR. If any **Critical** item fails, the PR does not ship.

---

## A. Critical Correctness (Must Pass)
- [ ] **Tenant isolation preserved** (all reads/writes tenant-scoped; no cross-tenant leaks)
- [ ] **Booking correctness preserved**
  - [ ] Multi-slot selection still forms a single booking
  - [ ] Duration reflects selected time (slots × slot interval)
  - [ ] Service remains the source of time rules
- [ ] **Availability correctness preserved**
  - [ ] Staff/resource constraints still apply
  - [ ] No UI-invented availability
  - [ ] One source of truth maintained
- [ ] **Membership ledger integrity preserved**
  - [ ] Append-only (no edits/deletes)
  - [ ] Debits/credits consistent under retries (idempotency)

---

## B. Performance & Scale (Must Pass)
- [ ] No unbounded loads (lists/tables/admin views)
- [ ] Pagination/limit enforced for list endpoints
- [ ] No obvious N+1 introduced
- [ ] Indexes considered for new filters/queries

---

## C. UX Truthfulness (Must Pass)
- [ ] UI never lies (“Saved” = saved)
- [ ] Disabled actions explain why
- [ ] Empty states are helpful and intentional
- [ ] Errors are surfaced clearly (no silent failure)

---

## D. Security & Ops (Should Pass)
- [ ] No secrets exposed to client
- [ ] Admin routes protected appropriately
- [ ] Logs are meaningful (no secrets, no spam)

---

## E. Phase Alignment (Must Pass)
- [ ] Change advances **Phase 1 (Commercial v1)** goals
- [ ] No speculative Phase 2/3 work without explicit approval
- [ ] Any tech debt added is documented

---

## F. Release Notes (Required)
- [ ] “What changed / Why / Risk / Not touched” included
- [ ] Test steps included (local + staging/prod smoke test)
