# flexrz-auth Repo Audit — May 17, 2026

**Audited by:** S1 (parallel session, read-only)
**Repo path:** `C:/Users/Birdie 4/Desktop/Special Projects/flexrz-auth`
**Scope:** All source files (`.js`/`.jsx`/`.ts`/`.tsx`) outside `node_modules`, `.git`, `.next`
**Note:** An earlier `audit/2026-05-14/flexrz-auth.md` exists in this repo. The May 14 audit used a >500L threshold and reported "no files exceed". This audit uses the standard project buckets and goes deeper into auth surface + integration flow.

---

## Inventory

| | |
|---|---|
| Repo path | `C:/Users/Birdie 4/Desktop/Special Projects/flexrz-auth` |
| Total source files (`.ts`/`.tsx`/`.js`) | **17** |
| Total LOC (source) | **~1,503** |
| File-size distribution | 🟢 15 · 🟡 2 · 🟠 0 · 🔴 0 · 🚨 0 |
| Last commit on `main` | `dacd4c9` — *Merge pull request #1 from akefdajani-sketch/add-claude-md* (Sun May 10, 2026) |
| Branch state | `main` clean, only branches: `main`, `add-claude-md` |
| Tests | **None.** No `__tests__/`, no `*.test.*` files, no test framework in `package.json` |
| Framework | Next.js 16.0.7, React 19.0.0, NextAuth 4.24.11 |
| TypeScript | Yes — `^5.4.5` |

### File-count by extension

| Ext | Count |
|---|---:|
| `.ts` | 9 |
| `.tsx` | 7 |
| `.md` | 3 |
| `.json` | 2 |
| `.js` | 1 (next.config.js) |
| `.svg` | 1 |
| `.example` | 1 |

---

## File-size hot list

Buckets: 🟢 <200L · 🟡 200–400L · 🟠 400–600L · 🔴 600–800L · 🚨 >800L

| File | Lines | Status |
|---|---:|---|
| `lib/auth/options.ts` | 383 | 🟡 |
| `app/return/route.ts` | 213 | 🟡 |
| `app/auth/signin/SignInCard.tsx` | 190 | 🟢 |
| `app/bridge/route.ts` | 179 | 🟢 |
| `middleware.ts` | 140 | 🟢 |
| `app/auth/signin/page.tsx` | 140 | 🟢 |
| `app/auth/signout/SignoutClient.tsx` | 114 | 🟢 |
| `app/auth/error/page.tsx` | 46 | 🟢 |
| `app/api/auth/set-callback/route.ts` | 38 | 🟢 |
| `app/layout.tsx` | 18 | 🟢 |
| `app/page.tsx` | 12 | 🟢 |
| `app/auth/signout/page.tsx` | 12 | 🟢 |
| `app/api/auth/[...nextauth]/route.ts` | 6 | 🟢 |
| `next.config.js` | 6 | 🟢 |
| `sentry.client.config.ts` | 2 | 🟢 |
| `next-env.d.ts` | 2 | 🟢 |
| `instrumentation.ts` | 2 | 🟢 |

**Conclusion:** small, tight repo. Largest file (`lib/auth/options.ts`) is at 383L and could grow with new providers — keep an eye on it but no split needed today.

---

## Auth surface

### NextAuth providers
- **Google** (only). Configured in `lib/auth/options.ts` with `access_type: offline`, `prompt: consent`, `response_type: code`, `scope: "openid email profile"`. No Apple / Facebook / Magic-link / Email / Credentials providers.

### Session strategy
- **JWT** (no DB-backed sessions).
- `maxAge = 30 days`, `updateAge = 6h` (re-issue session JWT every 6h).
- JWT itself also has `maxAge = 30 days`.

### Custom callbacks (in `lib/auth/options.ts`)
- **`signIn`** — pure observability (logs when `AUTH_DEBUG_SIGNIN=1`). Always returns `true`.
- **`redirect`** — heavily fortified. Handles: nested-`callbackUrl` strip, double-decode, `flexrz.com` / `*.flexrz.com` / `localhost` / `127.0.0.1` / `*.local` allow list + env-driven `AUTH_ALLOWED_CUSTOM_REDIRECT_HOSTS`. Marketing-root and bare-root bounces are explicitly rewritten through `/return`. Anti-loop guard: blocks `auth.flexrz.com/auth/*` as a callback target.
- **`jwt`** — on initial sign-in (`account.provider === "google"`), captures the Google `id_token` AND mints a **Flexrz App JWT** (HS256, 30-day expiry, `iss: "auth.flexrz.com"`, signed with `FLEXRZ_APP_JWT_SECRET` falling back to `NEXTAUTH_SECRET`).
- **`session`** — exposes `google_id_token`, `app_jwt`, and `tokenError` on the session object so the booking frontend can read both.
- **`events`**: `signIn`/`signOut`/`session` log only when `NEXTAUTH_DEBUG=true`.

### Custom routes / pages
- `app/auth/signin/page.tsx` (140L) + `app/auth/signin/SignInCard.tsx` (190L) — branded Google sign-in card. Calls `fetch('/api/auth/set-callback?callbackUrl=…')` *before* `signIn('google')` to harden the callback-url cookie.
- `app/auth/signout/page.tsx` + `SignoutClient.tsx` (114L) — branded sign-out with callback-url sanitisation.
- `app/auth/error/page.tsx` (46L) — error page.
- `app/return/route.ts` (213L) — post-sign-in bounce; mints handoff JWT for custom tenant domains.
- `app/bridge/route.ts` (179L) — explicit bridge endpoint for custom-domain logins (separate entrypoint from `/return`).
- `app/api/auth/set-callback/route.ts` (38L) — pre-signin cookie writer.
- `app/api/auth/[...nextauth]/route.ts` (6L) — standard NextAuth handler.

### Middleware (`middleware.ts`, 140L)
- Matcher: `/auth/signin`, `/api/auth/:path*`, `/tenant/:path*`.
- On `/api/auth/callback/*`: pulls `flexrz-callback-url` cookie or `flexrz-return-to` cookie, validates against allowlist + registered tenant domains (live `fetch` to backend `/api/tenant-domains/_public/resolve`), then writes `__Secure-next-auth.callback-url` cookies.
- On `/auth/signin`: sanitises `callbackUrl` / `returnTo` query params via the same validator.
- On `/tenant/*`: forces redirect to `app.flexrz.com` if user landed on the wrong host.

### Cookie configuration (production)
| Cookie | `httpOnly` | `secure` | `sameSite` | `domain` | Prefix |
|---|:-:|:-:|:-:|---|---|
| `next-auth.session-token` | ✅ | ✅ | `lax` | `.flexrz.com` | `__Secure-` |
| `next-auth.callback-url` | ❌ (default) | ✅ | `lax` | `.flexrz.com` | `__Secure-` |
| `next-auth.csrf-token` | ✅ | ✅ | `lax` | *(none — required by `__Host-`)* | `__Host-` |
| `flexrz-callback-url` | ❌ | ✅ | `lax` | `.flexrz.com` | none |
| `flexrz-return-to` | ❌ | ✅ | `lax` | `.flexrz.com` | none |
| `flexrz-handoff` (URL fragment, not cookie) | n/a | n/a | n/a | n/a | n/a |
| `flexrz_last_tenant` | ❌ | n/a | n/a | n/a | none — read only |

---

## Environment variables (keys only)

Read by source files in this repo:

| Key | Read by | Required? |
|---|---|---|
| `NEXTAUTH_URL` | `lib/auth/options.ts` (redirect callback) | Yes (in prod) |
| `NEXTAUTH_SECRET` | `lib/auth/options.ts`, `app/return/route.ts`, `app/bridge/route.ts` | Yes |
| `NEXTAUTH_DEBUG` | `lib/auth/options.ts` (events + debug logger) | Optional |
| `GOOGLE_CLIENT_ID` | `lib/auth/options.ts` | Yes |
| `GOOGLE_CLIENT_SECRET` | `lib/auth/options.ts` | Yes |
| `FLEXRZ_APP_JWT_SECRET` | `lib/auth/options.ts` (`mintFlexrzAppJwt`) | Yes (falls back to `NEXTAUTH_SECRET` if absent) |
| `BOOKING_HANDOFF_SECRET` | `app/return/route.ts`, `app/bridge/route.ts` | Yes (falls back to `NEXTAUTH_SECRET`) |
| `NEXT_PUBLIC_BACKEND_URL` / `BACKEND_URL` / `NEXT_PUBLIC_API_BASE_URL` | `app/return/route.ts`, `app/bridge/route.ts`, `middleware.ts`, `SignoutClient.tsx` | Yes — needed for `tenant-domains/_public/resolve` calls |
| `NEXT_PUBLIC_APP_HOST` | `middleware.ts`, `app/return/route.ts` | Yes (defaults to `app.flexrz.com` if absent) |
| `AUTH_ALLOWED_CUSTOM_REDIRECT_HOSTS` | `lib/auth/options.ts` (redirect callback) | Optional |
| `AUTH_DEBUG_SIGNIN` | `lib/auth/options.ts` | Optional |
| `AUTH_DEBUG_REDIRECT` | `lib/auth/options.ts` | Optional |
| `NODE_ENV` | `lib/auth/options.ts` (cookie naming) | Set by host |

---

## Security observations

(Non-actionable — just observations. No fixes attempted per session brief.)

### ✅ Solid

1. **HTTPS-only redirects.** `resolveAndValidateReturnTo` in `middleware.ts` and `normalizeReturnUrl` in `app/return/route.ts` both reject any non-`https:` URL (except localhost).
2. **Allowlist-based host validation, with tenant-domain check via live backend call.** No regex-based passes; explicit eTLD+1 matching plus dynamic check against `/api/tenant-domains/_public/resolve`.
3. **Handoff JWT lifetime is short.** `app/return/route.ts` mints with `exp = now + 90s`; `app/bridge/route.ts` mints with `exp = now + 5min`. Domain-bound via `dest` claim.
4. **Handoff JWT travels in the URL fragment (`#flexrz_handoff=…`)**, not query string — never sent over the wire to the destination's server. Documented inline in both routes.
5. **`__Host-next-auth.csrf-token` uses the `__Host-` prefix correctly** (no Domain attribute), which prevents subdomain takeover from forging the CSRF cookie.
6. **Session cookie is httpOnly + secure + sameSite=lax**, as expected.
7. **No hardcoded secrets** in source. All secrets read from `process.env`.
8. **Sign-in flow strips nested `callbackUrl=` redirects up to 3 levels** (`stripNestedCallbackUrl`). This blocks the common open-redirect pattern.
9. **Marketing-root bounce protection.** `lib/auth/options.ts:222-234` actively rewrites any redirect to `flexrz.com/` through `/return` instead, so users never get dumped on the marketing root after sign-in.

### 🟡 Worth a closer look (observations, not findings)

10. **`FLEXRZ_APP_JWT_SECRET` falls back to `NEXTAUTH_SECRET` when absent** (`lib/auth/options.ts:33-37`). Two roles, one secret — if `NEXTAUTH_SECRET` rotates, the 30-day app JWT becomes the rate limiter on how long users stay signed in. Document this coupling or split the secrets.
11. **`BOOKING_HANDOFF_SECRET` also falls back to `NEXTAUTH_SECRET`** (`app/return/route.ts:169`, `app/bridge/route.ts:81`). Same coupling as #10.
12. **No revocation / blacklist for the Flexrz App JWT.** 30-day lifetime, HS256-signed. If a token leaks, the only mitigations are: rotate `FLEXRZ_APP_JWT_SECRET` (kills all sessions) or wait for expiry. There's no `kid`, no `jti`, no DB-backed denylist.
13. **No refresh-token flow.** Google `access_type: offline` is requested but the refresh token is not persisted in the NextAuth JWT (the comment at the top of `options.ts:5-8` says this is deliberate to keep the cookie small). Net effect: after 30 days, users re-auth from scratch. Documented in source; not necessarily a bug.
14. **`session.app_jwt` is exposed to the client** (`lib/auth/options.ts:318`). This is by design — the booking frontend reads it to inject `Authorization: Bearer <app_jwt>` into backend calls — but it means the long-lived Flexrz App JWT is XSS-reachable. Compare to the Google `id_token`, which historically was server-only.
15. **Live `fetch` to backend `/api/tenant-domains/_public/resolve` runs inside middleware** (`middleware.ts:18`). Cached with `revalidate: 60`. If the backend is down or slow during sign-in, redirect validation fails closed (returns `false` → callback drops). Worth a tracer/timeout review.
16. **`mintFlexrzAppJwt` swallows errors silently** (`lib/auth/options.ts:50-54`). If signing throws, the user signs in with no `app_jwt` and the backend will reject their API calls without any clear log line. Compare to the explicit `console.warn` two lines later when the secret is missing.
17. **Sign-in form sets `httpOnly: false` on the callback-url cookie** (`app/api/auth/set-callback/route.ts:27`). This is intentional — NextAuth needs to read it client-side — but the cookie value contains a full URL including potential PII (tenant slugs).
18. **No rate limiting on `/api/auth/set-callback`** (or any auth-side route). Could be hit repeatedly to overwrite the cookie. Low impact — only effect is redirecting the user post-signin.
19. **No CSP / security headers configured.** `next.config.js` is minimal (6 lines). All security headers come from Vercel defaults or are absent.
20. **No tests.** Zero unit/integration coverage on a security-sensitive surface (redirect callback, handoff signing, middleware). Single most actionable follow-up.

---

## Integration with booking-backend + booking-frontend

### `bf_session` cookie flow

`bf_session` is **not** set by `flexrz-auth` directly. It's set by the booking frontend's Vercel proxy after consuming a handoff JWT. The flow:

1. User signs in at `auth.flexrz.com` (NextAuth).
2. NextAuth callback mints `__Secure-next-auth.session-token` on `.flexrz.com`. Inside that session JWT lives `google_id_token` + `app_jwt`.
3. Redirect target is determined by `redirect` callback (`lib/auth/options.ts:185-280`):
   - If target is `*.flexrz.com`: cookie is already on `.flexrz.com`, no handoff needed.
   - If target is a registered tenant custom domain: redirect bounces through `/return`, which mints a 90-second HS256 handoff JWT and appends it to the destination URL as `#flexrz_handoff=…`.
4. Booking frontend's client-side handler reads `window.location.hash`, POSTs the handoff JWT to its own `/api/customer-session/handoff` endpoint (in `booking-frontend`, *not* in this repo).
5. The booking-frontend proxy verifies the handoff (signature, `aud`, `dest`, `exp`), extracts `app_jwt`, and sets a **first-party** cookie on the tenant custom domain. The name `bf_session` is set in booking-frontend code — search there for the exact handler.

### `Authorization: Bearer <token>` injection into booking-backend

The frontend reads `app_jwt` from one of two places:
- **On flexrz.com / *.flexrz.com**: from `useSession()` (`session.app_jwt`, surfaced by the `session` callback in `lib/auth/options.ts:318`).
- **On a custom tenant domain**: from the `bf_session` first-party cookie (set after handoff consumption).

It then injects `Authorization: Bearer ${app_jwt}` on backend API calls. The booking-backend's `requireAppAuth` middleware (in `middleware/` in the backend repo) verifies the HS256 signature with the **same** `FLEXRZ_APP_JWT_SECRET`.

### `FLEXRZ_APP_JWT_SECRET` signing/verifying flow

- **Signer:** `lib/auth/options.ts:32-55` (`mintFlexrzAppJwt`) — HS256, payload `{iss: "auth.flexrz.com", sub, email, name, iat, exp}`, 30-day lifetime, base64url-encoded by hand (no library dependency).
- **Verifier:** booking-backend `middleware/requireAppAuth.js` (not in this repo — verified by symbol-grep on `app_jwt` in backend, but mechanics live there).
- **Secret source:** `process.env.FLEXRZ_APP_JWT_SECRET || process.env.NEXTAUTH_SECRET`. **Both repos must have the same value of `FLEXRZ_APP_JWT_SECRET`** or auth fails silently from the user's perspective (401s on every API call).

### `BOOKING_HANDOFF_SECRET` usage

- Used in `/return` (`app/return/route.ts:169-198`) and `/bridge` (`app/bridge/route.ts:80-167`) to sign the **short-lived** handoff JWT that travels in the URL fragment.
- Verified by booking-frontend's `/api/customer-session/handoff` endpoint (not in this repo).
- Falls back to `NEXTAUTH_SECRET` if `BOOKING_HANDOFF_SECRET` is not set.
- **Both `auth.flexrz.com` and the booking-frontend deployment must have the same value.**
- The handoff JWT carries BOTH `gid` (Google ID token, ~1hr, backward compat) AND `app` (Flexrz App JWT, 30 days). Booking-frontend prefers `app`; the `gid` fallback exists for older booking-frontend code paths.

### Three secret-sharing points (deployment risk)

For the end-to-end flow to work, **three secrets must match across deployments**:

| Secret | Set on | Used to sign | Used to verify |
|---|---|---|---|
| `NEXTAUTH_SECRET` | flexrz-auth | NextAuth session JWT | flexrz-auth (only) |
| `FLEXRZ_APP_JWT_SECRET` | flexrz-auth + booking-backend | Flexrz App JWT (30-day) | booking-backend `requireAppAuth` |
| `BOOKING_HANDOFF_SECRET` | flexrz-auth + booking-frontend | Handoff JWT (URL-fragment, 90s/5min) | booking-frontend `/api/customer-session/handoff` |

A rotation playbook for these three secrets is worth documenting if not already.

---

## Recommended next steps

(Audit findings, not necessarily action items — for ak to triage.)

1. 🟡 **Add tests.** Zero coverage on a security-sensitive surface. Suggested minimum: redirect-callback allowlist matrix, handoff JWT signing round-trip, middleware host validation. Even ~30 unit tests would catch regressions.
2. 🟡 **Document the three-secret coupling** (`NEXTAUTH_SECRET` ↔ `FLEXRZ_APP_JWT_SECRET` fallback ↔ `BOOKING_HANDOFF_SECRET` fallback). A `SECRETS.md` in flexrz-auth would help avoid "we rotated one and broke all sessions" incidents.
3. 🟡 **Decide on Flexrz App JWT revocation strategy.** With a 30-day lifetime and no `jti`/denylist, leaked tokens can only be killed by rotating the signing secret (kills *all* sessions). Either: (a) accept this as the cost of stateless JWTs, or (b) add a `jti`-based DB denylist on the backend.
4. 🟡 **Add explicit CSP + security headers** in `next.config.js`. Currently relies on Vercel defaults.
5. ⚪ **Consider hardening `mintFlexrzAppJwt`** to log the exception instead of silently returning `null`. Without it, a JWT signing failure looks identical to a missing-secret config issue.
6. ⚪ **Watch `lib/auth/options.ts` size** — it's at 383L, the largest file in the repo. Adding a second provider (Apple, magic links) would push it over 500L. Pre-emptively split into `lib/auth/options.ts` + `lib/auth/redirectCallback.ts` + `lib/auth/jwtCallback.ts` next time it's touched.
7. ⚪ **Audit the commit history** — recent log is dominated by web-UI uploads (`"Add files via upload"` × 100+) per the May 14 audit. Worth a one-time `git log` archaeology pass to document the actual history in `CHANGELOG.md` or similar.
8. ⚪ **`AUTH_ALLOWED_CUSTOM_REDIRECT_HOSTS`** is an escape hatch with no documented governance. Worth a comment in `.env.example` clarifying when it's appropriate (it's currently undocumented there).
