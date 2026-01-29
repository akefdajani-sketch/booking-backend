# 🚀 PHASE_1_EXIT.md
## BookFlow — Phase 1 (Commercial v1) Exit Criteria

> Phase 1 is complete when a business can onboard, operate, and take bookings with **no founder intervention**.

---

## 1) Booking Engine (Go/No-Go)
- [ ] Public booking works end-to-end for a tenant
- [ ] Owner manual booking works end-to-end
- [ ] Multi-slot selection produces one booking correctly
- [ ] Cancel / confirm flows behave correctly
- [ ] No “undefined tenant” routing failures

---

## 2) Availability & Service Slot Rules
Service-level time controls must be supported:
- [ ] `session_duration_minutes`
- [ ] `slot_interval_minutes`
- [ ] `max_consecutive_slots`

And enforced in availability + booking creation:
- [ ] Resource requirement enforced when applicable
- [ ] Staff working hours respected
- [ ] Overlaps prevented (DB + app)

---

## 3) Memberships (Ledger-Safe)
- [ ] Plans can be created and assigned
- [ ] Usage correctly debits ledger
- [ ] Ledger is append-only and auditable
- [ ] Edge cases tested (expiry, insufficient credits)

---

## 4) Owner Experience (Sellability)
- [ ] Setup UX is structured (tabs/sections, not endless scroll)
- [ ] Bookings list is fast, filtered, paginated
- [ ] Add booking UI is coherent (customer block aligned)
- [ ] Theme/branding feels SaaS-grade (no gray “admin default”)

---

## 5) Reliability & Observability
- [ ] UI surfaces errors clearly
- [ ] Backend logs identify tenant + route
- [ ] Health check path exists (basic)
- [ ] No critical issues requiring manual DB intervention

---

## 6) Commercial Foundations
- [ ] Pricing tiers defined and enforceable (even if manually enforced at first)
- [ ] Trial / onboarding SOP exists
- [ ] Support SOP exists (basic)

---

# Phase 1 Sign-Off (Go/No-Go)
Date:
Release tags:
- Frontend:
- Backend:

Sign-off:
- [ ] GO (Phase 1 complete)
- [ ] NO-GO (blocking items remain)

Blocking items (if NO-GO):
1)
2)

Owner/CTO Sign-off:
Name:
