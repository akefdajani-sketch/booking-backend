# Flexrz Full Audit — Consolidated Index (2026-05-14)

**Scope:** Read-only audit of `booking-backend`, `booking-frontend`, `flexrz-auth`. No code changes, no DB writes.
**Reports:**
- [booking-backend.md](./booking-backend.md)
- [booking-frontend.md](./booking-frontend.md)
- [flexrz-auth.md](./flexrz-auth.md)

---

## Audit caveats

- **DB_SCHEMA_SNAPSHOT.md was not available locally.** Schema reconciliation was done against `migrations/` files, not the live prod DB. Prod is known to have drifted from migrations in both directions — items below flagged as ✅-reconciled are reconciled against migration source, not prod.
- **Sandbox-blocked agents.** The `booking-frontend` and `flexrz-auth` subagents could not access their sibling repos. Audits for those two repos were completed from the main context.
- **Frontend `any` density.** The `any`-cast grep result exceeded the inline output limit; counts above 30 files are approximate, see the persisted result file referenced in the frontend report.

---

## 1. Executive summary

Across the three repos:

| Severity | booking-backend | booking-frontend | flexrz-auth | **Total** |
|---|---:|---:|---:|---:|
| 🔴 Critical | 1 | 0 | 0 | **1** |
| 🟠 High | 6 | 6 | 2 (+1 closed) | **14** (+1 closed) |
| 🟡 Medium | 12 | 9 | 6 | **27** |
| ⚪ Info | 22 | 5 | 0 | **27** |

**Single critical** of the whole audit: an unauthenticated, write-capable `/api/media-library/*` router in the backend.

---

## 2. 🔴 Critical findings

### 2.1 backend — `/api/media-library/*` is unauthenticated

- **Repo:** `booking-backend`
- **File:** `routes/mediaLibrary.js` (mounted at `app.js:257`)
- **Description:** The router exposes 7 write-capable routes (POST/PATCH/DELETE assets, assignments) keyed by `:tenantId` from the URL with **no auth middleware**. The file ships with `// TODO: replace with your real auth middleware.` (line 24). Any unauthenticated client can upload arbitrary files to R2 against any tenant ID.
- **Action:** Wrap the router with `requireAppAuth` + `requireTenantRole('staff')`. Audit recent R2 uploads for anomalous tenant IDs.
- **Effort:** S

### 2.2 PATCH 121 status — **LANDED**

Brief asked to verify; confirming as completed (not a finding):
- `routes/publicTenantTheme.js:146,482` — exposes `tenants.name`. ✅
- `app/book/[slug]/page.tsx:262-294` — title hydration with backend fetch. ✅

---

## 3. 🟠 High findings

### Backend

| ID | Finding | File | Effort |
|---|---|---|---|
| BE-2d | 327 `console.*` calls across `routes/`, `utils/`, `middleware/`. No ESLint to prevent regression. | repo-wide | L |
| BE-1 | Six files still over 800 lines; `routes/bookings/create.js` is 1680L (2× threshold). | `routes/bookings/{create,crud}.js`, `routes/ai.js`, `utils/contracts.js`, `utils/claudeService.js`, `routes/tenants/core.js` | L per file |
| BE-3f | No project-level ESLint config exists. | repo | M |
| BE-4-1 | `routes/services/crud.RENTAL_PATCH.js` is a patch-notes file masquerading as `.js`. | repo | S |
| BE-2h | `GET /api/availability` accepts numeric `tenantId` from query — enumeration surface. | `routes/availability.js:14-66` | M |
| BE-1-newentrant | New file-size entrants since baseline: `utils/voiceContext.js` 676L, `routes/contractInvoicePaymentLinks.js` 632L, `routes/stripeWebhook.js` 606L. | (3 files) | M each |

### Frontend

| ID | Finding | File | Effort |
|---|---|---|---|
| FE-2c-2 | Hardcoded "Welcome to Birdie Golf" header rendered for every tenant. | `components/booking/UserAvatarButton.tsx:28` | S |
| FE-3b-2 | Open Dependabot `security-updates` branch. Review and merge. | `origin/dependabot/npm_and_yarn/security-updates-6a4953591c` | S |
| FE-3b-1 | `origin/add-claude-md` is 544 ahead / 3472 behind main. Triage. | branch | M |
| FE-4a-1 | Empty `UserAvatarButton.tsx` orphan at repo root. | `./UserAvatarButton.tsx` | S |
| FE-2c-1 | `app/book/[slug]/page.tsx:107` hardcodes the prod Render backend URL ahead of env vars. | `app/book/[slug]/page.tsx:107` | S |
| FE-1 | 14 files over 600 lines; top 5 over 700; `CreateContractModal.tsx` at 1119. | (14 files) | M per file |

### Auth

| ID | Finding | File | Effort |
|---|---|---|---|
| ✅ AUTH-2g-1 (CLOSED) | Investigated 2026-05-14 — verified all three secrets set distinctly in Vercel/Render production env. `|| NEXTAUTH_SECRET` fallback never engages in prod. False alarm; no code change required. Residual: optional Phase 4 hardening (see follow-ups). | `lib/auth/options.ts:33-37`, `app/return/route.ts:169`, `app/bridge/route.ts:80-82` | — |
| AUTH-2c-2 | `birdie-golf` hardcoded as production fallback URL slug. Cross-tenant funnel if normalize fails. | `app/return/route.ts:134` | S |
| AUTH-7-1 | `@types/react@18` while `react@19` runs — type-vs-runtime drift. | `package.json` | S |

---

## 4. 🟡 Medium findings (selected highlights)

### Schema reconciliation status (BE)
- ✅ Migrations 052 / 055 (notification toggles) reconcile against `utils/notificationGates.js`.
- ✅ Migration 066 (voice prompt snapshot) reconciles against `utils/voicePromptGenerator.js`.
- 🟡 Migration **060 is missing** (file numbers jump 059 → 061). Document the skip.

### Voice agent state (BE)
- ✅ `utils/voicePromptGenerator.js` (527L), `routes/admin/voicePrompt.js` (153L, auth-gated), migration 066, `utils/voiceContext.js` (676L fallback) all present.
- 🟡 `VOICE_PROMPT_FEATURE_SLUGS = ["birdie-golf"]` hardcoded gate in `utils/voiceContext.js:145` — move to `tenants.features` JSONB before the next tenant joins the snapshot path.

### THEMES-V2 / Phase 5 state (BE)
- ✅ Migration 069 (`platform_themes`) and 070 (`platform_shells` + `platform_layouts`) present.
- ✅ `routes/publicTenantTheme.js:447-463` exposes shell + layout blocks.

### Frontend brand bleed
- 🟡 `components/booking/ConfirmationModal.tsx:119` defaults `calendarLocation` to `"Birdie Golf"`. Tenants not passing the prop emit calendar invites with "Birdie Golf" as location.
- 🟡 The brief's `97+98+99+101+143` superset notation does not literally appear in source — actual markers are `PR A1.1`, `PR B1.1 (Patch 105)`, `PATCH 120/121`. Settle on one scheme.

### Auth secrets logging
- 🟡 Four unconditional `console.log`/`info` lines in `lib/auth/options.ts` (events.signIn, events.signOut, events.session, jwt) log user email on every auth event. Session event fires every cookie-touch — large volume of email-tagged logs in Vercel.

### ESLint health (FE)
- 🟡 Both `.eslintrc.cjs` AND `eslint.config.mjs` coexist. The flat config IS now present and registers `flexrz/no-raw-price-render` at `warn` (brief incorrectly states the rule is dormant). Delete the legacy CJS file; plan the `warn → error` flip.

### Auth Sentry
- 🟡 `flexrz-auth/sentry.client.config.ts` and `instrumentation.ts` are 2-line placeholders ("Sentry not installed"). Auth broker silently drops OAuth failures with no telemetry — high-ROI fix.

---

## 5. ⚪ Info / version drift

| Field | booking-backend | booking-frontend | flexrz-auth | Aligned? |
|---|---|---|---|---|
| `engines.node` | — | — | — | All three missing — pin to `>=20`. |
| Express / Next | Express ^4.19 | Next 16.0.7 | Next 16.0.7 | Frontend + auth aligned on Next. |
| React | n/a | 19.2.0 | 19.0.0 | 🟡 minor mismatch — auth on 19.0, fe on 19.2. |
| `@types/react` | n/a | `^19` | `^18` | 🟡 auth types lag runtime by a major. |
| Sentry | `@sentry/node ^7.0.0` | `@sentry/nextjs ^10.42.0` | placeholder | 🟡 wide divergence — Sentry node v7 is several majors behind nextjs v10. |
| `next-auth` | n/a | `^4.24.7` | `^4.24.11` | ✅ ~aligned |
| Stripe | `^17.0.0` | n/a | n/a | n/a |
| `@anthropic-ai/sdk` | `^0.39.0` | n/a | n/a | n/a |
| TypeScript | n/a (JS only) | `^5` | `^5.4.5` | ✅ aligned |
| ESLint | none | `^9` flat config | none | 🟡 auth + backend have no ESLint |

---

## 6. Pending works summary (in-flight tracks)

| Track | State | Source-of-truth files | Notes |
|---|---|---|---|
| **THEMES-V2 / Phase 5** | Migrations 069+070 shipped. Public theme route exposes shell+layout. Frontend `PublicBookingContent` does NOT yet route through `SectionRenderer` (Phase 5.3 unstarted per brief). | `migrations/069*`, `migrations/070*`, `routes/publicTenantTheme.js`, `components/public-booking/PublicBookingContent.tsx` | Phase 5.1 + 5.2 landed in `fe69420` and `243379d` |
| **Voice agent** | VOICE-FIX-6 shipped (`utils/voicePromptGenerator.js` + migration 066). VOICE-FIX-5 rolled back. Feature gate hardcoded to `["birdie-golf"]`. | `utils/voicePromptGenerator.js`, `routes/admin/voicePrompt.js`, `migrations/066_*`, `utils/voiceContext.js`, `utils/claudeService.js` | "Gate `confirmationMode` fallback" was the most recent backend commit |
| **SEO** | PATCH 120 (root canonical removed) + PATCH 121 (tenant title hydration) shipped. | `app/layout.tsx`, `app/book/[slug]/page.tsx`, `routes/publicTenantTheme.js` | Per-page canonical convention established |
| **UX-POLISH / SIZE** | SIZE-2 shipped (`utils/dashboardSummary.js` split to 174L orchestrator). SIZE-3 cancelled. POLISH-3 shipped, POLISH-11 cancelled. 6 backend + 14 frontend files still over thresholds. | `scripts/check-file-sizes.mjs` (frontend) enforces 800L hard cap on changed files | |
| **Schema-drift triage** | Tracked separately — `notificationGates.js` columns may not exist in prod even though migrations 052/055 do. | `tools/db_audit.sql` + `build_snapshot.py` (per brief) | Not in this audit's scope |
| **Twilio WhatsApp** | UI present (`TwilioSetupPanel.tsx`, 795L). Backend integration depth not audited this round. | `components/owner/tabs/setup/sections/TwilioSetupPanel.tsx` | |
| **Malaysia GTM demo tenants** | Marketing + demo data hooks present (`components/marketing/landingPageData.ts`). No tenant-onboarding gate found. | `components/marketing/DemoModal.tsx`, `components/marketing/landingPageData.ts` | |

---

## 7. Recommended next sessions

Top-5 highest-ROI follow-ups, ordered by user-impact-per-effort:

1. **Patch the media-library auth hole** (🔴 BE-2i)
   - File: `routes/mediaLibrary.js`. Add `requireAppAuth` + `requireTenantRole('staff')`.
   - Effort: S. Pay-off: closes the only 🔴 critical of the audit.

2. **Fix "Welcome to Birdie Golf" cross-tenant brand bleed** (🟠 FE-2c-2 + FE-2c-3 + FE-4a-1)
   - Combine into one PR: thread `tenant.name` through `UserAvatarButton`, change `ConfirmationModal`'s `calendarLocation` default, delete the empty root `UserAvatarButton.tsx`.
   - Effort: S. Pay-off: removes the most visible cross-tenant bug.

3. **Phase 4 hardening — fail closed on missing `FLEXRZ_APP_JWT_SECRET` / `BOOKING_HANDOFF_SECRET`** (follow-up to closed AUTH-2g-1)
   - AUTH-2g-1 investigated 2026-05-14 and closed — secrets are set distinctly in prod. Optional residual: remove the `|| NEXTAUTH_SECRET` fallback in `lib/auth/options.ts`, `app/return/route.ts`, `app/bridge/route.ts` so a missing secret fails closed (HTTP 500) instead of silently sharing keys.
   - Small change, but it removes the env-only rollback path — think before shipping. Defer to a quiet session.
   - Effort: S. Pay-off: defense-in-depth against future env misconfiguration.

4. **Schema-drift triage session** (🟡 cross-cutting)
   - Run the existing `tools/db_audit.sql` + `build_snapshot.py` against prod, produce a fresh `DB_SCHEMA_SNAPSHOT.md`, reconcile against `migrations/052,055,066`. Targeted re-audit of `utils/notificationGates.js` and `utils/voicePromptGenerator.js`.
   - Effort: M. Pay-off: closes the visibility gap on which migrations actually landed.

5. **Backend ESLint baseline + console sweep** (🟠 BE-3f + BE-2d)
   - Add `eslint:recommended` + `no-console` (allow `warn`/`error`) + `no-unused-vars`. Sweep the 327 `console.*` calls into `utils/logger`. Land in two PRs (config + sweep) to keep diffs reviewable.
   - Effort: M (config), L (sweep). Pay-off: locks in Pino as the only logger, removes secret-leak risk in error branches.

---

## Final tally

**70 findings total** across the three repos: 1 🔴, 14 🟠 (+1 closed: AUTH-2g-1), 27 🟡, 27 ⚪.

Reports:
- `audit/2026-05-14/booking-backend.md`
- `audit/2026-05-14/booking-frontend.md`
- `audit/2026-05-14/flexrz-auth.md`
- `audit/2026-05-14/INDEX.md` (this file)
