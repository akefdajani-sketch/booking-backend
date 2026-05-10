# CLAUDE.md — booking-backend (BookFlow API)

This is the BookFlow API. Multi-tenant booking & ops SaaS for time-based businesses (golf, gyms, salons, clinics). **`SYSTEM.md` is law — if code conflicts with it, the code is wrong.** Always read it on first session.

## Stack

- **Runtime**: Node.js + Express 4, CommonJS (`'use strict'`, `require`)
- **DB**: PostgreSQL via `pg` Pool (`db.js`) — managed Postgres on Render
- **Hosting**: Render (`node index.js` is the entrypoint, Render sets `PORT`)
- **Observability**: Pino (`utils/logger.js`) + Sentry (`utils/sentry.js`) — wired in `index.js` *before* `app.js` loads
- **Auth**: Google ID tokens (`middleware/requireGoogleAuth.js`) + `ADMIN_API_KEY` for admin
- **Payments**: Stripe (subs/billing) + network/MPGS (Mastercard) for one-off
- **Storage**: S3-compatible (Cloudflare R2) via `@aws-sdk/client-s3`
- **Docs**: OpenAPI at `/api/docs` (swagger-ui-express, source: `openapi.yaml`)
- **AI**: Anthropic SDK (`utils/claudeService.js`)
- **Tests**: Jest + Supertest (`__tests__/`)

## Run / common commands

```bash
npm install
npm run dev              # node index.js (no nodemon — restart manually)
npm test                 # jest --runInBand --forceExit
npm run test:coverage
npm run migrate          # run pending SQL migrations
npm run migrate:list     # show applied + pending
npm run migrate:dry      # preview SQL without applying
```

## Layout

```
index.js          → boot (Sentry first, then app.js, error handlers)
server.js         → app.listen(PORT)
app.js            → 600+ lines of router wiring; the central composition file
db.js             → pg Pool, SSL on in prod
middleware/      → auth, CORS, CSRF, rate limit, security headers, correlationId, requestLogger, errorHandler
routes/          → 117 route files (some folders, some flat); naming = resource (e.g. routes/bookings.js)
utils/           → business logic helpers — availabilityEngine, contracts, ledger, themes, email/sms/whatsapp, audit
migrations/      → numbered SQL files 001…068; runner: scripts/migrate.js
theme/           → tenant theme resolution (CSS vars, contract themes)
docs/            → architecture & policy docs (read these before changing big surfaces)
openapi.yaml     → API contract; keep it in sync with routes
```

## Hard rules (the ones that will burn you)

### Tenant isolation is sacred
Every query, cache, and derived dataset must be tenant-scoped. No cross-tenant leakage, ever. Use `requireTenant` / `requireTenantRole` / `resolveStaffScope` middleware. New list endpoints must filter by `tenant_id`. Adding a query? Ask whether it could ever return rows from another tenant — if yes, it's wrong.

### Soft-delete awareness
Migration `005` introduced soft-delete. Use `softDeleteClause()` from utils — it's schema-safe (no-op where the column is absent). Don't hand-write `WHERE deleted_at IS NULL`.

### Membership ledger is append-only
No edits, no deletes. Debits/credits must be idempotent under retries.

### Booking correctness
- Multi-slot selection forms **one** booking (contiguous block).
- **Service** owns time rules (not staff/resource).
- Duration = slots × slot interval — never an assumption.
- Don't invent availability in the UI; the engine in `utils/availabilityEngine.js` is the source of truth.

### Migrations
- New schema change → new numbered file in `migrations/` (next free number after `068`).
- Never edit an applied migration. Add a new one.
- Constraints > "hopeful" app-only logic. Push invariants into the DB.
- Run `npm run migrate:dry` against staging before applying anywhere real.

### Auth & secrets
- `ADMIN_API_KEY` uses timing-safe comparison — keep it that way.
- Google audience check is fail-closed (no retry without `aud`). Don't reintroduce the bypass.
- CORS: explicit `allowedOrigins` only. `ALLOW_VERCEL_PREVIEWS=true` is the *only* way to widen in prod, and it's off by default.
- Never log secrets. Never expose `STRIPE_SECRET_KEY`, `DATABASE_URL`, or admin keys in error responses.

### Logging
- Use `utils/logger` (pino), not `console.*`. The unhandled-rejection / uncaught-exception hooks already flow through pino + Sentry.
- Errors: `logger.error({ err }, 'message')` — `err` as a key, structured.

### Stripe webhooks
- Signature check (`STRIPE_WEBHOOK_SECRET`) is required in production.
- Webhook route uses `express.raw()` body — don't move it behind JSON parsing.

### CSRF
- `getCsrfToken` issues; `csrfProtection` enforces. Cookie-parser has to be wired (it already is in `app.js`). Don't remove `cookieParser`.

## Env

See `ENVIRONMENT.md` for the full list. Minimum to boot locally:

```
DATABASE_URL=postgres://...
ADMIN_API_KEY=...
NODE_ENV=development
PORT=3001
LOG_LEVEL=debug
```

Stripe / Sentry / Google / R2 are optional in local dev — server boots and non-billing routes work without them.

## Pre-commit / pre-PR checklist

Walk `SYSTEM_CHECKLIST.md`. The non-negotiable ones:

- [ ] Tenant isolation preserved (no cross-tenant queries)
- [ ] Booking + availability + ledger correctness preserved
- [ ] Pagination/limit on list endpoints (no unbounded loads)
- [ ] No N+1 introduced
- [ ] No secrets in client/log output
- [ ] OpenAPI updated if the route surface changed
- [ ] Migration added (not edited) for any schema change
- [ ] Tests added or updated; `npm test` green

## When working in this repo, prefer

- Editing `utils/*` helpers over duplicating logic in routes
- Adding constraints in SQL over enforcement-only-in-Node
- Adding a migration over hand-running SQL on Render
- Reading `docs/` before redesigning anything that already has a doc
