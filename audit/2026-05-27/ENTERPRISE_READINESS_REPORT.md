# Enterprise-Readiness Report — booking-backend (Flexrz/BookFlow)

**Date:** 2026-05-27
**Scope:** booking-backend (API), with cross-checks into the Next.js owner/tenant proxy, the centralized NextAuth host (`flexrz-auth`), and the tenant-dashboard page guards
**Method:** static review of three repos + live, read-only probe of production Postgres (probes `probe_clean.json`, `probe2c.json` — captured this session; no writes, no live calls re-run)
**DB observed:** PostgreSQL 18.3, 72 user tables, 27 tenants

---

## REVISION — post-pushback verification (same session)

Owner challenged findings N1 and N2 with new information: Flexrz has **four** distinct auth surfaces — (1) public booking marketing, (2) platform owner dashboard (env-password), (3) tenant dashboard at `app.flexrz.com/tenant/<slug>` (Google + per-tenant membership), (4) customer booking (open Google). The original audit treated NextAuth as one undifferentiated layer.

End-to-end trace of the tenant-dashboard path (surface #3):

1. **Page-level server guard** — `booking-frontend/app/tenant/[slug]/page.tsx:77-132`. The page server component calls `/api/proxy/tenant/<slug>/me` with the user's cookie forwarded. On `401` → redirect to sign-in. On `403` → redirect to central sign-out + sign-in. This is the "silent bounce" the owner observes — and it is **server-side, authoritative**, not client-side cosmetic.
2. **Tenant proxy** — `booking-frontend/app/api/proxy/[...path]/route.ts:319-320`. Forwards `Authorization: Bearer <app_jwt>` (the *user's* HS256 token, minted at sign-in). **Does NOT inject `x-api-key: ADMIN_KEY`.** (Distinct from the *owner* proxy, which does.)
3. **Backend** — `middleware/requireAdminOrTenantRole.js` falls past the (false) admin-key check → `requireAppAuth` (validates app_jwt) → `ensureUser` → `requireTenantRole`. The latter at `middleware/requireTenantRole.js:51-87` executes `SELECT role FROM tenant_users WHERE tenant_id = $1 AND user_id = $2` and returns **HTTP 403 "No access to this tenant."** when no row exists.

**Conclusion:** cross-tenant rejection on the tenant dashboard is enforced at three independent server-side layers. **N1 and N2 are FALSE POSITIVES for the tenant-dashboard surface.** They were artifacts of conflating "NextAuth grants identity" (true) with "NextAuth grants tenant authority" (false here — authority is per-tenant via `requireTenantRole`). Fix #1 as originally framed (three tenant-membership checks) is over-scoped.

**What survives the revision:** finding A2 (admin-bypass on `requireAdminOrTenantRole.js:38-41`) is still real, but its blast radius is narrower than first reported. The only callers that forward `ADMIN_KEY` are: (a) the **owner proxy** at `booking-frontend/app/api/owner/proxy/[...path]/route.ts:117`, gated by `isOwnerAuthed` (lines 80-95) which accepts *any* NextAuth session as proof of admin authority; and (b) direct server-to-server calls with the env var. Because the session cookie is `Domain=.flexrz.com`, any signed-in Google user could in principle issue a same-browser request to `owner.flexrz.com/api/owner/proxy/...` with that cookie attached and receive admin-key-forwarded access to any tenant. The hole exists; it is a one-route concern, not a tenant-dashboard concern.

Scoring and Fix #1 are recomputed below to reflect this.

---

## Executive summary (revised)

The data layer is materially stronger than the prior static audit claimed: tenant-scoping is built into the physical schema (63/72 tables carry `tenant_id`, every booking access path has a composite tenant-id-led index, the membership ledger has the right uniqueness invariants), and **realized cross-tenant leakage is zero** (0 orphan bookings against customers and services).

The tenant-dashboard control plane is also stronger than first reported: three layers of independent server-side enforcement (page guard → proxy forwards user token → backend `requireTenantRole`) authoritatively reject cross-tenant access. The "silent bounce" the owner observes is the page-guard reacting to a real 403 from the API.

What remains in the control plane is narrower: (i) one route — the *owner* proxy — accepts any NextAuth session as proof of admin authority and then forwards `ADMIN_KEY`, which the backend honours as a tenant-check bypass; (ii) RBAC is role-only — the `permissions` / `role_permissions` infrastructure is fully seeded (24 perms, 81 mappings) but unwired, with runtime authorization reading the `tenant_users.role` text column; (iii) no PostgreSQL RLS, so isolation depends entirely on middleware.

Net: a well-engineered data plane, a defensible tenant-dashboard control plane, and **one confined gate hole** on the owner-proxy admin path. Closing that single hole (membership-or-allowlist check before forwarding ADMIN_KEY) plus wiring the existing RBAC infrastructure gets this to enterprise-defensible. Adding RLS as defense-in-depth is the right second step.

---

## A. Findings ledger

| # | Finding (prior static audit) | Prior verdict | New verdict | Deciding evidence |
|---|---|---|---|---|
| A1 | Tenant isolation enforced only at app layer (no RLS) | Likely | **CONFIRMED** | `pg_tables` returns 0 rows with `rowsecurity = true`; `pg_policies` is empty (`probe_clean.json` → `rls`, `policies`). |
| A2 | Admin-bypass skips tenant verification | Suspected | **CONFIRMED (narrowed scope)** | `middleware/requireAdminOrTenantRole.js:38-41` — `isValidAdminKey(req)` → sets `req.adminBypass = true` → `next()`. No downstream tenant re-check on the URL-supplied `tenantId`. **Blast radius is the *owner proxy* only** (only caller from a browser context that forwards ADMIN_KEY); the tenant proxy forwards the user's app_jwt instead and is gated downstream by `requireTenantRole`. |
| A3 | RBAC is role-only (no permission-level checks) | Likely | **CONFIRMED (and worse — scaffolding is unwired)** | `tenant_users` has `role TEXT`; distinct values in prod are exactly `{'owner','staff'}` (2 of the 5 seeded roles). `tenant_user_roles` table exists with 1 row total across all 27 tenants. `permissions` (24 rows) + `role_permissions` (81 mappings) + `roles` (5) all seeded but never consulted at runtime. `tenant_user_permission_overrides` has 0 rows. |
| A4 | In-memory rate limiter does not scale | Yes | **CONFIRMED (scaling note, not a defect today)** | Single-instance Render deploy; limiter state is per-process. Not a leak risk; becomes one on horizontal scale-out. |
| A5 | Legacy `OWNER_DASH_PASSWORD` cookie auth path | Yes | **PARTIAL** | Path still present in code. Production cookie issuance depends on env var being set on Render — not observable from local probe. Confirm `OWNER_DASH_PASSWORD` is unset (or rotated and unused) on the Render service. |
| A6 | Migrations 052 and 055 not applied in prod | Reported | **STALE / REFUTED** | `schema_migrations` shows id 117 = `052_tenant_notification_toggles.sql` and id 118 = `055_customer_booking_emails.sql`, both `applied_at = 2026-05-15`. Prior audit was reading from a pre-2026-05-15 snapshot. |
| A7 | DB SSL `rejectUnauthorized: false`; hand-rolled JWT | Reported | **PARTIAL (acceptable as-deployed)** | `db.js` uses `ssl: { rejectUnauthorized: false }` — required by Render-managed Postgres. JWT pins `alg=HS256` and checks `exp` (sound for HS256). Both are pragmatic, not gaps; flag for review only if moving off Render. |
| N1 (new) | NextAuth `signIn` callback returns `true` unconditionally | Not in prior | **FALSE POSITIVE as a gate** | `flexrz-auth/lib/auth/options.ts:172-184`. Returning `true` is correct: NextAuth here is the identity layer, not the authorization layer. Tenant authorization is enforced per-request at the backend via `requireTenantRole.js:51-87` (`SELECT role FROM tenant_users WHERE tenant_id=$1 AND user_id=$2` → 403 on miss). A signed-in stranger gets a session but cannot read any tenant's data. *Defense-in-depth note:* gating `signIn` on `tenant_users` membership OR an unredeemed invite would still be a nice hardening, but it does not close a leak. |
| N2 (new) | "Owner proxy" `isOwnerAuthed` checks session-exists, not tenant membership | Not in prior | **SPLIT — FALSE POSITIVE for tenant dashboard; CONFIRMED for owner proxy** | Two distinct proxies were conflated. **Tenant proxy** (`booking-frontend/app/api/proxy/[...path]/route.ts`) forwards the user's `app_jwt` and the backend's `requireTenantRole` 403s on non-membership — verified at `requireTenantRole.js:87`. Additionally, the tenant page itself (`app/tenant/[slug]/page.tsx:77-132`) calls `/api/proxy/tenant/<slug>/me` server-side and redirects on 403. **Owner proxy** (`app/api/owner/proxy/[...path]/route.ts:80-117`) does inject ADMIN_KEY after only a session-exists check via `isOwnerAuthed` (lines 80-95 accept *any* NextAuth session). That remains a real gate hole — see new finding N5. |
| N5 (new, post-revision) | Owner proxy admin-bypass loophole | n/a | **CONFIRMED** | `booking-frontend/app/api/owner/proxy/[...path]/route.ts`: `isOwnerAuthed` (lines 80-95) returns true if *any* NextAuth session is present (line 91: `return !!token`). Same-handler (line 117) sets `headers.set("x-api-key", ADMIN_KEY)` and forwards to backend. Backend (`requireAdminOrTenantRole.js:38-41`) treats ADMIN_KEY as authority and skips the tenant membership check. Because the session cookie is `Domain=.flexrz.com` (`flexrz-auth/lib/auth/options.ts:354`), the cookie is sent automatically on any request to `owner.flexrz.com/*`. Single-route concern, but the route is reachable and the bypass is real. |
| N3 (new) | Realized cross-tenant data contamination | Not in prior | **REFUTED (structurally clean)** | `SELECT COUNT(*) FROM bookings b JOIN customers c ON c.id=b.customer_id WHERE b.tenant_id IS DISTINCT FROM c.tenant_id` → 0. Same query against `services` → 0. Despite the control-plane gaps, no production data is currently mis-attributed. |
| N4 (new) | Tenant integration credentials at rest | Not in prior | **OBSERVED (controlled)** | Twilio (`twilio_auth_token`, `twilio_account_sid`) and WhatsApp (`whatsapp_access_token`) live on `tenants` columns. Shape inspection (length + 4-char prefix) is consistent with AES-256-GCM ciphertext rather than plaintext. Rollback table `_twilio_creds_backup_2026` exists. Not a finding — note for the security register. |

---

## B. DB evidence (redacted)

All values are counts, shapes, or DDL — no secrets, no tenant names, no customer rows.

### B.1 Isolation gate
```
SELECT COUNT(*) FROM pg_tables WHERE schemaname='public' AND rowsecurity=true;  -- 0
SELECT COUNT(*) FROM pg_policies;                                               -- 0
```

### B.2 Tenant scoping at the schema layer
- Total user tables: **72**
- Tables carrying `tenant_id`: **63** (88%)
- Tables without `tenant_id`: **13**, of which:
  - **12 are correctly global** (no tenant scope possible): `permissions`, `role_permissions`, `roles`, `saas_plans`, `saas_plan_features`, `platform_themes`, `platform_shells`, `platform_layouts`, `platform_plans`, `schema_migrations`, `tenants`, `users`.
  - **1 is child-via-FK**: `tenant_invoice_lines` reaches tenancy through `invoice_id → tenant_invoices.tenant_id`. Acceptable, but a direct `tenant_id` column would be more defensible.

### B.3 `bookings` indexing (41 indexes)
Composite, tenant-id-led indexes on every realistic access pattern:
```
idx_bookings_tenant_start                (tenant_id, start_time)
idx_bookings_tenant_service_start        (tenant_id, service_id, start_time)
idx_bookings_tenant_resource_start       (tenant_id, resource_id, start_time)
idx_bookings_tenant_staff_start          (tenant_id, staff_id, start_time)
idx_bookings_tenant_customer_start       (tenant_id, customer_id, start_time)
idx_bookings_tenant_status_start_time    (tenant_id, status, start_time)
bookings_tenant_id_id_uniq               UNIQUE (tenant_id, id)         -- composite-FK target
bookings_idempotency_uq                  UNIQUE (tenant_id, idempotency_key) WHERE NOT NULL
bookings_no_overlap_staff                GiST (tenant_id, staff_id, booking_range) WHERE status IN (pending,confirmed)
idx_bookings_active                      (tenant_id, start_time) WHERE deleted_at IS NULL
idx_bookings_code_tenant                 UNIQUE (tenant_id, booking_code) WHERE booking_code IS NOT NULL
... (30 more, including reminder-pending partials)
```
This is a deliberately indexed, partial-index-aware design.

### B.4 RBAC scaffolding vs. runtime
```
permissions                                : 24 rows
roles                                      : 5 rows (TENANT_OWNER, TENANT_ADMIN, MANAGER, STAFF, READ_ONLY)
role_permissions                           : 81 mappings (OWNER:24, ADMIN:23, MANAGER:14, STAFF:9, READ_ONLY:11)
tenant_user_roles                          : 1 row total across all 27 tenants
tenant_user_permission_overrides           : 0 rows
tenant_users.role (the column runtime reads): DISTINCT values = {'owner','staff'} only
```

### B.5 Realized leakage
```
SELECT COUNT(*) FROM bookings b JOIN customers c ON c.id=b.customer_id WHERE b.tenant_id IS DISTINCT FROM c.tenant_id;  -- 0
SELECT COUNT(*) FROM bookings b JOIN services  s ON s.id=b.service_id  WHERE b.tenant_id IS DISTINCT FROM s.tenant_id;  -- 0
```

### B.6 Migrations recently applied
```
id 117 → 052_tenant_notification_toggles.sql   applied 2026-05-15
id 118 → 055_customer_booking_emails.sql       applied 2026-05-15
id 119 → 071_tenants_features_jsonb.sql        applied 2026-05-17
id 120 → 060_tombstone.sql                     applied 2026-05-17
```
Latest applied id = 120. No pending gap remains under id 120.

### B.7 Data scale
```
tenants               :  27
users                 :  13
tenant_users          :  34
bookings              : 746
customers             :  73
services              :  67
staff                 :  42
resources             :  45
membership_ledger     : 231
```

### B.8 Credentials at rest (shape only)
`tenants.twilio_auth_token`, `tenants.whatsapp_access_token`, `tenants.twilio_account_sid` are populated for active tenants. Lengths and prefixes are consistent with AES-256-GCM ciphertext (not raw SIDs / tokens). Rollback table `_twilio_creds_backup_2026` exists. FK count across the schema: **148**.

---

## C. Scorecard (0–10, gate dimensions weighted ×2)

Gate = isolation, authorization, security. A confirmed gate failure caps the overall tier regardless of strong non-gate scores.

| # | Dimension | Score | Weight | Deciding evidence | One change that raises it |
|---|---|---:|---:|---|---|
| 1 | **Tenant isolation (gate)** | **7** *(was 4)* | ×2 | Tenant-dashboard path has three server-side enforcement layers (page guard + proxy forwards user token + backend `requireTenantRole` 403). N3 confirms 0 realized leakage. **One remaining hole:** N5 — owner-proxy admin-bypass loophole. No RLS as defense-in-depth (-1). | Close the owner-proxy loophole (top fix #1) — moves to 8. Add RLS — moves to 9. |
| 2 | **Authorization / RBAC (gate)** | **6** *(was 4)* | ×2 | Per-tenant membership check works (`requireTenantRole.js:51-87`) — but it's role-only (2 distinct values: `owner`/`staff`); 24-perm / 81-mapping RBAC infra fully seeded yet unwired. NextAuth identity layer is correctly separated from authorization. | Wire `role_permissions` through a `requirePermission(perm)` middleware (top fix #2) — moves to 8. |
| 3 | **Security posture (gate)** | **7** *(was 6)* | ×2 | ADMIN_API_KEY uses timing-safe compare; CORS explicit; CSRF wired; webhook signature required in prod; JWT pins HS256 + checks exp. One notable issue: N5 owner-proxy admin-bypass. N4 secrets-at-rest depend on a single AES key. | Close N5; add KMS-managed key rotation for AES-256-GCM secrets — moves to 9. |
| 4 | Schema & data model | **9** | ×1 | B.2 + B.3; 88% tenant-scoped, partial indexes used, GiST exclusion on staff overlap, composite-FK target on `(tenant_id, id)`. | Add a `tenant_id` column to `tenant_invoice_lines` to eliminate the one FK-only path — moves to 10. |
| 5 | Indexing & query performance | **9** | ×1 | B.3; 41 indexes on bookings, every access path covered, partial indexes used to keep them lean. | Capture `pg_stat_statements` snapshot + add covering indexes for the top 3 slowest queries — moves to 10. |
| 6 | Migration discipline | **8** | ×1 | B.6; 71 numbered files, tracked by filename, no edits-in-place observed, runner has `:list` and `:dry`. Out-of-order applied (052/055 landed at ids 117/118) is fine because the runner keys on filename. | Move from filename-keyed to checksum-keyed tracking, fail-on-mismatch — moves to 9. |
| 7 | Observability | **7** | ×1 | Pino structured logs, Sentry wired before `app.js`, `correlationId` middleware. No metrics layer observed (no Prometheus / OTel exporter found in deps). | Add OTel exporter for traces + RED metrics on key routes — moves to 9. |
| 8 | Reliability / queues | **6** | ×1 | In-process schedulers for reminders, payment-link retries; idempotency-key uniqueness on bookings is enforced (`bookings_idempotency_uq`). Single-process limits horizontal scale. | Move reminders + retries to a durable queue (BullMQ / SQS) — moves to 8. |
| 9 | Payments correctness | **8** | ×1 | Stripe webhook on raw body with signature check; idempotency on bookings; membership-ledger uniqueness `(booking_id, type='debit')` prevents double-debit. | Add per-tenant reconciliation job that compares Stripe events to local invoice state — moves to 9. |
| 10 | Data lifecycle (soft-delete, DSR, retention) | **7** | ×1 | Soft-delete consistently used (partial indexes `WHERE deleted_at IS NULL`); `deleted_customers` / `deleted_services` shadow tables exist; `dsr_requests` table exists. No automated retention policy observed. | Add scheduled hard-delete job + per-tenant retention config — moves to 9. |
| 11 | Secrets management | **5** | ×1 | Per-tenant Twilio/WA tokens AES-256-GCM at rest with rollback table; `ADMIN_API_KEY` and `STRIPE_SECRET_KEY` are long-lived env vars on Render. No KMS, no rotation playbook in repo. | Move app secrets to a managed secret store (Render Env Groups or Vault), document rotation, add an envelope-encryption key for the per-tenant AES key — moves to 8. |
| 12 | Test coverage on gate paths | **5** | ×1 | Jest + Supertest in place; `__tests__/` exists; no negative-path tests for tenant isolation observed in the suite (no "tenant A token cannot read tenant B booking" cases). | Add a tenant-isolation contract test that, per route file, asserts 403 when the caller's tenant ≠ resource tenant — moves to 8. |

**Weighted score (revised):**

*Pre-revision (before the N1/N2 pushback verification):*
```
( 4×2  +  4×2  +  6×2  +  9 + 9 + 8 + 7 + 6 + 8 + 7 + 5 + 5 ) / 15
=  8   +  8    +  12   +  9 + 9 + 8 + 7 + 6 + 8 + 7 + 5 + 5
= 92 / 15
= 6.13
```
*(The original draft of this report stated 6.87; that was an arithmetic error and is hereby corrected.)*

*Post-revision (after verifying N1 false-positive, N2 split → false-positive for tenant dashboard, A2 narrowed to owner-proxy blast radius):*
```
( 7×2  +  6×2  +  7×2  +  9 + 9 + 8 + 7 + 6 + 8 + 7 + 5 + 5 ) / 15
= 14   +  12   +  14   +  9 + 9 + 8 + 7 + 6 + 8 + 7 + 5 + 5
= 104 / 15
= 6.93
```

**Honest delta from the pushback verification: +0.80** (from 6.13, not from the mis-stated 6.87). Two gate dimensions moved from 4 → 7 and 4 → 6 because two "confirmed" gate findings turned out to be false positives once the tenant-dashboard path was traced end-to-end.

**Tier:** **"Enterprise-defensible on the tenant-dashboard surface; one narrow owner-proxy fix away from fully enterprise-ready."**

---

## D. Delta vs. the prior static audit

| Area | Prior view | Live verdict | Why the change |
|---|---|---|---|
| Tenant isolation | "Mostly app-layer" | **Confirmed** — and worse: 0 RLS + 3 bypass paths (A2, N1, N2). | Static audit didn't see the three bypass paths together. |
| RBAC | "Role-only" | **Confirmed** — and the permission infra exists, fully seeded, but unwired. | Static audit didn't enumerate `permissions`/`role_permissions` to discover the gap is "scaffolding present, never consulted". |
| Schema / data layer | "Mixed" | **Materially stronger** — 88% tenant-scoped, 41 bookings indexes, partial indexes, GiST exclusion. | Static audit was too harsh; live DDL is good. |
| Migrations 052 + 055 | "Not applied" | **Stale** — applied 2026-05-15 (ids 117, 118). | Static audit used a pre-2026-05-15 snapshot. |
| Cross-tenant data leakage | Implied possible | **Refuted** — 0 orphan rows on the two highest-risk joins. | Required live query; static review cannot answer this. |
| Hand-rolled JWT, DB `rejectUnauthorized:false` | "Concerns" | **Acceptable as-deployed** — HS256 with exp check; Render-managed PG requires the SSL setting. | Static audit didn't account for hosting reality. |
| In-memory rate limiter | "Bug" | **Not yet a bug** — single Render instance. Becomes one on scale-out. | Static audit didn't see deployment topology. |

Two new findings emerged that weren't in the prior audit at all: **N1** (NextAuth `signIn` allows everyone) and **N2** (owner proxy `isOwnerAuthed` checks session-exists, not membership). Both are gate-class.

---

## E. Top 3 fixes, ranked by leverage

### #1 — Close the owner-proxy admin-bypass loophole (N5) and add RLS as defense-in-depth
*Closes the one remaining gate hole on the platform-owner surface.*

Single load-bearing change, one defense-in-depth addition:

1. **`booking-frontend/app/api/owner/proxy/[...path]/route.ts:80-95` (`isOwnerAuthed`)** — replace the permissive `return !!token` (any NextAuth session = pass) with one of: (a) require *only* the legacy `bookflow_owner` cookie for this route (drop the NextAuth fallback entirely, since this is the platform-owner plane, not the tenant plane), or (b) require an explicit `platform_admin` allowlist check against `session.user.email`. Either eliminates the "any-Google-user → ADMIN_KEY-forwarded" path.
2. **Add Postgres RLS** as defense-in-depth. With composite-FK index `bookings_tenant_id_id_uniq` already in place, RLS policies on the top ~10 tenant tables (using a `current_setting('app.tenant_id')` pattern set in `db.js` per request) would be a straightforward additive change — and would make A2/N5-class bugs unable to leak data even if reintroduced.

*(Optional hardening — does not close a leak, but worth doing alongside:)*
- **NextAuth `signIn` callback** — gate on `tenant_users` membership OR an unredeemed `tenant_invites` row, so users who never had a path in cannot mint sessions at all. Defense-in-depth, not a leak fix.
- **`middleware/requireAdminOrTenantRole.js:38-41`** — even after the proxy fix, the admin-bypass on the backend still trusts the URL-supplied tenantId. Logging an audit row keyed on `adminBypass=true, tenant_id, route` would give forensic visibility without changing behaviour.

**Effort:** 1 hour for item 1; 1 week to design + roll out RLS.
**Impact:** moves dimension 1 from 7 → 8 (and 9 with RLS), dimension 3 from 7 → 8, closes the last confirmed gate finding.

### #2 — Wire the RBAC scaffolding through a `requirePermission(perm)` middleware
*Closes A3.*

The data is already there: 24 permissions, 5 roles, 81 mappings. Build a `requirePermission('BOOKINGS_WRITE')` middleware that resolves the caller's permissions via `tenant_user_roles → role_permissions` (with `tenant_user_permission_overrides` taking precedence), and replace the current `requireTenantRole('owner')` checks file by file. Backfill `tenant_user_roles` from the existing `tenant_users.role` text column in a one-shot migration; then remove the text column in a follow-up once all routes have moved over.

**Effort:** 2–3 days for the middleware + backfill; ~1 week to migrate all 117 route files.
**Impact:** moves dimension 2 from 4 → 8.

### #3 — Add a tenant-isolation contract test and a per-tenant reconciliation job
*Locks in #1 and #2; closes the "no negative-path tests" gap and adds an early-warning signal for any future regression.*

- **Contract test:** for each route file under `routes/`, assert that a request authenticated as tenant A receives `403` when the URL points to a tenant B resource. One parametrized test covers the whole surface and will fail loudly if any future change reintroduces a bypass.
- **Reconciliation job:** scheduled query that re-runs the orphan checks from B.5 plus `SELECT tenant_id FROM membership_ledger ml JOIN customer_memberships cm ON cm.id = ml.customer_membership_id WHERE ml.tenant_id IS DISTINCT FROM cm.tenant_id` and alerts on any non-zero. Today this returns 0; the job's value is detecting drift the moment it appears.

**Effort:** 1 day for the contract test; 0.5 day for the reconciliation job.
**Impact:** moves dimension 12 from 5 → 8 and provides ongoing assurance for dimensions 1 and 2.

---

## Appendix — methodology notes

- All counts and DDL came from the read-only probes `probe_clean.json` and `probe2c.json` captured this session against the production database. No writes; no live calls re-run during this report-generation step.
- No tenant names, customer rows, secrets, or email addresses appear in this report. Credential evidence is shape-only (lengths and 4-character prefixes).
- The single discrepancy with the prior session's verbal summary (it said "9 tables without tenant_id"; the actual count from `information_schema.columns` is 13 — 12 global + 1 child-via-FK) is reflected here as the truth from the data. It does not change any verdict.
