# Render Configuration — `booking-backend`

Reference doc for the production hosting setup of `booking-backend` on Render. The authoritative source for current values is the Render dashboard; this file documents intent, rationale, and the non-obvious settings that future engineers will need to understand.

## Service overview

- **Service name:** `booking-backend` (Render web service)
- **Public URL:** `https://booking-backend-6jbc.onrender.com` (also referenced in `routes/ai.js` as the fallback for `RENDER_EXTERNAL_URL`)
- **Region / Plan tier:** see Render dashboard (Settings → General)
- **Runtime:** Node.js (Render's standard Node service)
- **Repo connection:** auto-deploys from `main` on this repo

## Critical settings

| Setting | Value | Notes |
|---|---|---|
| Build command | (Render default for Node) — typically `npm install` | No custom build step; the repo runs from source |
| Start command | `npm start` → `node index.js` (per `package.json:6`) | Sentry initializes before `app.js` is required in `index.js` |
| **Pre-Deploy Command** | **`npm run migrate`** | See section below — added 2026-05-17 |
| Health check path | see Render dashboard | (not formally documented in repo today; Render's TCP health check on `PORT` suffices for boot detection) |
| Auto-deploy on push | enabled | `main` branch only |

## Environment variables (keys only — values live in the Render dashboard)

Required:

| Key | Purpose |
|---|---|
| `DATABASE_URL` | Managed Postgres connection string (Render-provisioned) |
| `ADMIN_API_KEY` | Admin/owner-proxy bypass for protected routes (timing-safe comparison) |
| `NODE_ENV` | Set to `production` on Render — drives default-on SSL in `scripts/migrate.js` and in `db.js` |
| `PORT` | Provided by Render; `server.js` reads it |

Optional / per-feature:

| Key | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API access for `routes/ai.js` chat + voice + brain/persona orchestrator + landing copy generator |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Stripe subscriptions + webhook signature verification (`routes/stripeWebhook.js`) |
| `SENTRY_DSN` | Error reporting (wired in `index.js` before `app.js`) |
| `ELEVENLABS_API_KEY` / `ELEVENLABS_AGENT_ID` | Voice booking agent (`routes/voice.js`) |
| Google credentials | ID-token verification for `requireGoogleAuth` / `requireAppAuth` |
| Cloudflare R2 credentials | S3-compatible storage for media library |
| `LOG_LEVEL` | Pino log level |
| `DATABASE_SSL` | Optional override of the production-default SSL behavior |
| `RENDER_EXTERNAL_URL` | Provided by Render; used by `handleAction` to call back into `/api/bookings` |

**Never** check secret values into the repo or this doc. The authoritative source is Render's encrypted env-var store.

## Pre-Deploy Command — `npm run migrate`

**Added 2026-05-17** in response to the Phase 2.3 incident (full postmortem: `audit/2026-05-17/phase-2-3-incident.md`).

### Why this exists

Render auto-deploys code on push to `main`, but historically did **not** auto-apply database migrations. Three documented incidents — migrations `052` (notification toggles), `055` (customer booking emails), and most recently `071` (tenants.features JSONB) — shipped code that depended on a schema change that hadn't been applied to production. The `071` incident caused a ~30-minute hard-down for all Anthropic-backed AI surfaces on `birdie-golf` until `DATABASE_SSL=true npm run migrate` was run manually from a terminal.

The Pre-Deploy Command closes that workflow gap. It runs `npm run migrate` after the build phase but BEFORE the new code serves traffic. The schema is brought up to the level the code expects, in the right order.

### What it does

`npm run migrate` invokes `node scripts/migrate.js`, which:

1. Connects to `DATABASE_URL` with SSL on (because `NODE_ENV=production` on Render — see `scripts/migrate.js:24-32`)
2. Ensures the `schema_migrations` tracking table exists (idempotent — `CREATE TABLE IF NOT EXISTS`)
3. Lists files under `migrations/*.sql` in lexicographic (== numeric) order
4. Computes `pending = files MINUS schema_migrations.filename`
5. For each pending file: runs the SQL inside a `BEGIN … COMMIT` transaction, then inserts a row into `schema_migrations`. Any error → `ROLLBACK` for that file and exit non-zero.

### Idempotent + safe

| Scenario | Outcome |
|---|---|
| No pending migrations (typical deploy) | Prints `No pending migrations.`, exits 0. No DB writes, no schema change. ~1-2 second cost from SSL handshake + table check. |
| One or more pending migrations | Applies each in order, transactionally. Per-file `✓ filename` log line. `Done.` summary. Exits 0. |
| A migration fails (SQL error, constraint violation, etc.) | The failing migration is rolled back. Earlier-in-the-batch migrations remain applied. `process.exit(1)` is called → Render **aborts the deploy** → the previous version continues serving traffic. Database is left in a recoverable state. |
| Migration runner can't reach the DB | `Migration failed: ...` printed, exit 1, deploy aborted. |

The safe failure mode (deploy aborted, previous version keeps serving) is the key property. A broken migration cannot ship broken code on top of a broken schema — Render holds the new version back until the migration succeeds.

### Cost per deploy

A few seconds. SSL handshake to the DB + `schema_migrations` lookup + (rare) actual migration work. Negligible against the typical deploy time on Render's pipeline.

### Observability

Migration output appears in Render's deploy logs under the "Pre-deploy" step. The format is the same as running `npm run migrate` locally:

```
Running 1 migration(s)...
  ✓ 072_some_new_migration.sql

Done.
```

Or, on a deploy that has no schema change:

```
No pending migrations.
```

## How to update Render config

The Pre-Deploy Command (and other settings in this doc) lives in the Render dashboard. To update:

1. https://dashboard.render.com → `booking-backend` service
2. Settings → Build & Deploy
3. Locate "Pre-Deploy Command" field — set to `npm run migrate` (set 2026-05-17 in response to the Phase 2.3 incident)
4. Save

The new value takes effect on the next deploy. Verify by triggering any deploy (e.g., a no-op commit to `main`) and inspecting the deploy log for the Pre-Deploy step.

## Future: migrate to `render.yaml` Blueprint

This doc documents intent in markdown because the repo does not currently use Render Blueprints (`render.yaml`). Adopting a Blueprint would mean mirroring every dashboard setting (region, plan tier, env-var key list, build command, start command, pre-deploy command, health check, auto-deploy branch, etc.) into a YAML file and syncing via Render's "Apply Blueprint" workflow.

That's a separate, larger project. When it happens, the settings documented above can be lifted into the YAML verbatim. Until then, this doc is the version-controlled record.

## Related

- `audit/2026-05-17/phase-2-3-incident.md` — postmortem of the migration-after-deploy incident that motivated the Pre-Deploy Command
- `scripts/migrate.js` — the migration runner
- `migrations/*.sql` — the migration files themselves
- `db.js` — connection pool with the same SSL-on-prod default the migrate script uses
