# 🤝 CONTRIBUTING.md
## BookFlow Backend — Contribution Rules

This repository is governed by **SYSTEM.md**. Read it first.

---

## Golden Rules
1) Tenant isolation is sacred  
2) Booking correctness beats convenience  
3) Membership ledger is append-only  
4) Prefer constraints + transactions for correctness  
5) Phase 1 focus: sellability + stability  

---

## Branching & PRs
Branch naming:
- `fix/...`
- `feat/...`
- `perf/...`
- `docs/...`

Every PR must include:
- What changed / Why / Risk / Not touched
- Test steps
- Confirmation that `SYSTEM_CHECKLIST.md` passes

---

## Local Development
> Keep these aligned with `package.json` scripts.

- Install: `npm install`
- Dev: `npm run dev` (or your nodemon script)
- Test: `npm test` (if present)

---

## Data & Migrations
- Constraints preferred over app-only enforcement.
- Any change to bookings/availability/memberships must include:
  - Test cases or SQL verification steps
  - Clear rollback plan

---

## Documentation
Any meaningful behavior change must update at least one:
- SYSTEM.md
- SYSTEM_CHECKLIST.md
- PHASE_1_EXIT.md
- RELEASE_CHECKLIST.md
