'use strict';

const express = require("express");
const cors = require("cors");

const { corsMiddleware, corsOptions } = require("./middleware/cors");
const { uploadDir } = require("./middleware/upload");

// PR-1: Observability middleware (loaded first so all requests are covered)
const correlationId = require("./middleware/correlationId");
const requestLogger = require("./middleware/requestLogger");
const errorHandler = require("./middleware/errorHandler");

// PR-8: Security headers + GDPR DSR
const securityHeaders = require("./middleware/securityHeaders");
const dsrRouter = require("./routes/dsr");

// PR-2: Rate limiters for public-facing routes
// PR-3: API version header
const {
  publicApiLimiter,
  availabilityLimiter,
  bookingCreateLimiter,
  tenantLookupLimiter,
} = require("./middleware/rateLimiter");
const apiVersion = require("./middleware/apiVersion");
// PR-14: OpenAPI
// PR-14: OpenAPI / Swagger docs — served at /api/docs
const swaggerUi  = require('swagger-ui-express');
const YAML        = require('js-yaml');
const fs          = require('fs');
const path        = require('path');

// PR-16: CSRF — cookie-parser needed to read the double-submit cookie
const cookieParser = require('cookie-parser');
const { getCsrfToken, csrfProtection } = require('./middleware/csrf');


// existing routers
const tenantsRouter = require("./routes/tenants");
const tenantHoursRouter = require("./routes/tenantHours");
const tenantBlackoutsRouter = require("./routes/tenantBlackouts");
const servicesRouter = require("./routes/services");
const staffRouter = require("./routes/staff");
const resourcesRouter = require("./routes/resources");
const customersRouter = require("./routes/customers");
const bookingsRouter = require("./routes/bookings");
const availabilityRouter = require("./routes/availability");
const membershipPlansRouter = require("./routes/membershipPlans");
const customerMembershipsRouter = require("./routes/customerMemberships");

const tenantUsersRouter = require("./routes/tenantUsers");
const invitesRouter = require("./routes/invites");
const tenantPlanRouter = require("./routes/tenantPlan");
const tenantDashboardRouter = require("./routes/tenantDashboard");
const tenantStaffScheduleRouter = require("./routes/tenantStaffSchedule");
const serviceHoursRouter = require("./routes/serviceHours");
const tenantHomeLandingRouter = require("./routes/tenantHomeLanding");
const tenantBrandingRouter = require("./routes/tenantBranding");
const tenantMembershipCheckoutRouter = require("./routes/tenantMembershipCheckout");
const tenantRatesRouter = require("./routes/tenantRates");
const tenantCategoriesRouter = require("./routes/tenantCategories"); // PR-CAT1
const tenantBookingsRouter = require("./routes/tenantBookings");
const sessionsRouter       = require("./routes/sessions");        // PR-SESSIONS
const tenantPrepaidCatalogRouter = require("./routes/tenantPrepaidCatalog");
const tenantPrepaidAccountingRouter = require("./routes/tenantPrepaidAccounting");

const publicPricingRouter = require("./routes/publicPricing");
const uploadsRouter = require("./routes/uploads");
const mediaLibraryRoutes = require("./routes/mediaLibrary");

// theme routers
const adminThemesRouter = require("./routes/adminThemes");
const adminTenantsThemeRouter = require("./routes/adminTenantsTheme");
const publicTenantThemeRouter = require("./routes/publicTenantTheme");

const linksRouter = require("./routes/links");
const tenantDomainsRouter = require("./routes/tenantDomains");
const debugGoogleAuthRouter = require("./routes/debugGoogleAuth");

// PR-1: health router (replaces inline /health + old /health/db route)
const healthRouter = require("./routes/health");

// PR-4: Billing — webhook MUST be mounted before express.json() (needs raw body)
const stripeWebhookRouter = require("./routes/stripeWebhook");
const billingRouter = require("./routes/billing");

const app = express();
const ENABLE_DEBUG_ROUTES =
  String(process.env.ENABLE_DEBUG_ROUTES || "").toLowerCase() === "true";

// ─── Observability (must be first) ───────────────────────────────────────────
app.use(correlationId);   // attaches req.requestId + X-Request-ID header
app.use(securityHeaders); // PR-8: X-Content-Type-Options, X-Frame-Options, HSTS etc.
app.use(requestLogger);   // structured pino-http logging for every request
app.use(apiVersion);      // PR-3: adds X-API-Version header to every response

// ─── CORS ────────────────────────────────────────────────────────────────────
app.use(corsMiddleware);
app.options("*", cors(corsOptions));

// ─── PR-4: Stripe webhook (raw body — MUST be before express.json()) ─────────
// Stripe requires the raw Buffer for signature verification.
app.use("/api/billing", stripeWebhookRouter);

// ─── Body parsers ────────────────────────────────────────────────────────────
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser()); // PR-16: needed for CSRF double-submit cookie

// ─── Static uploads ──────────────────────────────────────────────────────────
app.use("/uploads", express.static(uploadDir));

// ─── Health (before API routes — no auth required, no rate limit) ────────────
app.use("/health", healthRouter);


// PR-14: Swagger UI — /api/docs (disabled in test env)
if (process.env.NODE_ENV !== 'test') {
  try {
    const openapiPath = path.join(__dirname, 'openapi.yaml');
    const openapiDoc  = YAML.load(fs.readFileSync(openapiPath, 'utf8'));
    app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openapiDoc, {
      customSiteTitle: 'Flexrz API Docs',
      swaggerOptions: { persistAuthorization: true },
    }));
    app.get('/api/openapi.json', (req, res) => res.json(openapiDoc));
  } catch (e) {
    console.warn('OpenAPI spec not loaded:', e.message);
  }
}

// PR-16: CSRF token endpoint — frontend calls this once per session
app.get('/api/csrf-token', getCsrfToken);

// ─── Core APIs ───────────────────────────────────────────────────────────────
// PR-2: tenants router — GET / is now admin-protected (see routes/tenants.js).
//       by-slug endpoints remain public but are rate-limited.
app.use("/api/tenants", tenantLookupLimiter, tenantsRouter);

app.use("/api/tenant-hours", tenantHoursRouter);
app.use("/api/tenant-blackouts", tenantBlackoutsRouter);
app.use("/api/services", servicesRouter);
app.use("/api/staff", staffRouter);
app.use("/api/resources", resourcesRouter);
app.use("/api/tenant-categories", tenantCategoriesRouter); // PR-CAT1
app.use("/api/customers", customersRouter);

// PR-2: bookings — rate limit POST (public booking creation) only.
// GET paths already require admin/tenant role auth so no limiter needed there.
// NOTE: csrfProtection removed from this route (PR-16 fix):
//   - Requests arrive via the Next.js server-side proxy (server-to-server),
//     so no browser CSRF cookie is ever sent alongside them.
//   - Bearer-token authenticated routes don't need CSRF per csrf.js design note.
//   - The route is already guarded by bookingCreateLimiter + CORS.
app.use("/api/bookings", bookingCreateLimiter, bookingsRouter);

// PR-2: availability is fully public — rate-limit it.
app.use("/api/availability", availabilityLimiter, availabilityRouter);

app.use("/api/membership-plans", membershipPlansRouter);
app.use("/api/customer-memberships", customerMembershipsRouter);

// ─── Tenant-scoped APIs ───────────────────────────────────────────────────────
app.use("/api/tenant", tenantUsersRouter);
app.use("/api/tenant", tenantPlanRouter);
app.use("/api/tenant", tenantDashboardRouter);
app.use("/api/tenant", tenantStaffScheduleRouter);
app.use("/api/tenant", serviceHoursRouter); // PR-SH1: per-service time windows
app.use("/api/tenant", sessionsRouter);     // PR-SESSIONS: group/parallel booking sessions
app.use("/api/tenant", tenantHomeLandingRouter);
app.use("/api/tenant", tenantBrandingRouter);
app.use("/api/tenant", tenantMembershipCheckoutRouter);
app.use("/api/tenant", tenantRatesRouter);
app.use("/api/tenant", tenantBookingsRouter);
app.use("/api/tenant", tenantPrepaidCatalogRouter);
app.use("/api/tenant", tenantPrepaidAccountingRouter);
app.use("/api/invites", invitesRouter);

// ─── PR-4: Billing REST endpoints (checkout, portal, status) ─────────────────
app.use("/api/billing", billingRouter);
app.use("/api/dsr", csrfProtection, dsrRouter); // PR-16        // PR-8: GDPR Data Subject Requests

// ─── Public APIs ─────────────────────────────────────────────────────────────
// PR-2: rate-limit public pricing/theme browsing
app.use("/api/public", publicApiLimiter, publicPricingRouter);

// ─── Uploads ─────────────────────────────────────────────────────────────────
app.use("/api/uploads", uploadsRouter);

// ─── Media Library ────────────────────────────────────────────────────────────
app.use("/api/media-library", mediaLibraryRoutes);

// ─── Theme system ─────────────────────────────────────────────────────────────
app.use("/api/admin/themes", adminThemesRouter);
app.use("/api/admin/tenants", adminTenantsThemeRouter);
// PR-2: public tenant theme is rate-limited (called on every booking page load)
app.use("/api/public/tenant-theme", publicApiLimiter, publicTenantThemeRouter);

// ─── Misc ─────────────────────────────────────────────────────────────────────
app.use("/api/links", linksRouter);
app.use("/api/tenant-domains", tenantDomainsRouter);

if (ENABLE_DEBUG_ROUTES && process.env.NODE_ENV !== "production") {
  app.use("/api/debug", debugGoogleAuthRouter);
}

// ─── 404 catch-all for /api/* ─────────────────────────────────────────────────
app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));

// ─── Central error handler (must be last) ────────────────────────────────────
// Replaces the old inline (err, req, res, next) block.
app.use(errorHandler);

module.exports = app;
