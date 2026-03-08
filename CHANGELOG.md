# CHANGELOG.md
All notable changes to this repository are documented here.

The format is based on **Keep a Changelog** and this project follows **Semantic Versioning** (when tags are used).

---

## [Unreleased]
### Added
- (Add new entries here)

---

## [1.0.0] - 2026-03-09

### Added — PR-10: Multi-Tenancy + DX Polish
- `migrations/005_soft_delete.sql` added to repo (was applied manually; now tracked by migration runner)
- Soft-delete filtering in `routes/customers.js` — search + list queries exclude deleted rows
- Soft-delete filtering in `routes/services.js` — list query excludes deleted services
- Schema-safe `softDeleteClause()` helper — no-op on environments without migration 005
- `__tests__/tenant_isolation.test.js` — dedicated isolation suite: requireTenant, cross-tenant mismatch, role guards

### Added — PR-9: Frontend Architecture Hardening (booking-frontend)
- `next.config.ts` — CSP, HSTS, X-Frame-Options, Referrer-Policy headers; strips console.log in prod
- `components/shared/ErrorBoundary.tsx` — React class ErrorBoundary with resetKeys + onError
- `app/error.tsx` — global error page with digest ID and retry button
- `app/not-found.tsx` — clean 404 page
- `lib/api/apiFetch.ts` — request timeout + AbortSignal merging
- `__tests__/api-layer.test.ts` — 25 tests: apiFetch success/error/timeout/edge cases

### Added — PR-8: GDPR DSR + SOC-2 Audit Prep
- `utils/auditLog.js` — writeAuditEvent() with frozen EVENT_TYPES registry
- `middleware/securityHeaders.js` — HSTS, X-Frame-Options, Permissions-Policy, removes X-Powered-By
- `routes/dsr.js` — GDPR Data Subject Request endpoints
- `docs/GDPR_SOC2.md` — compliance reference
- `__tests__/gdpr_soc2.test.js` — GDPR + security headers tests

### Added — PR-7: Frontend Test Coverage ≥60% (booking-frontend)
- booking-utils, ops-utils, theme-layout-utils, hours-daterange-landing test suites
- vitest.config.ts coverage thresholds (60% lines/statements)

### Added — PR-6: Backend Test Coverage ≥70%
- Full test suites: apiV3, billing, customers, services, staff_resources, memberships, migrations

### Added — PR-5: Migration System + DB Integrity
- `scripts/migrate.js` — ordered SQL migration runner with schema_migrations tracking

### Added — PR-4: Stripe Billing Wiring
- `routes/billing.js`, `routes/stripeWebhook.js`, `utils/stripe.js`
- `utils/planEnforcement.js` — assertWithinPlanLimit() for per-plan feature caps

### Added — PR-3: Health Enrichment + API Versioning + Pagination
- Enriched health endpoints, X-API-Version header, limit/offset pagination on list routes

### Added — PR-2: Rate Limiting + Auth Hardening
- Per-route rate limiters, Google ID token verification middleware

### Added — PR-1: Observability Foundation
- Correlation IDs, structured pino logging, centralised error handler, Sentry integration

---

## [0.1.0] - 2026-01-29
### Added
- Repository governance foundation for Phase 1 (Commercial v1)
