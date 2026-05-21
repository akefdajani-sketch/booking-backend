# Phase 1 Pre-Flight — `routes/bookings/create.js` Refactor Audit

**Scope:** read-only. File is 1680L, single `router.post("/")` handler (L33–L1680). No top-level helpers except in-handler `makePlaceholders` (L936).

---

## 1. Pipeline map (numbered stages, line ranges)

1. **Pre-flight schema ensure** — L34–37 (`ensureBookingMoneyColumns`)
2. **Body destructure / input parse** — L39–68
3. **Tenant + auth resolution** — L70–94 (`slug`, `resolvedTenantId`, `idemKey`, `isAdminBypass`, `googleEmail/Name`, `requestedCustomerEmail`)
4. **Field validation (startTime)** — L96–98
5. **require-phone policy load** — L100–113
6. **Customer resolve/create** — L115–165 (DB `INSERT customers` on miss)
7. **Nightly startTime derivation + past-check** — L167–189
8. **Service resolution** — L191–274 (duration, price, `requires_confirmation`, currency, `max_parallel`)
9. **bookingStatus + staff/resource validation** — L276–298
10. **Blackout overlap check** — L300–316
11. **Conflict check** — L318–333 (`checkConflicts`)
12. **Gate A — working-hours validation (PR 149)** — L335–380
13. **TRANSACTION BEGIN** — L382–384
14. **Customer alias cleanup** — L386–391
15. **Membership/prepaid state init** — L393–403 (`membershipPolicy` loaded)
16. **Membership eligibility guard** — L405–438 (`getServiceAllowMembership`)
17. **Auto-consume membership selection** — L440–501 (`FOR UPDATE`)
18. **Explicit `customerMembershipId` resolution** — L503–562 (`FOR UPDATE`)
19. **Prepaid resolution** — L564–608
20. **Price computation** — L610–650 (nightly × nights vs timeslot proportional)
21. **Rates engine application** — L652–722 (`computeRateForBookingLike`)
22. **charge_amount derivation** — L724
23. **Gate B — require-charge (PR 149)** — L726–755
24. **Tax computation (PR-TAX-1)** — L757–767
25. **payment_method derivation (PAY-INTENT-1)** — L769–797
26. **payment_status derivation (CLIQ-CONFIRM-1)** — L799–818
27. **Column-existence detection** — L820–847 (money/rate/payment_method/payment_status/tax)
28. **Session find/create (parallel services)** — L851–876
29. **Nightly/addon column detect + addon parse** — L878–899
30. **Dynamic INSERT build** — L901–986 (`extraCols`, `baseVals`, `makePlaceholders`, 4 SQL branches)
31. **Booking INSERT execute** — L988–989
32. **network_payment linkage (PAY-FIX)** — L991–1011
33. **Session count increment** — L1013–1020
34. **INSERT error handler** — L1021–1065 (23505 idempotency replay, 23P01 exclusion)
35. **Booking code generation** — L1067–1119
36. **Booking code UPDATE** — L1121–1126
37. **Membership ledger debit + balance + expiry** — L1128–1273
38. **Prepaid redemption + entitlement + transaction** — L1275–1347
39. **COMMIT** — L1349
40. **Post-commit bump + load joined booking** — L1351–1364
41. **WhatsApp confirmation (`setImmediate`)** — L1366–1447
42. **SMS confirmation (`setImmediate`)** — L1449–1558
43. **Email confirmation (`setImmediate`)** — L1560–1629
44. **AI context cache bust (VOICE-PERF-1)** — L1631–1644
45. **Response** — L1646–1666
46. **Tx catch/rollback + `finally` release** — L1667–1672
47. **Outer catch → 500** — L1673–1678

---

## 2. Stage → April-7-module mapping

| Module | Stages (line ranges) | Notes |
|---|---|---|
| **validate.js** | 2,3,4,5,7,9 (L39–98, L100–113, L167–189, L276–298) | Pure validation + parse. Runs **before** BEGIN. |
| **resolveAvailability.js** | 8,10,11,12 (L191–274 service load, L300–380 blackout/conflict/Gate A) | Service resolution feeds availability; all **before** BEGIN. |
| **resolveEntitlement.js** | 15,16,17,18,19 (L393–608) | **Inside** tx; `FOR UPDATE` locks. Produces `finalCustomerMembershipId`, `debitMinutes/Uses`, `prepaidApplied`, `membershipBefore`. |
| **computePricing.js** | 20–26 (L610–818) | **Inside** tx. Consumes entitlement outputs. Gate B + tax + payment_method/status. |
| **persist.js** | 27–38 (L820–1347) | **Inside** tx. INSERT build/exec, error handler, booking code, ledger debit, prepaid redemption writes. Largest module. |
| **dispatchPayment.js** | 32 only (L991–1011, PAY-FIX) | **Near-empty — see flag.** |
| **dispatchNotifications.js** | 41,42,43,44 (L1366–1644) | **After** COMMIT. `setImmediate` fire-and-forget. |

**Stages that don't cleanly fit:**
- **Stage 6 Customer resolve/create (L115–165)** — does a DB `INSERT`, so not pure `validate`; but runs *before* BEGIN so not `persist` either. Needs its own `resolveCustomer.js` or an explicit pre-transaction step in the orchestrator.
- **Stage 1 + Stage 27 schema-ensure / column detection** — `ensureBooking*Columns` and `information_schema` probes are scattered across pre-flight, service load, and persist. Cross-cutting; should be hoisted to a shared `schemaGuards` helper, not duplicated per module.
- **Stage 35–36 Booking code generation** — folded into `persist` here, but it's a self-contained unit (atomic `booking_seq` bump) and could be its own file.
- **dispatchPayment** — there is **no Stripe/MPGS handoff** in create.js. Payment is intent-only (method/status columns) + linking a *pre-existing* `network_payment` row. The April module has almost nothing to own.

---

## 3. The +198 lines (1482 → 1680)

Growth is concentrated in **computePricing** and **persist**, and is almost entirely **post-April payment patches**, not new domain logic:

- **CLIQ-CONFIRM-1 (May 4, 2026)** — `payment_status` derivation (L799–818, ~20L), `hasPaymentStatusCol` probe (L824–834, ~11L), `extraCols`/`baseVals` wiring (L902–903, L919). → lands in **computePricing** + **persist**. ~35L.
- **PAY-INTENT-1 (May 4, 2026)** — rewrote `payment_method` ternary; the change is small but carries a ~22-line explanatory comment block (L775–797). → **computePricing**. ~25L.
- **Membership-insufficient `resolution` IIFE (L1214–1237, ~24L)** — accreted error-path payload builder inside the post-debit balance check. → **persist**.
- **PAY-FIX network_payment linkage (L991–1011, ~21L)** — → the otherwise-empty **dispatchPayment**.
- Remainder spread across **NIGHTLY SUITE** addon parsing/columns (L884–930) and the 4-branch INSERT growth from tax columns (PR-TAX-1).

**Verdict:** the +198 are accreted patches + comment blocks, not a new pipeline phase. No stop-condition triggered (see §6).

---

## 4. Coupling map

**Top-scope closure variables** (declared in handler, crossing module boundaries):

- *Pre-BEGIN, read by everything:* `slug`, `resolvedTenantId`, `idemKey`, `isAdminBypass`, `googleEmail/Name`, `requestedCustomerEmail`, `req`, `res`.
- *Set by validate/availability, read downstream:* `finalCustomerId/Name/Phone/Email`, `isNightlyBooking`, `resolvedStartTime`, `start`, `end`, `resolvedServiceId`, `duration`, `requiresConfirmation`, `serviceDurationMinutes`, `servicePriceAmount`, `serviceMaxParallel`, `tenantCurrencyCode`, `staff_id`, `resource_id`, `bookingStatus`, `bookingPolicy`.
- *Set by resolveEntitlement, read by computePricing + persist:* `finalCustomerMembershipId`, `debitMinutes`, `debitUses`, `prepaidApplied`, `membershipBefore`, `membershipPolicy`.
- *Set by computePricing, read by persist:* `price_amount`, `charge_amount`, `applied_rate_rule_id`, `applied_rate_snapshot`, `taxData`, `payment_method`, `payment_status`, `has*Cols`.
- *Set by persist, read by notifications/response:* `bookingId`, `created`, `bookingCode`, `joined`.

**Transaction state** — `client` (from `db.connect()`, L382) must be passed to **resolveEntitlement, computePricing, persist** (all inside BEGIN…COMMIT). Orchestrator owns BEGIN/COMMIT/ROLLBACK. validate/availability/notifications use the pool `db`, not `client`.

**Mid-handler exits (19 ROLLBACK points), by module:**
- **resolveEntitlement: 14** — L420, L428, L442, L473, L495, L508, L524, L532, L537, L557, L571, L576, L589, L596. *Highest error-path surface by far.*
- **computePricing: 1** — L747 (Gate B).
- **persist: 4** — L869 (session full), L1048 (23P01), L1137 (zero-delta debit), L1209 (insufficient balance post-debit).
- validate / availability: 0 ROLLBACKs (they run before BEGIN; they `return` directly).

Each extracted in-tx module must **not** call `ROLLBACK` itself — it should throw or return a typed error and let the orchestrator roll back. This is the single biggest behavioral change the refactor forces.

**In-handler-only helper:** `makePlaceholders` (L936) — trivial; hoist into `persist.js` (local scope) or `utils/sqlHelpers`. Not worth a shared util on its own.

---

## 5. Test gap measurement

**Confirmed:** `__tests__/bookings.test.js` is 30 lines, mocks `checkConflicts` + `loadJoinedBookingById`, and posts `{ tenantSlug:'t1', tenantId:999 }`. With `requireTenant` mocked to a pass-through, `req.tenantId` is undefined → handler returns 400 at **L73 ("Invalid tenant")** — the test never reaches the mocked functions, BEGIN, or any pipeline stage. **Effective create-path coverage today is zero.**

**Adjacent files audited — none touch the create handler:**
- `availability.test.js` → tests `routes/availability` only.
- `memberships_errorhandler.test.js` → `routes/membershipPlans.js`, `middleware/errorHandler.js`, `utils/tenants.js`.
- `planEnforcement.test.js` → `utils/planEnforcement.js`.
- `contractInvoices.test.js`, `networkPayments.test.js`, `staff_resources.test.js`, etc. → all hit other routes (`grep` of `.post(` confirms no `/api/bookings` POST outside `bookings.test.js`).

**Biggest behavior-preservation holes — need 3–5 tests before any extraction:**
1. **Happy-path timeslot create** — service with price → 201, `price_amount`/`charge_amount`/`payment_method` correct, booking code formatted.
2. **Happy-path membership-covered create** — auto-consume path debits ledger, `charge_amount=0`, `payment_method='membership'`.
3. **Happy-path nightly create** — `booking_mode='nightly'`, price = `price_per_night × nights`, Gate A skipped.
4. **Idempotency replay race** — same `idemKey` twice → second returns 200 + `replay:true`, no double ledger debit (covers L1021–1033 + L1162–1165).
5. **Conflict / insufficient-membership race** — `checkConflicts` returns conflict → 409; membership with insufficient balance → 409 with resolution payload (covers the 14 resolveEntitlement ROLLBACKs).

---

## 6. Numbered extraction plan (dependency order, safest first)

| # | Module | Rationale | Risk |
|---|---|---|---|
| 1 | **dispatchNotifications.js** | Runs entirely **after COMMIT** in `setImmediate`; no shared mutable state read back; only reads `joined`, `slug`, `resolvedTenantId`, `created`, `bookingId`. Zero ROLLBACKs. | **low** |
| 2 | **validate.js** | Runs **before BEGIN**; pure parse + validation, returns typed errors. No `client`, no ROLLBACKs. Caveat: must extract `resolveCustomer` (L115–165) separately since it writes. | **low** |
| 3 | **resolveAvailability.js** | **Before BEGIN**; service load + blackout + conflict + Gate A. Read-only DB via pool. No ROLLBACKs. Outputs are plain values. | **low–med** |
| 4 | **dispatchPayment.js** | Tiny (PAY-FIX linkage only, L991–1011). Inside tx but single non-fatal `UPDATE`. Decide whether it survives as a module or folds into persist. | **med** |
| 5 | **computePricing.js** | Inside tx; consumes entitlement outputs one-directionally; only 1 ROLLBACK (Gate B). Pure-ish math + 2 non-fatal engine calls. | **med** |
| 6 | **resolveEntitlement.js** | Inside tx; **14 ROLLBACK points** + `FOR UPDATE` locks + idempotent debit semantics. Every exit must convert to throw/typed-return. Highest error-path surface. | **high** |
| 7 | **persist.js** | Inside tx; 4 ROLLBACKs, dynamic 4-branch INSERT, 23505/23P01 error handler, booking-code atomicity, ledger + prepaid writes. Largest blast radius; extract last with full test net. | **high** |

---

## Stop-condition check — none triggered, proceeding

- **Module boundaries drawable?** Yes. `resolveEntitlement` → `computePricing` is a clean one-directional dependency (`finalCustomerMembershipId`/`prepaidApplied` are inputs to pricing, never written back). They are separable.
- **+198 lines break April design?** No. They are PAY-INTENT-1 / CLIQ-CONFIRM-1 / accreted error payloads — payment **intent recording**, not a new pre-auth phase. They fit `computePricing` + `persist`.
- **Test coverage materially different from 30-line baseline?** It is *slightly worse* than implied (the mocked fns are never reached — coverage is effectively zero), but not materially enough to halt. Flagging here for awareness; recommend the 5 tests in §5 land before extraction #5–#7.

**Two design notes for review (not blockers):** (a) `dispatchPayment` is near-empty — consider dropping it or merging into `persist`; (b) schema-guard probes (`ensure*Columns`, `information_schema`) are cross-cutting and should be consolidated into one helper rather than split across modules.
