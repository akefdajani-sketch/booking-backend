# File-Size Audit — May 17, 2026

**Audited by:** S1 (parallel session, read-only)
**Branch:** `audit/file-size-and-flexrz-auth-2026-05-17` (off `origin/main`)
**Baseline:** May 10, 2026 hot list (from session brief) + cross-checked against `audit/2026-05-14/booking-backend.md`
**Scope:** `.js`, `.jsx`, `.ts`, `.tsx` — excluding `node_modules`, `.git`, `dist`, `build`, `coverage`, `audit/`, `migrations/`, `.next/`

Buckets:
- 🟢 Green: < 200L
- 🟡 Yellow: 200–400L
- 🟠 Orange: 400–600L
- 🔴 Red: 600–800L
- 🚨 Critical: > 800L

---

## Summary

| | Backend | Frontend |
|---|---:|---:|
| Total files scanned | 281 | 789 |
| 🟢 Green (<200L) | 133 | 514 |
| 🟡 Yellow (200–400L) | 105 | 193 |
| 🟠 Orange (400–600L) | 31 | 68 |
| 🔴 Red (600–800L) | 5 | 12 |
| 🚨 Critical (>800L) | 7 | 2 |
| **% in Orange or worse** | **15.3%** | **10.4%** |

**Headline:** The Phase 1 refactor of `routes/bookings/create.js` (1680L → 358L) is the single biggest debt-paydown in two months. The frontend is structurally unchanged since May 10 — all known offenders are still at exactly the same line count, meaning recent work has been backend-only (Phase 2 voice agent).

---

## Backend hot list

(non-test, non-script files only — tests and scripts called out separately below)

| File | Lines | Δ vs May 10 | Status | Extraction notes |
|---|---:|---|---|---|
| `routes/ai.js` | 1401 | +61 (+4.5%) from 1340 | 🚨 | Phase 2.3 added orchestrator branch (+32). Still the #1 surface to split — extract `handleAction`, slot-cache helpers, and the chat route handler into separate modules. `bookingBrain` and `voicePersona` already pulled out; remaining 1400L is still in one file. |
| `utils/contracts.js` | 950 | 0 (stable) | 🚨 | Untouched since May 14 audit. Candidate split: contract CRUD, invoice generation, status transitions, PDF helpers. |
| `routes/bookings/crud.js` | 903 | 0 (stable) | 🚨 | Bookings list/get/stats. Stats endpoints should split into `bookings/stats.js`; remaining read paths are coherent. |
| `utils/claudeService.js` | 901 | +73 (+8.8%) from 828 | 🚨 | Phase 2.3 added orchestrator wiring (+69). Move long inline prompts to `.md` files in `utils/prompts/`, then split `model selection / context assembly / streaming` into sub-modules. |
| `routes/tenants/core.js` | 819 | 0 (stable) | 🚨 | Already partially split (`tenants/media.js`, `tenants/content.js`, `tenants/publish.js` exist). Remaining surface = identity + feature flags + onboarding. Pull `features` and `onboarding` next. |
| `utils/voiceContext.js` | 676 | 0 (stable; new entrant May 14) | 🔴 | Voice agent context assembly. Likely splits along role boundaries: customer-facing context, owner-facing context, prompt assembly helpers. |
| `theme/resolveTenantAppearanceSnapshot.js` | 668 | not on May 10 list | 🔴 | New entrant. Theme snapshot resolution is monolithic — split into `palette resolver`, `typography resolver`, `tokens emitter`. |
| `routes/contractInvoicePaymentLinks.js` | 632 | 0 (stable; new entrant May 14) | 🔴 | Payment link issuance + webhook handling. The MPGS-hosted-checkout TODO from May 14 may push this past 700L when implemented — split *before* the next feature. |
| `routes/stripeWebhook.js` | 606 | 0 (stable; new entrant May 14) | 🔴 | Stripe webhook handler. CLAUDE.md flags the `express.raw()` body coupling — extract per-event-type handlers but keep the raw-body gate in the route file. |

### Tests (kept for awareness, not Phase-3/4 targets)

| File | Lines | Status | Notes |
|---|---:|---|---|
| `__tests__/bookings_create.test.js` | 1076 | 🚨 | Mirrors the refactored route's history; can be split once the test surface stabilises. |
| `__tests__/voice_persona.test.js` | 643 | 🔴 | New (Phase 2.2). |
| `__tests__/booking_brain.test.js` | 572 | 🟠 | New (Phase 2.1). |
| `__tests__/contractInvoices.test.js` | 539 | 🟠 | |
| `__tests__/contractS3d.test.js` | 532 | 🟠 | |
| `__tests__/ai_voice_chat.test.js` | 461 | 🟠 | |
| `__tests__/contracts.test.js` | 442 | 🟠 | |
| `__tests__/voice_two_query.test.js` | 421 | 🟠 | |

### Scripts (kept for awareness)

| File | Lines | Notes |
|---|---:|---|
| `scripts/birdie-data-snapshot.js` | 847 | One-off data script; orange-by-purpose, not Phase target. |
| `scripts/themes_v2/01_audit_theme_sync.js` | 477 | Theme v2 pipeline step; series of similar siblings. |

### Backend Orange tier (400–600L, non-test, non-script) — early-warning list

`utils/ratesEngine.js` (564), `routes/services/crud.js` (559), `utils/availabilityEngine.js` (549), `utils/bookingBrain.js` (534, Phase 2.1 new), `routes/tenantDomains.js` (533), `utils/voicePromptGenerator.js` (527), `routes/publicTenantTheme.js` (520), `theme/contractThemeRegistry.js` (516), `routes/rentalPaymentLinks.js` (514), `routes/customerMemberships/list.js` (496), `utils/bookings.js` (490), `routes/tenants/media.js` (483), `routes/voice.js` (471), `utils/twilioSms.js` (454), `utils/contractPdf.js` (449), `utils/reminderEngine.js` (444), `routes/customers/meMemberships.js` (442), `utils/bookingRouteHelpers.js` (440), `routes/tenantUsers/invites.js` (438), `routes/tenantRates.js` (419), `routes/bookings/persist.js` (414), `utils/voicePersona.js` (407, Phase 2.2 new), `routes/ownerDashboard.js` (405).

---

## Frontend hot list

| File | Lines | Δ vs May 10 | Status | Extraction notes |
|---|---:|---|---|---|
| `components/tenant/ops/contracts/CreateContractModal.tsx` | 1119 | 0 (stable) | 🚨 | Phase 3 target. Splits: form-state hook, validation, party-details section, terms section, review section. |
| `components/owner/tabs/setup/sections/GeneralSection.tsx` | 898 | 0 (stable) | 🚨 | Was flagged as fastest-growing offender (217%/month) — has *not* grown since May 10. Phase 4 setup-tab target. Splits: business info, policy, branding, advanced. |
| `components/owner/tabs/setup/sections/TwilioSetupPanel.tsx` | 795 | 0 (stable) | 🔴 | Phase 4 target. Splits: credentials, sender config, template editor, send-test. |
| `components/shared/appearance/ThemeStudioPanelUnified.tsx` | 718 | 0 (stable) | 🔴 | Splits: palette editor, typography editor, preview pane, persistence. |
| `components/tenant/ops/contracts/ContractDetailDrawer.tsx` | 710 | 0 (stable) | 🔴 | Phase 3 target. Splits: summary card, line items, payments, activity. |
| `components/owner/customers/CustomerPurchasesPanel.tsx` | 683 | not on May 10 list | 🔴 | **New 🔴 entrant.** Customer purchases aggregation panel. |
| `components/booking/home/templates/WellnessEditorialTemplate.tsx` | 671 | not on May 10 list | 🔴 | **New 🔴 entrant.** Public booking template — likely repeatable pattern across templates; extract shared sub-components into `home/templates/_shared/`. |
| `components/owner/customers/CustomerDetailDrawer.tsx` | 660 | not on May 10 list | 🔴 | **New 🔴 entrant.** Same family as `ContractDetailDrawer` — same split pattern applies. |
| `components/booking/BookingHistory.tsx` | 653 | not on May 10 list | 🔴 | **New 🔴 entrant.** Customer-facing history view. |
| `components/owner/tabs/OwnerCustomersTab.tsx` | 644 | not on May 10 list | 🔴 | **New 🔴 entrant.** Tab shell — should be a thin router over the customer panels. |
| `components/owner/tabs/setup/sections/ServicesSection.tsx` | 626 | 0 (stable) | 🔴 | Phase 4 target. |
| `app/book/[slug]/setup/sections/ImagesSection.tsx` | 623 | 0 (stable) | 🔴 | |
| `components/booking/useElevenLabsAgent.ts` | 608 | not on May 10 list | 🔴 | **New 🔴 entrant.** ElevenLabs voice agent hook — split into transport, session, transcript handlers. |
| `lib/booking/publicBooking/useBookingSubmit.ts` | 604 | not on May 10 list | 🔴 | **New 🔴 entrant.** Public booking submit hook. |
| `components/owner/tabs/setup/hooks/useOwnerSetupMembershipsState.ts` | 574 | not on May 10 list | 🟠 | |
| `components/owner/dashboard/blocks/registry.tsx` | 564 | 0 (stable) | 🟠 | |

### Frontend Orange tier (400–600L) — early-warning list (top entries only)

`BookTab.tsx` (562), `NightlyBookingFormCard.tsx` (557), `BookingPolicyCard.tsx` (556), `MembershipPurchaseModal.tsx` (548), `PackagePurchaseModal.tsx` (546), `BookingFieldSelectors.tsx` (541), `NightlyBookingFormCardAtoms.tsx` (530), `AppearanceSection.tsx` (526), `pay-invoice/[token]/page.tsx` (525), `WeekViewGrid.tsx` (519), `PremiumLayout.tsx` (519), `TenantOpsMaintenanceTab.tsx` (514), `MyPackagesSection.tsx` (513), `PublicBookingContent.tsx` (512), `useTenantOpsPageModel.ts` (508), `BookingFormCard.tsx` (507), `BookingDetailsModal.tsx` (506), `CategoriesSection.tsx` (503), `StaffSection.tsx` (502), `useTeamSchedule.ts` (499), `BookingDetailsCard.tsx` (499), `ManualBookingForm.tsx` (499), `CategoriesSection.tsx` (498), `book/[slug]/page.tsx` (498), `OwnerSetupTab.tsx` (493), `DateRangePicker.tsx` (489), `HomeLandingEditorSection.tsx` (484), `ConfirmationModal.tsx` (482), `TaxSection.tsx` (478), `ThemeStudioPanel.tsx` (477), `ImageUpload.tsx` (477), `RenewContractModal.tsx` (476), `pay/[token]/page.tsx` (474), `useTenantOpsMutations.ts` (470), `ResourcesSection.tsx` (470), `TeamPermissionsSection.tsx` (467), `ImageSelect.tsx` (467), `PackagesTabCards.tsx` (467), `sectionContexts.ts` (460), `PublicBookingClient.tsx` (460), `CustomerPackagesSection.tsx` (457), `MyMembershipSection.tsx` (457), `CustomerMembershipsSection.tsx` (451), `EmailLogPanel.tsx` (443), `OwnerTenantPageClient.tsx` (441), `TenantEmailLogPanel.tsx` (440), `prototype/page.tsx` (438), `MembershipsSection.tsx` (435), `RatesSection.tsx` (433), `TenantDebugClient.tsx` (433), `NotificationToggleMatrix.tsx` (431), `useOwnerBookingsState.ts` (429), `LandingPage.tsx` (429), `useMembershipsSectionState.tsx` (428), `ServiceListItem.tsx` (427), `useSetupStaff.ts` (426), `OwnerTeamAccessTab.tsx` (426), `useSetupResources.ts` (425), `api/proxy/[...path]/route.ts` (425), `PaymentsSection.tsx` (423), `tenantCssVars.ts` (422), `BlockInspector.tsx` (415), `resolveLandingData.ts` (413), `types.ts` (406).

---

## Growth offenders (>20% growth since May 10)

| File | May 10 | May 17 | Growth | Risk |
|---|---:|---:|---:|---|
| *(none)* | — | — | — | No file in this audit has grown >20% since May 10. |

**Modest growth — flagged for trend, below the 20% threshold:**

| File | May 10 | May 17 | Growth | Note |
|---|---:|---:|---:|---|
| `utils/claudeService.js` | 828 | 901 | +8.8% | Phase 2.3 orchestrator wiring. Was on May 14 baseline at 834 — most of the growth is May 14 → May 17. |
| `routes/ai.js` | 1340 | 1401 | +4.5% | Phase 2.3 orchestrator branch. Was on May 14 baseline at 1367. |

**The fast-growing offenders flagged on May 10 (especially `GeneralSection.tsx` at +217%/month) have flatlined — frontend work paused for the Phase 2 voice agent push.**

---

## Files no longer hot (improved since May 10)

| File | May 10 | May 17 | Delta | Status change |
|---|---:|---:|---:|---|
| `routes/bookings/create.js` | 1680 | 358 | **−1322 (−78.7%)** | 🚨 → 🟡 ✅ |

Phase 1 refactor (7 PRs) split `bookings/create.js` into:
- `routes/bookings/create.js` (358L) — entry point
- `routes/bookings/persist.js` (414L)
- `routes/bookings/dispatchNotifications.js` (331L)
- `routes/bookings/resolveEntitlement.js` (343L)
- `utils/bookingRouteHelpers.js` (440L)
- `utils/bookingPolicy.js` (324L)

Net: the original 1680L is now ~2210L distributed across 6 focused files, all under the 🔴 threshold. **This is the model for Phase 3/4 splits.**

---

## Recommended Phase 3 / Phase 4 targets

### Phase 3 — Contracts surface (frontend)

Targets ranked by impact, with proposed extraction order:

1. **`CreateContractModal.tsx` (1119L 🚨)** — biggest single offender. Order:
   1. Extract `useCreateContractForm` hook → form-state + validation
   2. Extract `<PartyDetailsSection>`, `<TermsSection>`, `<ReviewSection>` children
   3. Extract `<ContractCreationStepper>` shell
   4. Modal file should drop to ~250–300L
2. **`ContractDetailDrawer.tsx` (710L 🔴)** — same family, same pattern:
   1. Extract `<ContractSummaryCard>`, `<LineItemsList>`, `<PaymentsTimeline>`, `<ActivityFeed>`
   2. Should drop to ~200L
3. **`RenewContractModal.tsx` (476L 🟠)** — share the hooks from #1; consolidate the create/renew form logic in one place.

### Phase 4 — Owner setup tabs (frontend)

Targets ranked by impact:

1. **`GeneralSection.tsx` (898L 🚨)** — split into `BusinessInfoCard`, `PolicyCard`, `BrandingCard`, `AdvancedCard` (already partially started — `BookingPolicyCard.tsx` exists at 556L).
2. **`TwilioSetupPanel.tsx` (795L 🔴)** — split into `CredentialsCard`, `SenderConfigCard`, `TemplateEditorCard`, `SendTestPanel`.
3. **`ServicesSection.tsx` (626L 🔴)** — split into `ServicesList`, `ServiceFormDrawer`, `ServiceAdvancedCard`.

### Phase 5 (proposed) — Backend AI surface

`routes/ai.js` is now the lone 1400L+ offender in the backend. Suggested order:

1. Extract `handleAction` → `utils/aiActionDispatch.js`
2. Extract slot-cache helpers → `utils/aiSlotCache.js`
3. Split chat route handler → `routes/ai/chat.js`
4. Long Anthropic prompts in `utils/claudeService.js` → `utils/prompts/*.md` loaded at boot

Target: `routes/ai.js` under 400L (yellow), `utils/claudeService.js` under 500L.

---

## Methodology notes

- Line counts via `wc -l` on raw source files (includes blank lines and comments).
- May 10 baseline taken from the session brief (no `audit/2026-05-10/` folder exists in-repo).
- May 14 cross-check via `audit/2026-05-14/booking-backend.md` (`>500L` threshold; not directly comparable to this report's buckets but useful for the AI-surface delta).
- Frontend file list trimmed to top 80 (everything ≥ 406L). Tail of the orange tier (400–425L) is statistically uninteresting for prioritisation.
