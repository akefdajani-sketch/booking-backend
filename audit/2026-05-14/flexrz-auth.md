# flexrz-auth — Audit Report (2026-05-14)

**Audited by:** main-context fallback (subagent was sandboxed out of the sibling-repo path)
**Repo path:** `C:/Users/Birdie 4/Desktop/Special Projects/flexrz-auth`
**Threshold for "large file":** > 500 lines

---

## 0. Working tree state

- **Current branch:** `main`
- **Working tree:** clean (no dirty files)
- **Last commit:** `dacd4c9 Merge pull request #1 from akefdajani-sketch/add-claude-md`
- **Branches:**
  - Local: `main` (current), `add-claude-md`
  - Remote: `origin/main`, `origin/add-claude-md`, `origin/HEAD -> origin/main`
- Audit proceeds against `main` as-is (no stash).

### Commit-history note (⚪ info)

The recent history is unusual — 100+ consecutive `"Add files via upload"` commits and `"Delete <X> directory"` commits, suggesting the repo was bootstrapped by uploading files through the GitHub web UI rather than a developer workflow. There is little signal in the commit log for archaeology. This is not a bug — just a constraint when using `git log` to understand intent.

---

## 1. File size hot spots (threshold: > 500 lines)

**No files exceed the 500-line threshold.** This is a small, focused repo (1,493 LOC across 16 files).

Full LOC table (descending) for situational awareness:

| LOC | File | Primary responsibility |
|---:|---|---|
| 375 | `lib/auth/options.ts` | NextAuth options: providers, JWT minting, redirect callback, cookies |
| 213 | `app/return/route.ts` | Post-sign-in bounce; mints handoff JWT for custom-domain tenants |
| 190 | `app/auth/signin/SignInCard.tsx` | Branded Google sign-in card (client component) |
| 179 | `app/bridge/route.ts` | Custom-domain login handoff (signed-JWT-in-fragment) |
| 140 | `middleware.ts` | Cookie-sets `flexrz-callback-url` / `flexrz-return-to`; tenant-domain redirect |
| 140 | `app/auth/signin/page.tsx` | Server sign-in page: sanitizes callbackUrl, renders `SignInCard` |
| 114 | `app/auth/signout/SignoutClient.tsx` | Client sign-out: sanitizes callbackUrl then calls `signOut()` |
| 46  | `app/auth/error/page.tsx` | Auth error display |
| 38  | `app/api/auth/set-callback/route.ts` | POST that overwrites callback-url cookies |
| 18  | `app/layout.tsx` | Root layout (inline styles) |
| 12  | `app/page.tsx` | Marketing/home placeholder |
| 12  | `app/auth/signout/page.tsx` | Server wrapper for `SignoutClient` |
| 6   | `next.config.js` | Next config (reactStrictMode only) |
| 6   | `app/api/auth/[...nextauth]/route.ts` | NextAuth handler binding |
| 2   | `sentry.client.config.ts` | Sentry placeholder (not installed) |
| 2   | `instrumentation.ts` | Sentry placeholder (not installed) |

No split candidates.

---

## 2. Bug inventory

### 2a. TODO / FIXME / HACK / XXX census

**Zero occurrences** across all source files. The codebase uses inline `// HARDENING:`, `// NOTE:`, and `// IMPORTANT:` comments instead — those are not flagged as bug markers.

### 2b. `any` and `@ts-ignore`

- **`any` count:** 34 occurrences across 6 files (all `.ts` / `.tsx`).
- **`@ts-ignore` / `@ts-expect-error`:** **0** — no suppressions anywhere. ⚪

| File | `any` count | Pattern |
|---|---:|---|
| `lib/auth/options.ts` | 15 | Mostly `(token as any).<field>`, `(profile as any)`, `(account as any)` to read NextAuth JWT extension fields not in their typings. |
| `app/return/route.ts` | 8 | Same pattern — `(token as any)?.google_id_token`, `(decoded as any)?.email`, etc. |
| `app/bridge/route.ts` | 8 | Same — reading NextAuth `getToken()` return into untyped helper functions. |
| `app/auth/signout/SignoutClient.tsx` | 1 | Single inline guard. |
| `middleware.ts` | 1 | `const json = (await res.json()) as any;` — backend response shape not typed. |
| `app/auth/signin/page.tsx` | 1 | Same — JSON response cast. |

**Finding F-AUTH-2b-1 — 🟡 medium**
The 34 `any` casts are concentrated in OAuth-callback / JWT-extension code where NextAuth's typings don't reach extension fields like `app_jwt`, `google_id_token`. This is the same pattern in every file and is structural.
- **File:** `lib/auth/options.ts:179`, `lib/auth/options.ts:291–303`, `app/return/route.ts:174–179`, `app/bridge/route.ts:163–165`
- **Action:** Introduce a single shared `FlexrzAugmentedToken` type and module-augment NextAuth's `JWT` / `Session` interfaces in a `types/next-auth.d.ts`. Removes ~25 of the 34 casts.
- **Effort:** S

### 2c. Hardcoded magic values

#### Hex colors (no tokens.css in this repo)

| File:Line | Color | Context |
|---|---|---|
| `app/layout.tsx:10` | `#f8fafc` | Body background |
| `app/layout.tsx:11` | `#0f172a` | Body text color |
| `app/auth/signin/SignInCard.tsx:18,22,26,30` | `#FFC107`, `#FF3D00`, `#4CAF50`, `#1976D2` | Google logo brand colors (SVG paths — intentional, ⚪ info) |
| `app/auth/signin/SignInCard.tsx:70,71,81,94,104,122,141,142,154,175` | 10× slate/zinc hex literals | Inline JSX styles on the sign-in card |

**Finding F-AUTH-2c-1 — 🟡 medium**
The sign-in card uses inline-style hex literals for the entire brand surface (12 of the 16 hex hits are on this one component). No `tokens.css` or theme system exists in this repo.
- **File:** `app/auth/signin/SignInCard.tsx:65–166`, `app/layout.tsx:5–13`
- **Action:** Either introduce a minimal `tokens.css` shared with the frontend repo (preferred — keep palette identity in sync) or accept the divergence and document it. Do NOT change the Google-logo SVG colors (they are brand-mandated).
- **Effort:** M

#### Hardcoded URLs

| File:Line | URL | Notes |
|---|---|---|
| `middleware.ts:31` | `https://flexrz.com` | Used as base for relative paths in `resolveAndValidateReturnTo` — OK as marketing fallback. |
| `app/return/route.ts:134` | `https://flexrz.com/book/birdie-golf?dbg_fallback=...` | 🟠 **Hardcoded tenant slug** in production fallback — see F-AUTH-2c-2. |
| `app/bridge/route.ts:126,130` | `https://flexrz.com` | Fallback redirect when returnTo missing/disallowed — OK. |
| `lib/auth/options.ts:196` | `https://auth.flexrz.com` | Used as `AUTH_ORIGIN` last-resort fallback — OK (auth-origin literal). |
| `app/auth/error/page.tsx:37` | `https://flexrz.com` | "Go to Flexrz" button — OK. |
| `app/auth/signout/SignoutClient.tsx:60` | `https://flexrz.com` | Fallback origin — OK. |
| `app/auth/signin/page.tsx:64` | `https://flexrz.com` | Fallback origin in `sanitizeCallbackUrl` — OK. |
| `app/api/auth/set-callback/route.ts:12` | `https://flexrz.com/` | Default `safe` value if validation fails — OK. |
| `app/auth/signin/SignInCard.tsx:13` | `http://www.w3.org/2000/svg` | SVG namespace literal — ⚪ ignore. |

**Finding F-AUTH-2c-2 — 🟠 high**
`app/return/route.ts:134` hardcodes the tenant slug `birdie-golf` in the production fallback URL: `https://flexrz.com/book/birdie-golf?dbg_fallback=auth_return_fallback`. If `normalizeReturnUrl()` fails for any reason (e.g. tenant-domain lookup down, network blip), every user is funnelled to **Birdie Golf**'s booking page — regardless of who they were trying to reach. For demo tenants this is bad UX; for paying tenants it's a cross-tenant leak (a customer trying to book at Tenant X lands at Tenant Y's booking page).
- **File:** `app/return/route.ts:134`
- **Action:** Replace with a non-tenant generic page (`https://flexrz.com/` or `https://flexrz.com/auth-error`) and pass the original `from=<host>` so the marketing page can offer "Go to <tenant>" instead.
- **Effort:** S
- **Cross-ref:** This is the most user-visible bug in the auth repo.

#### Hardcoded brand strings

`birdie-golf` appears as a hardcoded slug in `app/return/route.ts:134` (covered above). No other brand strings like `"Birdie Draft Test"` or `"Birdie Golf"` appear.

### 2d. `console.*` in production paths

**28 occurrences** total. Many are gated by `DEBUG` / `NEXTAUTH_DEBUG`, but a substantial subset is unconditional.

| File:Line | Method | Gated? | Notes |
|---|---|---|---|
| `lib/auth/options.ts:157` | `console.error` | always | `[NextAuth error]` — NextAuth logger.error hook. Fine. |
| `lib/auth/options.ts:160` | `console.warn` | always | NextAuth logger.warn hook. Fine. |
| `lib/auth/options.ts:165` | `console.debug` | yes (`NEXTAUTH_DEBUG`) | Fine. |
| `lib/auth/options.ts:178–180` | `console.info` (×3) | yes (`AUTH_DEBUG_SIGNIN` or `NEXTAUTH_DEBUG`) | Fine. |
| `lib/auth/options.ts:210, 231, 239, 243, 248, 257–260, 270, 274, 277` | `console.info`/`warn` (×12) | yes (`AUTH_DEBUG_REDIRECT`) | Fine. |
| `lib/auth/options.ts:300` | `console.log("[NextAuth jwt] minted app_jwt for", ...email)` | **always** | 🟡 PII (email) logged on every sign-in. |
| `lib/auth/options.ts:302` | `console.warn` | always | Operational warning if secret missing — fine. |
| `lib/auth/options.ts:324` | `console.log("[NextAuth event:signIn]", ...email or name)` | **always** | 🟡 PII on every sign-in. |
| `lib/auth/options.ts:327` | `console.log("[NextAuth event:signOut]", message)` | **always** | Less PII risk — message may include token shape. |
| `lib/auth/options.ts:330` | `console.log("[NextAuth event:session]", ...email)` | **always** | 🟡 PII on every session fetch (potentially very chatty). |
| `app/auth/signin/page.tsx:115–119` | `console.info` (×5) | yes (`AUTH_DEBUG_SIGNIN`) | Fine. |

**Finding F-AUTH-2d-1 — 🟡 medium**
Four unconditional `console.log`/`info` lines in `lib/auth/options.ts` (events.signIn:324, events.signOut:327, events.session:330, jwt:300) log user email or full message objects on every auth event. The `session` event in particular fires every time the cookie is touched and will produce a large volume of email-tagged logs in Vercel.
- **File:** `lib/auth/options.ts:300, 324, 327, 330`
- **Action:** Gate the unconditional event logs behind `NEXTAUTH_DEBUG === "true"` (consistent with the rest of the file), or downgrade to `console.info` with an explicit "no PII" payload (`sub` instead of `email`).
- **Effort:** S
- **GDPR/SOC2 angle:** docs reference `docs/GDPR_SOC2.md` in the backend — verify this volume of email-tagged logs in Vercel is in scope of that policy.

### 2e. Stale closure / ref pattern risk

Only one `useEffect` block in the whole repo, in `SignoutClient.tsx:95`. Its dep array is `[searchParams]` and the closure correctly captures `cancelled`. **No risk found.** ⚪

### 2f. Schema drift

N/A — this repo has no database. ⚪

### 2g. Known landmines

| Check | Result |
|---|---|
| `lib/auth/options.ts` uses `NODE_ENV === "production"` for Secure-cookie gating (lines 338, 345, 346, 351, 357, 363, 370) | ⚪ Expected for cookie naming/security — this is the canonical NextAuth pattern. |
| Custom-domain handoff secret reuse: `BOOKING_HANDOFF_SECRET || NEXTAUTH_SECRET` (`app/return/route.ts:169`, `app/bridge/route.ts:81`) | ✅ See F-AUTH-2g-1 — CLOSED, secrets set distinctly in prod. |
| `app_jwt` secret reuse: `FLEXRZ_APP_JWT_SECRET || NEXTAUTH_SECRET` (`lib/auth/options.ts:34–36`) | ✅ See F-AUTH-2g-1 — CLOSED, secrets set distinctly in prod. |

**Finding F-AUTH-2g-1 — 🟠 high (security)**
Three different secrets fall back to `NEXTAUTH_SECRET` when not configured:
1. `FLEXRZ_APP_JWT_SECRET` (used to sign 30-day app JWTs validated by the backend).
2. `BOOKING_HANDOFF_SECRET` in `/return` (used to sign 90-second custom-domain handoff JWTs).
3. `BOOKING_HANDOFF_SECRET` in `/bridge` (same purpose).

If `NEXTAUTH_SECRET` is the only env var actually set in prod (likely, given the simplicity of this repo's deploy), then the *session-cookie HMAC key* and the *long-lived backend-API JWT key* and the *cross-domain handoff JWT key* are **the same secret**. This means: a leak of `NEXTAUTH_SECRET` is a complete compromise of all three trust domains, and rotation requires invalidating every user's session at once.

- **File:** `lib/auth/options.ts:33–37`, `app/return/route.ts:169`, `app/bridge/route.ts:80–82`
- **Action:**
  1. Audit Vercel env to confirm whether `FLEXRZ_APP_JWT_SECRET` and `BOOKING_HANDOFF_SECRET` are actually set distinctly in prod (cannot verify from code alone).
  2. If they're sharing `NEXTAUTH_SECRET`, generate and set distinct secrets.
  3. Consider removing the fallback so a missing secret fails closed (return 500) rather than silently sharing keys.
- **Effort:** M (env work + safer fallback path)
- **Cross-ref:** This is the highest-severity finding in the repo.

> **CLOSED — Investigated 2026-05-14.** Verified all three secrets set distinctly in Vercel/Render production env: `FLEXRZ_APP_JWT_SECRET`, `BOOKING_HANDOFF_SECRET`, and `NEXTAUTH_SECRET` are configured as independent values across flexrz-auth (Vercel) and booking-frontend (Vercel); booking-backend (Render) has `FLEXRZ_APP_JWT_SECRET` set correctly and does not need `BOOKING_HANDOFF_SECRET` (the backend does not validate handoff JWTs). The `|| NEXTAUTH_SECRET` fallback in source never engages in production. No code change required. Finding closed as already-resolved (Branch A). Residual: optional Phase 4 hardening (fail closed on missing secret) — see INDEX.md follow-ups.

**Finding F-AUTH-2g-2 — 🟡 medium**
`app/return/route.ts:163` swallows handoff failures silently with `try {…} catch {}` — comment says "Never break redirect on handoff failures; custom domain will simply appear logged out." That's defensible, but the catch logs nothing, so a misconfigured secret produces a silent "logged out" experience on custom domains with no breadcrumb.
- **File:** `app/return/route.ts:206–208`
- **Action:** Log the error under `AUTH_DEBUG_REDIRECT` flag at minimum.
- **Effort:** S

### 2h. Multi-tenant isolation risk

N/A — this repo has no DB queries scoped by tenant. The only "tenant" interaction is the public domain-resolve fetch (`/api/tenant-domains/_public/resolve`), which is unauthenticated by design. ⚪

The fallback-tenant-slug issue (F-AUTH-2c-2) is the closest analogue to a cross-tenant concern.

### 2i. Missing auth middleware

Routes:

| Path | Method | Auth model | Notes |
|---|---|---|---|
| `/api/auth/[...nextauth]` | GET/POST | NextAuth itself | Standard NextAuth handler. |
| `/api/auth/set-callback` | POST | None | Sets `__Secure-next-auth.callback-url` cookie. Validates host allowlist before setting (line 16). ⚪ |
| `/auth/signin` | GET (server) | None | Public sign-in page — must be unauth. ⚪ |
| `/auth/signout` | GET (server) | None | Triggers `signOut()` client-side. ⚪ |
| `/auth/error` | GET (server) | None | Error display. ⚪ |
| `/bridge` | GET (route handler) | Calls `getToken()` — soft auth (redirects to /signin if no token). ⚪ |
| `/return` | GET (route handler) | Calls `getToken()` — soft auth (uses fallback if no token). ⚪ |
| `/` | GET (server) | None | Public placeholder. ⚪ |

All routes have appropriate auth posture for an auth broker. **No missing-auth findings.** ⚪

---

## 3. Pending works inventory

### 3b. Open branches

Only one local branch differs from `main`:

| Branch | Ahead | Behind | Last commit | Files changed | Summary |
|---|---:|---:|---|---:|---|
| `add-claude-md` | 1 | 0 | `2ae5fa0 Add CLAUDE.md for Claude Code (2026-05-10)` | 1 | Adds a `CLAUDE.md` describing the repo to Claude Code. |

This branch was merged into `main` via PR #1 (`dacd4c9`); the local branch ref still exists but is fully merged. **Safe to delete locally** (you may want to keep it).

No other unmerged work. ⚪

### 3c. Patch state ledger

Searched last 200 commits for `PATCH \d+`, `POLISH-\d+`, `SIZE-\d+`, `VOICE-FIX-\d+`, `FIX-M-\w+`, `PR \w+\d+` markers.

**Zero matches.** This repo does not participate in the shared patch-ledger naming scheme used by `booking-backend` / `booking-frontend`. ⚪

### 3f. ESLint health

**No ESLint configuration in the repo:**
- No `.eslintrc*` files.
- No `eslint.config.*` files.
- `package.json` does not declare ESLint as a dep, nor a `lint` script.

🟡 **Finding F-AUTH-3f-1**: The auth broker has no lint baseline. Given it handles OAuth callbacks, redirect validation, and JWT signing, lint coverage (`no-floating-promises`, `no-implicit-coercion`, `@typescript-eslint/no-unsafe-*`) would surface real risks.
- **Action:** Add a minimal flat-config ESLint (TS + React + Next presets). Optionally adopt the same plugin set as `booking-frontend` for consistency.
- **Effort:** M

---

## 4. Dead / orphan code

### 4a. Unreferenced files

Verified imports for every source file:

| File | Imported by | Status |
|---|---|---|
| `app/api/auth/[...nextauth]/route.ts` | (route — Next.js convention) | ⚪ alive |
| `app/api/auth/set-callback/route.ts` | (route — called by `SignInCard.tsx:48`) | ⚪ alive |
| `app/auth/error/page.tsx` | (route — Next.js convention; referenced by `authOptions.pages.error`) | ⚪ alive |
| `app/auth/signin/page.tsx` | (route) | ⚪ alive |
| `app/auth/signin/SignInCard.tsx` | imported by `app/auth/signin/page.tsx:4` | ⚪ alive |
| `app/auth/signout/page.tsx` | (route) | ⚪ alive |
| `app/auth/signout/SignoutClient.tsx` | imported by `app/auth/signout/page.tsx` | ⚪ alive |
| `app/bridge/route.ts` | (route) | ⚪ alive |
| `app/layout.tsx` | (Next.js convention) | ⚪ alive |
| `app/page.tsx` | (Next.js convention) | ⚪ alive |
| `app/return/route.ts` | (route) | ⚪ alive |
| `instrumentation.ts` | (Next.js convention — placeholder) | ⚪ alive (but a no-op) |
| `lib/auth/options.ts` | imported by `app/api/auth/[...nextauth]/route.ts:2` and `app/auth/signin/page.tsx:3` | ⚪ alive |
| `middleware.ts` | (Next.js convention) | ⚪ alive |
| `next-env.d.ts` | TS reference | ⚪ alive (generated) |
| `next.config.js` | (Next.js convention) | ⚪ alive |
| `sentry.client.config.ts` | not referenced (Sentry not installed) | 🟡 see below |

**Finding F-AUTH-4a-1 — 🟡 medium**
`sentry.client.config.ts` and `instrumentation.ts` are both two-line placeholders explicitly noting "Sentry not installed in this repo" (commits `6c0dc4c`, `1c53b2a`, `80f19bb` rolled Sentry back). They're harmless but advertise an integration that doesn't exist.
- **File:** `sentry.client.config.ts:1-2`, `instrumentation.ts:1-2`
- **Action:** Either re-install Sentry (the booking-backend uses it and shares Vercel infra), or remove the placeholder files. Sentry is high-ROI on an auth broker — every silent OAuth failure is a paying-customer drop-off.
- **Effort:** M (install + wire), S (delete)

---

## 7. Package versions

From `package.json`:

| Field | Value |
|---|---|
| `engines.node` | **NOT DECLARED** (🟡 — see F-AUTH-7-1) |
| `next` | `16.0.7` |
| `react` | `19.0.0` |
| `react-dom` | `19.0.0` |
| `next-auth` | `^4.24.11` |
| `typescript` | `^5.4.5` (devDep) |
| `@types/node` | `^20.11.30` (devDep) |
| `@types/react` | `^18.2.66` (devDep) — **mismatch with React 19** |
| `@types/react-dom` | `^18.2.22` (devDep) — **mismatch with React 19** |
| `pg`, `stripe`, `@anthropic-ai/sdk`, `@sentry/*` | not present (none expected for an auth broker) |

**Finding F-AUTH-7-1 — 🟡 medium**
- No `engines.node` constraint. Vercel will pick a default that may drift over time. Pin to `>=20`.
- `@types/react` and `@types/react-dom` are on `^18.x` while `react` and `react-dom` are on `19.0.0`. Bump types to `^19.x` to keep TS in sync with React 19's API surface (e.g. `use()`, `<Suspense>` boundary types).
- **Effort:** S

**Cross-repo drift note**: `booking-frontend` is on `next@16` + `react@19` as well (per the audit brief). Confirm types align across both repos when the frontend audit lands.

---

## Summary: 0 🔴 critical, 2 🟠 high (+1 closed), 6 🟡 medium, 0 ⚪ info findings.

**Top to action:**
1. 🟠 **F-AUTH-2c-2** — `birdie-golf` hardcoded in production fallback URL at `app/return/route.ts:134`. Replace with a non-tenant page.
2. 🟡 **F-AUTH-2d-1** — Four unconditional `console.log` lines emit user email on every sign-in / sign-out / session fetch. Gate behind `NEXTAUTH_DEBUG`.

**Closed:**
- ✅ **F-AUTH-2g-1** (was 🟠 high) — Investigated 2026-05-14, verified all three secrets set distinctly in prod env. False alarm; no code change required.
