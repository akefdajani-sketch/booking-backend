# booking-backend — Audit Report (2026-05-14)

> **Schema source note:** `DB_SCHEMA_SNAPSHOT.md` does NOT exist locally. Used `migrations/001…070` as the reference. Per project memory, prod DB has drifted from migrations in both directions — column-reference flags below are against migration files, not the live DB.

**Audited by:** subagent (text-only output — Write tool was blocked for the agent; report persisted by parent context).
**Branch:** `voice-confirmation-gate`
**HEAD:** `683d805 Gate confirmationMode fallback on prior assistant proposal signal`

---

## 0. Working tree state

Untracked-only: `scripts/birdie-data-snapshot.js`, `scripts/themes_v2/05_capture_render_baseline.js`. Audit proceeded **without stashing**.

---

## 1. File size hot spots (>800L)

| Sev | LOC | File | Notes |
|---|---:|---|---|
| 🔴 | 1680 | `routes/bookings/create.js` | Known. Split: payment / notification / rate-tax / prepaid-membership |
| 🔴 | 1367 | `routes/ai.js` | Known. Split: aiContext, handleAction, chat route |
| 🟠 | 950 | `utils/contracts.js` | Known |
| 🟠 | 903 | `routes/bookings/crud.js` | Known. Split stats out |
| 🟠 | 834 | `utils/claudeService.js` | Known. Move prompts to `.md` |
| 🟠 | 819 | `routes/tenants/core.js` | Known |
| 🟡 | 676 | `utils/voiceContext.js` | **New entrant** |
| 🟡 | 632 | `routes/contractInvoicePaymentLinks.js` | **New entrant** |
| 🟡 | 606 | `routes/stripeWebhook.js` | **New entrant** |

`utils/dashboardSummary.js` confirmed at **174L** — orchestrator split confirmed under `utils/dashboardSummary/*`.

---

## 2. Bug inventory

### 2a. TODO / FIXME / HACK / XXX census

FIXME=0, HACK=0, XXX=0, TODO=4.

- 🟡 `routes/mediaLibrary.js:24` — `// TODO: replace with your real auth middleware.` (route is currently unauthenticated — see §2i)
- ⚪ `routes/ai.js:25` — slot cache TTL tenant-configurable TODO
- ⚪ `routes/contractInvoicePaymentLinks.js:29` — `Card → MPGS hosted checkout, settled via webhook (TODO in G2-PL-2.1)`
- ⚪ `scripts/themes_v2/01_audit_theme_sync.js:107` — already resolved by migration 069

### 2b. `@ts-ignore` / `@ts-expect-error`

Zero in JS source. Backend is plain JS — expected. ⚪

### 2c. Hardcoded magic values

- **Hardcoded tenant IDs (3 / 21 / 33):** none found in JS source. ⚪
- **URLs:** all `https://` strings are env-var fallbacks (FRONTEND_URL / APP_BASE_URL / BOOKING_FRONTEND_URL / RENDER_EXTERNAL_URL / NETWORK_GATEWAY_URL). Notable:
  - `routes/ai.js:1027` `https://booking-backend-6jbc.onrender.com`
  - multiple `https://flexrz.com` and `https://app.flexrz.com` fallbacks (~20 sites)
  - MPGS `https://test-network.mtf.gateway.mastercard.com` defaults in `utils/network.js`, `utils/networkCredentials.js`, `routes/tenantPaymentSettings.js`, `routes/tenants/core.js:714`
- **Brand strings:** 🟡 `utils/voiceContext.js:145` `const VOICE_PROMPT_FEATURE_SLUGS = ["birdie-golf"];` — runtime gate for the snapshot path is hardcoded to one tenant. Move to `tenants.features` JSONB before onboarding the second tenant.

### 2d. `console.*` in production paths

**327 total occurrences:** routes 288/64-files, utils 30/16-files, middleware 9/8-files. Worst offenders: `routes/ai.js` (30), `routes/tenants/core.js` (15), `routes/voice.js` (12). Every middleware catch block uses `console.error("…", err)` instead of `logger.error({ err }, '…')`.

🟠 **Action:** Add ESLint `no-console` rule + sweep PR. Effort: L.

### 2f. Migration ↔ code reconciliation

- **Migration 052** adds 4 SMS + 4 WA toggles on `tenants` (all BOOLEAN NOT NULL DEFAULT TRUE).
- **Migration 055** adds 4 email toggles on `tenants` + 2 dedup TIMESTAMPTZ on `bookings` (`email_reminder_sent_24h`, `email_reminder_sent_1h`) + 2 partial indexes.
- All 12 column references in `utils/notificationGates.js` (`SMS_TOGGLE_COLUMNS`, `WA_TOGGLE_COLUMNS`, `EMAIL_TOGGLE_COLUMNS`) reconcile to 052/055. `readToggle` fails open on missing column (logs WARN, returns true) — intentional schema-compat behavior documented in the file. ✅
- **Voice prompt:** `utils/voicePromptGenerator.js` writes `tenants.voice_prompt_snapshot` (JSONB). Migration 066 adds exactly that column with matching JSONB shape (`{prompt, generated_at, model, source_data_hash, version}`). ✅
- 🟡 **Migration numbering gap:** there is no `migrations/060_*.sql`. Files jump 059 → 061. Document the skip in a `migrations/README.md` or fill with a NOTICE-only placeholder. Effort: S.

### 2g. Known landmines

- **PATCH 121 (`tenants.name` exposure on public theme):** ✅ confirmed live at `routes/publicTenantTheme.js:146` (SELECT) and `:482` (response field) with the PATCH 121 inline comment.
- **`db.js` SSL gating:** uses `DATABASE_SSL` override → falls back to `NODE_ENV==='production'`. Exact code at lines 7-11:
  ```js
  const isProd = process.env.NODE_ENV === 'production';
  const useSSL =
    process.env.DATABASE_SSL != null
      ? String(process.env.DATABASE_SSL).toLowerCase() === 'true'
      : isProd;
  ```
  ✅ Matches the documented dev-against-prod workflow (set `DATABASE_SSL=true` locally because `NODE_ENV` is `development`).

### 2h. Multi-tenant isolation risk

**244 `tenant_id = $...` predicates across 50 route files.** 20-handler sample (bookings list/detail, services GET, customers list, staff/resources, availability, tenant-hours/blackouts, contracts list/create, customer-memberships list, maintenance-tickets, rental-availability, sessions, owner-dashboard, bookings POST/PATCH status, tenant dashboard) all enforce tenant scoping either via `requireTenant` middleware or explicit `WHERE tenant_id = $N` predicates. No cross-tenant bug found in the sample. ✅

🟡 `GET /api/availability` — public, accepts `tenantId` directly as a query parameter (lines 14-66). Acceptable for booking but allows enumeration by numeric tenant ID. Consider restricting to slug-only.

### 2i. Missing auth middleware

- 🔴 **CRITICAL — `routes/mediaLibrary.js`** has **NO auth middleware** but is mounted at `/api/media-library/*` in `app.js:257` and exposes 7 write-capable routes (POST/PATCH/DELETE assets, assignments) keyed by `:tenantId` from the URL with no verification. The file ships with `// TODO: replace with your real auth middleware.` (line 24). Any unauthenticated client can upload to R2 for any tenant. Effort: S — wrap router with `requireAppAuth` + `requireTenantRole('staff')` (or equivalent).
- ⚪ Other non-public routes verified OK: `routes/uploads.js` (`requireAdmin`), `routes/admin/voicePrompt.js` (`router.use(requireAdmin)`), `routes/debugGoogleAuth.js` (env-gated), `routes/health.js` / `routes/stripeWebhook.js` (correctly public).

---

## 3. Pending works inventory

### 3c. Patch state ledger

Inline source patches (PATCH 121, PR-1, PR D5, G2a-1, VOICE-FIX-1…6, PAY-1, RENTAL-1, etc.) are documented in **source comments**, not commit messages — most recent ~210 commits use the generic `Add files via upload (#NNN)` template. Distinct recent patches visible in `git log`:

| SHA | Marker | Message |
|---|---|---|
| 683d805 | (voice fix) | Gate confirmationMode fallback on prior assistant proposal signal |
| 6a2f56e | docs | Add docs/VOICE_BACKLOG.md and docs/AUDIT_2026-05-11.md |
| 2b2e24f | Voice Bug B | CONFLICT CHECK rule to voice agent prompt |
| fe69420 | Phase 5.1+5.2, PATCH 121 | Phase 5.1 sync + Phase 5.2 catalogs + audit findings (#431) |
| 243379d | Phase 5.1, customer audit | THEMES-V2 Phase 5.1 + customer routes audit findings (#429) |
| 143299c | bugfix | Fix me memberships email (#426) |
| b974329 / 2cef1f8 | docs | Add CLAUDE.md for Claude Code |

### 3d. THEMES-V2 / Phase 5 state

- ✅ `migrations/069_themes_v2_platform_themes_capture.sql` present (creates `platform_themes` table + deletes `premuim_light_v2` typo orphan).
- ✅ `migrations/070_themes_v2_shells_layouts.sql` present (creates `platform_shells` + `platform_layouts`, seeds 4 shells + `legacy_default` layout, adds `tenants.shell_key` and `tenants.layout_key_v2`).
- ✅ `routes/publicTenantTheme.js` exposes `shell` block at lines 447-450 and `layout` block at lines 451-463 with fallbacks when shell/layout rows are missing.

### 3e. Voice agent state

- ✅ `utils/voicePromptGenerator.js` — **527 lines**, exports `generateVoicePromptForTenant`, `readVoicePromptSnapshot`, `overwriteVoicePrompt`, `clearVoicePromptSnapshot`.
- ✅ `routes/admin/voicePrompt.js` — **153 lines**, all 5 routes auth-gated via `router.use(requireAdmin)`.
- ✅ `migrations/066_tenants_voice_prompt_snapshot.sql` — adds `tenants.voice_prompt_snapshot JSONB NULL`, intentionally no backfill.
- ✅ `utils/voiceContext.js` — 676 lines; hosts both the V4 legacy fallback and snapshot-augmented path.
- ⚪ VOICE-FIX-5 references: only two — `utils/claudeService.js:529` (a prompt comment marking a live rule, not a rollback) and `utils/voiceContext.js:164` ("Legacy V4 fallback path (unchanged from pre-VOICE-FIX-5)") marking the rollback boundary. No active VOICE-FIX-5 logic remains.

### 3f. ESLint health

🟠 **No project-level ESLint config exists.** Glob check finds zero hits outside `node_modules`. No `package.json` lint script. Recommend adding `.eslintrc.json` with `eslint:recommended`, `no-console` (allow warn/error), `no-unused-vars`. Effort: M.

---

## 4. Dead / orphan code

- 🟠 `routes/services/crud.RENTAL_PATCH.js` — **NOT a Node module**; it's a patch-notes file with a `.js` extension. Grep finds only the file itself referencing the name. Rename to `.md` or delete. Effort: S.
- 🟡 `utils/dashboardInsights.js` — zero `require` references. Likely superseded by `utils/dashboardSummary/*` split. Confirm and delete. Effort: S.
- Untracked: `scripts/birdie-data-snapshot.js`, `scripts/themes_v2/05_capture_render_baseline.js` — both one-shot dev scripts. ⚪

**Verified-in-use (NOT orphans, despite individual appearance):** `aiContextCache` (14 refs), `dashboardHelpers` (7 refs), `notificationGates`, `buildNoShowMetrics`, `contractSigningNotification`, `membershipTopUpHelpers`, `ensureBookingRateColumns`, `ensurePaymentMethodColumn`, `classSeats`, `adminTenantsThemeHelpers`, `ensureLinksSchema`, `tenantSubscriptionEnricher`.

---

## 5. API endpoint inventory

`~325 route handlers across ~100 router files.` Auth flags from the inventory:

- 🔴 `/api/media-library/*` — no auth (see §2i)
- 🟡 `GET /api/availability` — public, takes `tenantId` (see §2h)
- 🟡 `GET /api/tenant-hours` — no auth on GET; tenant operating hours are arguably public (visible on booking page anyway)

The full mount-point table (per `app.use(...)` line in `app.js` with prefix / auth middleware / route count) is voluminous and was not regenerated in this round — recommend an incremental follow-up that produces a stable diff vs prior inventories. Effort: M.

---

## 6. Cron job inventory

**No `node-cron` / `cron.schedule` / `setInterval` invocations in the repo.** Background work uses HTTP-trigger routes called by an external scheduler (Render Cron or equivalent), each `requireAdmin`-gated:

- `POST /api/reminder-job/run` (legacy)
- `POST /api/sms-reminder-job/run`, `POST /api/whatsapp-reminder-job/run`, `POST /api/email-reminder-job/run`
- `POST /api/contract-invoice-reminder-job/run`
- `POST /api/jobs/trial-sweep`, `POST /api/jobs/activation-nudge`

Catch blocks in these route files still use `console.error` — same pattern as §2d.

---

## 7. Package versions

| Field | Value | Notes |
|---|---|---|
| `engines.node` | 🟡 not declared | |
| `express` | `^4.19.0` | |
| `pg` | `^8.13.0` | |
| `stripe` | `^17.0.0` | |
| `@anthropic-ai/sdk` | `^0.39.0` | |
| `@sentry/node` | `^7.0.0` | |
| `pino` | `^9.0.0` | |
| `pino-http` | `^10.0.0` | |
| `google-auth-library` | `^10.5.0` | |
| `multer` | `^1.4.5-lts.2` | 🟡 1.x LTS — 2.x is GA |
| `@aws-sdk/client-s3` | `^3.958.0` | |
| `jest` (dev) | `^30.0.0` | |

🟡 Missing `engines.node` makes the runtime version implicit (Render service default). Effort: S.

---

## Summary: 1 🔴 critical, 6 🟠 high, 12 🟡 medium, 22 ⚪ info findings.

**Key blockers / takeaways:**
1. 🔴 `routes/mediaLibrary.js` — `/api/media-library/*` is fully unauthenticated and write-capable per tenant. Single critical of the audit.
2. 🟠 327 `console.*` calls outside `utils/logger.js`. No ESLint to prevent regression.
3. 🟠 Six files still over 800 lines (`routes/bookings/create.js` is 1680 — 2× threshold). Splits are known but not done.
4. 🟡 Migration 060 is missing (059 → 061). Document the skip.
5. 🟡 `VOICE_PROMPT_FEATURE_SLUGS = ["birdie-golf"]` hardcoded in `utils/voiceContext.js:145`. Move to `tenants.features` before the next tenant gets the snapshot path.
6. ✅ PATCH 121, Phase 5.1, Phase 5.2, voice prompt admin endpoints, notification toggles (052 + 055) all reconciled against code references.
