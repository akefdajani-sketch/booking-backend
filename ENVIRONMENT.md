# ENVIRONMENT.md
## Backend Environment Variables (booking-backend)

### Required (Production)
- `DATABASE_URL`
  - Postgres connection string (Render/managed DB)
- `ADMIN_API_KEY`
  - Key used for protected admin routes (server-side only)
- `NODE_ENV`
  - `production` in production
- `PORT`
  - Provided by hosting (Render sets this)

### PR-1: Observability (New)
- `SENTRY_DSN`
  - Sentry Data Source Name for error reporting
  - Get from: sentry.io → Project → Settings → Client Keys
  - Omit in local dev to disable Sentry silently (safe — no crash)
  - Example: `https://abc123@o123456.ingest.sentry.io/789`
- `LOG_LEVEL`
  - Pino log level: `trace` | `debug` | `info` | `warn` | `error` | `fatal`
  - Default: `info`
  - Recommended: `info` in production, `debug` locally
- `APP_VERSION`
  - Optional. Used as the Sentry release tag.
  - On Render, `RENDER_GIT_COMMIT` is set automatically and used instead.

### Recommended
- `CORS_ORIGINS`
  - Comma-separated allowed origins (frontend URLs)
- `TZ`
  - Set to `UTC` for predictable server time (recommended)

### Database Pool Tuning (Optional)
- `PGPOOL_MAX` — max pool connections (default: 5)
- `PGPOOL_IDLE` — idle timeout ms (default: 30000)
- `PGPOOL_CONN_TIMEOUT` — connection timeout ms (default: 10000)
- `DATABASE_SSL` — force SSL on/off (`true`/`false`). Defaults to `true` in production.

### Optional (Debug)
- `ENABLE_DEBUG_ROUTES`
  - Set to `true` to enable `/api/debug/*` routes (non-production only)
- `ALLOW_VERCEL_PREVIEWS`
  - Set to `true` to allow `*.vercel.app` CORS origins in production

### Local Setup
1. Copy `.env.example` to `.env`
2. Fill in `DATABASE_URL` and other values
3. `npm install`
4. `npm run dev`
