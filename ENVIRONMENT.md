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

### PR-4: Stripe Billing
- `STRIPE_SECRET_KEY`
  - Stripe secret API key (`sk_live_...` or `sk_test_...`)
  - Get from: dashboard.stripe.com → Developers → API Keys
  - **Omit to disable billing features** — server boots and all non-billing routes work normally
  - Never expose in client code
- `STRIPE_WEBHOOK_SECRET`
  - Signing secret for webhook signature verification (`whsec_...`)
  - Get from: dashboard.stripe.com → Developers → Webhooks → your endpoint → Signing secret
  - **Required in production** to prevent webhook spoofing
  - Omit in local dev only (signature check is skipped, not recommended in prod)
- `STRIPE_PRICE_STARTER`
  - Stripe Price ID for the Starter plan (`price_...`)
  - Get from: dashboard.stripe.com → Products → your Starter product → Price ID
  - Example: `price_1ABC123defGHI456`
- `STRIPE_PRICE_GROWTH`
  - Stripe Price ID for the Growth plan
- `STRIPE_PRICE_PRO`
  - Stripe Price ID for the Pro plan
- `FRONTEND_URL`
  - Base URL of the frontend app, used for Stripe redirect URLs
  - Example: `https://app.flexrz.com`
  - Default fallback: `https://flexrz.com`

#### Stripe Setup Checklist
1. Create products + recurring prices in Stripe dashboard (one per plan)
2. Copy Price IDs into `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_GROWTH`, `STRIPE_PRICE_PRO`
3. Set `STRIPE_SECRET_KEY` (use test key first)
4. Register webhook endpoint: `https://your-backend.onrender.com/api/billing/webhook`
   - Events to enable: `checkout.session.completed`, `customer.subscription.updated`,
     `customer.subscription.deleted`, `invoice.payment_failed`
5. Copy webhook signing secret into `STRIPE_WEBHOOK_SECRET`
6. Run migration: `psql $DATABASE_URL -f migrations/004_stripe_customer_id.sql`

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
