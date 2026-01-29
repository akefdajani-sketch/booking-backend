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

### Recommended
- `CORS_ORIGINS`
  - Comma-separated allowed origins (frontend URLs)
- `LOG_LEVEL`
  - `info` / `warn` / `error`
- `TZ`
  - Set to `UTC` for predictable server time (recommended)

### Optional (if authentication/session is used)
- `JWT_SECRET`
- `SESSION_SECRET`

### Local Setup
1) Copy `.env.example` to `.env`
2) Fill values
3) Run your dev script (e.g., `npm run dev`)
