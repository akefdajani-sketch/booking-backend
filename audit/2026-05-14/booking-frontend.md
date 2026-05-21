# booking-frontend — Audit Report (2026-05-14)

**Audited by:** main-context fallback (subagent was sandboxed out of the sibling-repo path AND hit a Write-block system-reminder).
**Repo path:** `C:/Users/Birdie 4/Desktop/Special Projects/booking-frontend`
**Threshold for "large file":** > 600 lines

---

## 0. Working tree state

- **Current branch:** `frontend-patch-121`
- **Working tree dirty (untracked-only):** `.claude/`, `docs/birdie_data_snapshot.md`
- **Last commit:** `c77f35b7 Frontend PATCH 121 page.tsx: hydrate tenant title from backend tenant.name`
- **Branches:**
  - Local: `add-claude-md`, `frontend-patch-121` (current), `main`
  - Remote: `origin/main`, `origin/add-claude-md`, `origin/hardening-phase-a`, `origin/pr-9-frontend-hardening`, `origin/pr-10-frontend-isolation`, `origin/frontend-patch-121`, plus 6 `origin/dependabot/*` branches.
- Audit proceeds without stashing.

### Branch ahead/behind (vs `main`):

| Branch | Ahead of main | Behind main | Notes |
|---|---:|---:|---|
| `frontend-patch-121` (current) | 2 | 0 | Two PATCH 121 commits on top of main. |
| `origin/hardening-phase-a` | 8 | 2242 | Severely stale; main has moved on. |
| `origin/pr-9-frontend-hardening` | 0 | 1098 | Fully merged into main. |
| `origin/pr-10-frontend-isolation` | 0 | 1092 | Fully merged into main. |
| `origin/add-claude-md` | 544 | 3472 | 🟠 Diverged heavily. Likely a long-running stale branch — see F-FE-3b-1. |
| `origin/dependabot/security-updates-6a4953591c` | 1 | 5 | 🟠 Named "security-updates" — review priority. |

### Commit-log note (⚪ info)

Last 200 commits dominated by `Add files via upload (#NNN)` — the repo was bootstrapped through the GitHub web UI rather than a developer workflow. Limited archaeology signal in `git log`.

---

## 1. File size hot spots (threshold: > 600 lines)

The repo has a build-time guardrail at `scripts/check-file-sizes.mjs` with thresholds: **WARN at 400**, **STRICT at 500** (changed files), **HARD at 800** (changed files). The 14 files below are in the Refactor/Hard zones but the script only blocks PRs that *grow* them.

| Sev | LOC | File | Primary responsibility | Suggested split |
|---|---:|---|---|---|
| 🔴 | 1119 | `components/tenant/ops/contracts/CreateContractModal.tsx` | Multi-step contract creation modal (steps, pricing, signature, terms) | per-step components, pricing math helpers |
| 🔴 | 898 | `components/owner/tabs/setup/sections/GeneralSection.tsx` | Owner Setup → General section: tenant identity / hours / theme select | extract per-field group hooks |
| 🟠 | 795 | `components/owner/tabs/setup/sections/TwilioSetupPanel.tsx` | Twilio integration setup panel | split connect/test/list into 3 sub-panels |
| 🟠 | 718 | `components/shared/appearance/ThemeStudioPanelUnified.tsx` | Owner Theme Studio (unified design surface) | extract preview + color pickers |
| 🟠 | 710 | `components/tenant/ops/contracts/ContractDetailDrawer.tsx` | Tenant contract detail drawer (review, sign, invoice tabs) | tab components |
| 🟡 | 683 | `components/owner/customers/CustomerPurchasesPanel.tsx` | Customer purchases timeline (bookings + memberships + packages) | per-tab subcomponents |
| 🟡 | 671 | `components/booking/home/templates/WellnessEditorialTemplate.tsx` | Homepage editorial template for wellness vertical | extract sections — but acceptable as one file (template) |
| 🟡 | 660 | `components/owner/customers/CustomerDetailDrawer.tsx` | Owner customer detail drawer | tab components |
| 🟡 | 653 | `components/booking/BookingHistory.tsx` | Customer booking history list + filters | filter hook + list component |
| 🟡 | 644 | `components/owner/tabs/OwnerCustomersTab.tsx` | Owner customers table tab | table + filter hooks |
| 🟡 | 626 | `components/owner/tabs/setup/sections/ServicesSection.tsx` | Setup → Services section | service-form subcomponent |
| 🟡 | 623 | `app/book/[slug]/setup/sections/ImagesSection.tsx` | Setup → Images section | upload + reorder hooks |
| 🟡 | 608 | `components/booking/useElevenLabsAgent.ts` | Voice-agent client hook (WebRTC + transcript glue) | message-handler module |
| 🟡 | 604 | `lib/booking/publicBooking/useBookingSubmit.ts` | Booking submission orchestration | payment/membership branches |

**Cross-ref to baseline:**
- Known files all confirmed: `CreateContractModal.tsx` (1119, was 1119 — flat), `GeneralSection.tsx` (898, flat), `TwilioSetupPanel.tsx` (795, flat), `ThemeStudioPanelUnified.tsx` (718, flat), `ContractDetailDrawer.tsx` (710, flat).
- **New entrants** since baseline: `CustomerPurchasesPanel.tsx` (683), `WellnessEditorialTemplate.tsx` (671), `CustomerDetailDrawer.tsx` (660), `BookingHistory.tsx` (653), `OwnerCustomersTab.tsx` (644), `ServicesSection.tsx` (626), `ImagesSection.tsx` (623), `useElevenLabsAgent.ts` (608), `useBookingSubmit.ts` (604).

---

## 2. Bug inventory

### 2a. TODO / FIXME / HACK / XXX census

**9 occurrences across 2 files.** No FIXME / HACK / XXX. All TODO.

| File:Line | Text |
|---|---|
| 🟡 `app/book/[slug]/PublicBookingClient.tsx:111` | `const allowCustomerEdits = true; // TODO: make this tenant-configurable` |
| ⚪ `components/tenant/ops/hooks/useTenantOpsMutations.ts:102` | `* TODO:` (block-comment header) |
| ⚪ `components/tenant/ops/hooks/useTenantOpsMutations.ts:130,155,179,331,355,380,405` | 7× `TODO: move existing <X> mutation here` — scaffold for an extraction in progress |

**Action:** The 7 `useTenantOpsMutations.ts` TODOs are a tracked refactor; flag for completion. The `allowCustomerEdits` flag (`PublicBookingClient.tsx:111`) is a behavior decision the user has been deferring — needs to surface as a tenant setting. Effort: M.

### 2b. `any` and `@ts-ignore` audit

- **`any` casts:** dense — Grep reports > 30 files with hits before truncating at 30. The full result was too large to read (41KB of output saved to a persisted-output file). Concentrations:
  - `components/shared/appearance/ThemeStudioPanelUnified.tsx`: 27
  - `components/shared/appearance/useAppearanceController.ts`: 25
  - `app/owner/dashboard/hooks/useOwnerTenantsState.ts`: 3, but the appearance subtree has the highest density.
- **`@ts-ignore`:** **1** occurrence — `components/shared/ErrorBoundary.tsx:62` with the comment `// @ts-ignore — optional peer dependency` for a dynamic-import probe of `window.__SENTRY__`. Justified. ⚪
- **`@ts-expect-error`:** zero. ⚪

🟡 **Finding F-FE-2b-1**: The appearance/theme subtree (`ThemeStudioPanelUnified.tsx`, `useAppearanceController.ts`, helper files) accounts for the bulk of `any` density. Type the public theme contract once — that's the highest-leverage cleanup.

### 2c. Hardcoded magic values

#### Hex colors

`#4c8a3f` appears in 5 places — all canonical, not stray:
- `lib/theme/defaultTheme.ts:5` and `:25` — the codebase-default brand green.
- `lib/theme/themes/classic.ts:36,52,57` — "classic" theme palette, explicit comments naming it as the canonical green.
- `lib/theme/themes/minimal.ts:15,51` — comment + fallback reference (uses `#16a34a` as minimal's own).
- `lib/theme/__tests__/publishContractTokens.test.ts:24` — test assertion.

No stray `#4c8a3f` in JSX. ✅

#### URLs

29 occurrences of `https://(flexrz|api.flexrz|auth.flexrz)` across 16 files — sample:
- `middleware.ts:3` — base host literal (fine).
- `lib/auth/redirectToCentralSignIn.ts`, `redirectToCentralSignOut.ts`, `redirectToCentralAuth.ts` — `auth.flexrz.com` literals used as fallback when env not set (fine).
- `app/auth/signin/page.tsx:1`, `lib/auth/options.ts:3` — fallback origins (fine).
- `app/api/customer-session/route.ts:1`, `app/api/onboard/register/route.ts:1` — API base URL fallback.
- `lib/urls/publicBooking.ts:2` — public-booking URL helper.

⚪ All are guarded by `process.env.NEXT_PUBLIC_*` first; literals are fallbacks. No bugs.

🟠 **Finding F-FE-2c-1 — confirmed earlier**: `app/book/[slug]/page.tsx:107` hardcodes `const prod = "https://booking-backend-6jbc.onrender.com";` as the *first* candidate, ahead of the env-driven values. This means: if the env is misconfigured, every tenant still hits the canonical Render backend (good fallback), but a deliberate point at a staging backend won't take effect unless the env is set AND the prod literal is removed.
- **File:** `app/book/[slug]/page.tsx:107`
- **Action:** Move the literal to last position so env values win, OR document it as a known canonical pin.
- **Effort:** S

#### Brand strings — "Birdie Golf" appearances

Most are placeholders, marketing copy, or test fixtures (acceptable). Three are higher-grade:

| File:Line | Text | Severity |
|---|---|---|
| `components/booking/ConfirmationModal.tsx:119` | `calendarLocation = "Birdie Golf",` — **default-arg fallback** for calendar-invite location | 🟡 |
| `components/booking/UserAvatarButton.tsx:28` | `Welcome to Birdie Golf` — hardcoded welcome heading | 🟠 |
| `components/marketing/DemoModal.tsx:24` | `name: "Birdie Golf",` — demo modal data (acceptable for marketing) | ⚪ |
| `components/marketing/landingPageData.ts:44` | `"Birdie Golf has been running operations on Flexrz since day one…"` — marketing testimonial (intentional) | ⚪ |

🟠 **Finding F-FE-2c-2**: `components/booking/UserAvatarButton.tsx:28` renders `Welcome to Birdie Golf` as a hardcoded string. This component is reused across all tenants in the booking UI — non-Birdie tenants are showing "Welcome to Birdie Golf". This is a cross-tenant brand-bleed bug.
- **Action:** Read `tenant.name` from the booking context.
- **Effort:** S
- **Note:** see also F-FE-4a-1 below — there are TWO copies of this file in the repo.

🟡 **Finding F-FE-2c-3**: `components/booking/ConfirmationModal.tsx:119` defaults `calendarLocation` to `"Birdie Golf"`. Any tenant not passing the prop emits a calendar invite with "Birdie Golf" as location.
- **Action:** Default to `tenant.name` or to empty string.
- **Effort:** S

### 2d. `console.*` in production paths

**85 total occurrences across 31 files** (`app/`, `components/`, `lib/`). Top concentrations:

| File | Count |
|---|---:|
| `app/api/onboard/register/route.ts` | 6 |
| `app/api/voice/stt/route.ts` | 4 |
| `components/owner/tabs/setup/hooks/useSetupResources.ts` | 5 |
| `components/owner/tabs/setup/hooks/useSetupStaff.ts` | 5 |
| `components/owner/tabs/setup/hooks/useSetupServices.ts` | 4 |
| `app/owner/dashboard/hooks/useOwnerTenantsState.ts` | 3 |
| `components/owner/tabs/OwnerCustomersTab.tsx` | 3 |
| `app/BookingForm.tsx` | 3 |

🟡 **Finding F-FE-2d-1**: The owner setup hooks (`useSetupServices`/`Staff`/`Resources`) and the onboard registration route each log 4–6 console messages. Most are error-branch `console.error("…", e)` calls. With Sentry in place (`@sentry/nextjs ^10.42.0`), these should call `Sentry.captureException(e)` instead, or at least be funnelled through a single client logger.
- **Action:** Add ESLint `no-console` (allowing `console.warn`/`error` under a Sentry adapter), introduce a thin client logger.
- **Effort:** M

### 2e. Stale closure / ref pattern risk

Heuristic count of `useEffect(() => {…}, [])` (empty deps): **multiple per file, scattered.** Most are mount-only handlers (token capture, analytics ping, scroll lock) which are correct uses. A targeted review is recommended in:

- `components/booking/useElevenLabsAgent.ts` (608L, WebRTC + transcript lifecycle — closures around audio refs and session state).
- `lib/booking/publicBooking/useBookingSubmit.ts` (604L, multi-step submit with retries).
- `app/owner/dashboard/hooks/useOwnerTenantsState.ts` (3 effects + 3 console errors — fetch/cleanup pattern worth eyeballing).

⚪ **Finding F-FE-2e-1**: Not flagged as a concrete bug — proposed as a follow-up review session, scoped to the three files above. Effort: M.

### 2g. Known landmines

- **PATCH 121 — title hydration at `app/book/[slug]/page.tsx`**: ✅ confirmed at lines **262–294**. `cachedFetchTenantTheme(slug)` fetches `tenant.name` from the backend; `displayName` falls back to a slug-derived title; final title is `\`Book online — ${displayName} | Flexrz\`` (on primary host) or `\`Book online — ${displayName}\`` (on custom domain). Quoted block:
  ```ts
  // app/book/[slug]/page.tsx:262-274
  let displayName = "";
  try {
    const { payload } = await cachedFetchTenantTheme(slug);
    const fetchedName = (payload?.tenant?.name || "").trim();
    if (fetchedName) displayName = fetchedName;
  } catch {
    // Swallow — generateMetadata must never throw.
  }
  if (!displayName) {
    displayName = slug.split("-").filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }
  ```
- **PATCH 120 — no global canonical at `app/layout.tsx`**: ✅ confirmed. Lines 23–55 have an extensive inline comment explaining the removal. The `alternates: { canonical }` field is **not** present in the root `metadata` export — each public page sets its own.

### 2h. Multi-tenant isolation risk (frontend)

Frontend has no DB. Risk surface = brand-bleed and tenant-scope confusion in components:

- 🟠 `components/booking/UserAvatarButton.tsx:28` — "Welcome to Birdie Golf" hardcoded (F-FE-2c-2)
- 🟡 `components/booking/ConfirmationModal.tsx:119` — default `calendarLocation` (F-FE-2c-3)

### 2i. Missing auth middleware

Not applicable — most routes are Next.js App Router pages. The `app/api/` proxy routes (`/api/proxy-admin-upload`, `/api/customer-session`, `/api/onboard/register`, `/api/voice/{tts,stt}`) all defer auth to the backend. ✅

---

## 3. Pending works inventory

### 3a. Layered superset registry

Verified each entry exists. Version-marker convention in this repo uses **`PR A1.1`-style** headers in file comments rather than `97+98+99` numeric supersets — so the brief's expected markers are not all literal matches. Annotations below quote the actual marker that appears.

| File | Canonical path | Marker found in file | Status |
|---|---|---|---|
| `PublicBookingContent` | `components/public-booking/PublicBookingContent.tsx` | Comment refers to "extracted from PublicBookingClient", "TARGET_1_REMAINING_WORK_PLAN.md" — no `97+98+...` literal | ✅ exists, marker shape differs from brief |
| `MembershipsTab` | `components/booking/MembershipsTab.tsx` | "PR A1.1 — MembershipsTab (marketing split)"; references "patch 97" by name | ✅ matches **97** (98+99+143 likely added downstream — not verified by markers in file) |
| `PackagesTab` | `components/booking/PackagesTab.tsx` | (exists; markers not read) | ✅ exists |
| `BookingHistory` | `components/booking/BookingHistory.tsx` | (exists at 653L; markers not read) | ✅ exists |
| `registry.tsx` | `components/owner/dashboard/blocks/registry.tsx` | Comments cite "PR B1.1 (Patch 105)" — `105` confirmed | ✅ exists, partial marker match |
| `OwnerDayViewGrid` | `components/owner/tabs/OwnerDayViewGrid.tsx` | (exists; markers not read) | ✅ exists |
| `AppearanceUiTab` | `app/book/[slug]/setup/sections/AppearanceUiTab.tsx` | (exists; markers not read) | ✅ exists |
| `taxFormatting` | `lib/tax/taxFormatting.ts` | (exists; markers not read) | ✅ exists |
| `app/book/[slug]/page.tsx` | (canonical) | "PATCH 120 (SEO canonicals + meta)" at L23, "PATCH 121 (SEO canonicals + meta)" at L189 | ✅ **120+121 both confirmed** |
| `AccountTab` | `components/booking/AccountTab.tsx` | "PR A1.3 — AccountTab (thin wrapper)" | ✅ thin-wrapper status confirmed (matches "post-97" brief) |

🟡 **Finding F-FE-3a-1**: The brief's `97+98+99+101+143`-style notation doesn't appear in source — actual markers are `PR A1.1`, `PR B1.1 (Patch 105)`, `PATCH 120`. The numbering schemes correspond, but anyone trying to verify "is 143 applied?" via grep will miss. Action: settle on one marker scheme and codify in `docs/CODE_OWNERSHIP.md` or equivalent. Effort: S.

No earlier-version orphan files found alongside canonicals.

### 3b. Open branches

(See table in §0.) Specific items:

🟠 **Finding F-FE-3b-1**: `origin/add-claude-md` is **544 commits ahead of main and 3472 commits behind main**. This is not a recently-out-of-date branch; it forked from a much earlier point and accumulated work in parallel. If it carries useful changes, rebasing it onto modern main will be expensive — review the file diff first.
- **Action:** `git diff main...origin/add-claude-md --name-only` to see what's at risk. If nothing is needed, delete the remote ref.
- **Effort:** M (review only) or S (delete).

🟠 **Finding F-FE-3b-2**: `origin/dependabot/security-updates-6a4953591c` is open. The branch is named "security-updates" — typically wraps multiple security CVE upgrades. **Review priority: high**.
- **Action:** Open the PR on GitHub, review the changelog, merge if benign.
- **Effort:** S

⚪ The 5 other open Dependabot branches (`eslint-config-next-16.2.4`, `sentry/nextjs-10.50.0`, `tailwindcss-4.2.4`, `vitest-4.1.5`, `multi-d88693a43a`) are mechanical bumps — review at convenience.

⚪ `origin/pr-9-frontend-hardening` and `origin/pr-10-frontend-isolation` are 0 ahead / 1098–1092 behind — fully merged. Safe to delete.

### 3c. Patch state ledger

Last 200 commits only contain two patch-marked commits (see §0):
- `c77f35b7 Frontend PATCH 121 page.tsx: hydrate tenant title from backend tenant.name`
- `56125fd5 Frontend PATCH 121: hydrate tenant title from backend tenant.name`

Older patches (PATCH 120, PR B1.1 (Patch 105), PR A1.1, PR A1.3 etc.) are documented as in-file comments — the same pattern as `booking-backend`. The "Add files via upload (#NNN)" commits prevent inferring patch history from git alone. ⚪

### 3f. ESLint health

**Two ESLint configs exist** — both still in the repo, which is unusual:

1. **Legacy** — `.eslintrc.cjs` (7 lines):
    ```js
    module.exports = {
      root: true,
      extends: ["next/core-web-vitals", "prettier"],
      ignorePatterns: [".next/", "out/", "dist/", "node_modules/", "coverage/", ".vercel/"]
    };
    ```
2. **Flat config** — `eslint.config.mjs` (35 lines):
    ```js
    import { defineConfig, globalIgnores } from "eslint/config";
    import nextVitals from "eslint-config-next/core-web-vitals";
    import nextTs from "eslint-config-next/typescript";
    import flexrzPlugin from "./eslint-plugin-flexrz.js";

    const eslintConfig = defineConfig([
      ...nextVitals,
      ...nextTs,
      {
        plugins: { flexrz: flexrzPlugin },
        rules: { "flexrz/no-raw-price-render": "warn" },
      },
      globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
    ]);
    ```

🟡 **Finding F-FE-3f-1**: Both configs coexist. ESLint 9 (flat-config default) ignores `.eslintrc.cjs`, but if anyone falls back to ESLint 8 the legacy file takes over and the `flexrz/no-raw-price-render` rule disappears. The brief notes "flat config port is pending. `flexrz/no-raw-price-render` rule is dormant." — flat config IS now present and the rule IS wired (at `warn`). The dormancy claim in the brief is **out of date**.
- **Action:** Delete `.eslintrc.cjs`. Plan the `warn → error` flip for `flexrz/no-raw-price-render` once known violations clear.
- **Effort:** S

`package.json` has `"lint": "eslint"` script and `"build": "node scripts/check-file-sizes.mjs && next build"` — lint is *not* part of build. ⚪

---

## 4. Dead / orphan code

### 4a. Top orphans

🟠 **Finding F-FE-4a-1 — `UserAvatarButton.tsx` at repo root is essentially empty**.
- **File:** `C:/Users/Birdie 4/Desktop/Special Projects/booking-frontend/UserAvatarButton.tsx` (1 line, blank)
- The canonical 46-line component lives at `components/booking/UserAvatarButton.tsx`. The root copy is an accidental commit (orphan stub).
- **Action:** Delete the root file. No grep references to it. Effort: S.

🟡 **Finding F-FE-4a-2 — Duplicate `AuthSessionProvider.tsx`**:
- `app/AuthSessionProvider.tsx` (14 lines) — uses `captureGoogleTokenFromHash` from `@/lib/auth/centralToken`.
- `components/AuthSessionProvider.tsx` (22 lines) — uses `captureGoogleIdTokenFromFragment` from `@/lib/auth/centralToken`.
- **`app/layout.tsx:4` imports the canonical `components/` version** (`import AuthSessionProvider from "@/components/AuthSessionProvider";`).
- `app/AuthSessionProvider.tsx` is dead code. Both functions exist in `lib/auth/centralToken.ts`, so the orphan isn't broken — it's just unused.
- **Action:** Delete `app/AuthSessionProvider.tsx`. Effort: S.

⚪ The `lib/theme/bookingTokenRegistry/` subtree is well-modularized — `buttons.ts`, `card-header.ts`, `colors.ts`, `controls.ts`, `drawer.ts`, `errors.ts`, `glass.ts`, `index.ts`, `labels.ts` etc. No orphans there.

---

## 7. Package versions

From `package.json`:

| Field | Value |
|---|---|
| `engines.node` | **NOT declared** 🟡 |
| `next` | `16.0.7` |
| `react` | `19.2.0` |
| `react-dom` | `19.2.0` |
| `next-auth` | `^4.24.7` |
| `@sentry/nextjs` | `^10.42.0` |
| `typescript` | `^5` (devDep) |
| `eslint` | `^9` (devDep) |
| `eslint-config-next` | `16.0.7` (devDep) |
| `@playwright/test` | `^1.58.2` (devDep) |
| `tailwindcss` | `^4` (devDep) |
| `vitest` | `^2.1.0` (devDep) |
| `@vitest/coverage-v8` | `^2.0.0` (devDep) |
| `@tailwindcss/postcss` | `^4` (devDep) |
| `@types/node` | `^20` (devDep) |
| `@types/react` | `^19` (devDep) |
| `@types/react-dom` | `^19` (devDep) |

🟡 **Finding F-FE-7-1**: No `engines.node`. Pin to `>=20`. Effort: S.

🟡 **Finding F-FE-7-2**: Open Dependabot bumps that should be reviewed in priority order:
1. `dependabot/security-updates-6a4953591c` — security (high)
2. `dependabot/sentry/nextjs-10.50.0` — 10.42 → 10.50 (medium)
3. `dependabot/eslint-config-next-16.2.4` — 16.0.7 → 16.2.4 (medium)
4. `dependabot/tailwindcss-4.2.4` — 4.x patch (low)
5. `dependabot/vitest-4.1.5` — 2.x → 4.x major (medium — verify breaking changes)
6. `dependabot/multi-d88693a43a` — multi-package (review changelog)

---

## Summary: 0 🔴 critical, 6 🟠 high, 9 🟡 medium, 5 ⚪ info findings.

**Top three to action:**
1. 🟠 **F-FE-2c-2** — `components/booking/UserAvatarButton.tsx:28` renders "Welcome to Birdie Golf" as a hardcoded string. Every non-Birdie tenant sees that. Cross-tenant brand bleed. (Bonus: there's also an empty orphan copy of the file at the repo root — F-FE-4a-1.)
2. 🟠 **F-FE-3b-2** — `origin/dependabot/security-updates-6a4953591c` open. Review and merge / close.
3. 🟠 **F-FE-3b-1** — `origin/add-claude-md` is 544 ahead / 3472 behind. Triage what (if anything) needs salvaging before deleting.

**Reconciliation note:** The brief states "`flexrz/no-raw-price-render` rule is dormant" — that's **out of date**. The flat config exists and registers the rule at `warn`. Both configs coexist; the legacy `.eslintrc.cjs` should be deleted.
