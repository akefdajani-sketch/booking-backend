# 📦 RELEASE_CHECKLIST.md
## BookFlow Release Procedure (Frontend + Backend)

Goal: ship safely, no tenant regressions, no booking correctness regressions.

---

## A) Pre-Release (Required)
- [ ] PR merged to `main` (or release branch)
- [ ] CI is green
- [ ] Change aligns with `SYSTEM.md`
- [ ] PR passes `SYSTEM_CHECKLIST.md`

---

## B) Backend Release (Render)
1) [ ] Confirm env vars unchanged or intentionally updated
2) [ ] Deploy backend (Render)
3) [ ] Smoke test API (tenant-scoped):
   - [ ] List endpoints return expected results
   - [ ] Booking creation works for a test tenant
   - [ ] Membership debit/credit flows unchanged (if touched)
4) [ ] Check logs for errors (no secrets)

Rollback:
- [ ] Roll back Render to previous deploy on critical failures

---

## C) Frontend Release (Vercel)
1) [ ] Confirm env vars correct (`NEXT_PUBLIC_*`)
2) [ ] Deploy frontend (Vercel)
3) [ ] Smoke test:
   - [ ] Login redirect valid (no `/book/undefined`)
   - [ ] Public booking page loads for a tenant slug
   - [ ] Services/staff/resources display as expected
   - [ ] Theme loads correctly (no gray default UI)
4) [ ] Check Vercel logs for runtime errors

Rollback:
- [ ] Roll back Vercel to previous deployment on critical failures

---

## D) Post-Release (Required)
- [ ] Confirm at least one end-to-end booking flow works
- [ ] Create git tags:
  - `frontend-vX.Y.Z`
  - `backend-vX.Y.Z`
- [ ] Update `PHASE_1_STATUS.md` and/or `PHASE_1_EXIT.md` progress
