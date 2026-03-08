'use strict';

const express = require("express");
const cors = require("cors");

const { corsMiddleware, corsOptions } = require("./middleware/cors");
const { uploadDir } = require("./middleware/upload");

// PR-1: Observability middleware (loaded first so all requests are covered)
const correlationId = require("./middleware/correlationId");
const requestLogger = require("./middleware/requestLogger");
const errorHandler = require("./middleware/errorHandler");

<<<<<<< HEAD
// PR-2: Rate limiters for public-facing routes
const {
  publicApiLimiter,
  availabilityLimiter,
  bookingCreateLimiter,
  tenantLookupLimiter,
} = require("./middleware/rateLimiter");

=======
>>>>>>> origin/main
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
const tenantHomeLandingRouter = require("./routes/tenantHomeLanding");
const tenantBrandingRouter = require("./routes/tenantBranding");
const tenantMembershipCheckoutRouter = require("./routes/tenantMembershipCheckout");
const tenantRatesRouter = require("./routes/tenantRates");
const tenantBookingsRouter = require("./routes/tenantBookings");
const tenantPrepaidCatalogRouter = require("./routes/tenantPrepaidCatalog");
const tenantPrepaidAccountingRouter = require("./routes/tenantPrepaidAccounting");

const publicPricingRouter = require("./routes/publicPricing");
const uploadsRouter = require("./routes/uploads");

// theme routers
const adminThemesRouter = require("./routes/adminThemes");
const adminTenantsThemeRouter = require("./routes/adminTenantsTheme");
const publicTenantThemeRouter = require("./routes/publicTenantTheme");

const linksRouter = require("./routes/links");
const tenantDomainsRouter = require("./routes/tenantDomains");
const debugGoogleAuthRouter = require("./routes/debugGoogleAuth");

// PR-1: health router (replaces inline /health + old /health/db route)
const healthRouter = require("./routes/health");

const app = express();
const ENABLE_DEBUG_ROUTES =
  String(process.env.ENABLE_DEBUG_ROUTES || "").toLowerCase() === "true";

// ─── Observability (must be first) ───────────────────────────────────────────
app.use(correlationId);   // attaches req.requestId + X-Request-ID header
app.use(requestLogger);   // structured pino-http logging for every request

// ─── CORS ────────────────────────────────────────────────────────────────────
app.use(corsMiddleware);
app.options("*", cors(corsOptions));

// ─── Body parsers ────────────────────────────────────────────────────────────
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ─── Static uploads ──────────────────────────────────────────────────────────
app.use("/uploads", express.static(uploadDir));

<<<<<<< HEAD
// ─── Health (before API routes — no auth required, no rate limit) ────────────
app.use("/health", healthRouter);

// ─── Core APIs ───────────────────────────────────────────────────────────────
// PR-2: tenants router — GET / is now admin-protected (see routes/tenants.js).
//       by-slug endpoints remain public but are rate-limited.
app.use("/api/tenants", tenantLookupLimiter, tenantsRouter);

=======
// ─── Health (before API routes — no auth required) ───────────────────────────
app.use("/health", healthRouter);

// ─── Core APIs ───────────────────────────────────────────────────────────────
app.use("/api/tenants", tenantsRouter);
>>>>>>> origin/main
app.use("/api/tenant-hours", tenantHoursRouter);
app.use("/api/tenant-blackouts", tenantBlackoutsRouter);
app.use("/api/services", servicesRouter);
app.use("/api/staff", staffRouter);
app.use("/api/resources", resourcesRouter);
app.use("/api/customers", customersRouter);

// PR-2: bookings — rate limit POST (public booking creation) only.
// GET paths already require admin/tenant role auth so no limiter needed there.
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
app.use("/api/tenant", tenantHomeLandingRouter);
app.use("/api/tenant", tenantBrandingRouter);
app.use("/api/tenant", tenantMembershipCheckoutRouter);
app.use("/api/tenant", tenantRatesRouter);
app.use("/api/tenant", tenantBookingsRouter);
app.use("/api/tenant", tenantPrepaidCatalogRouter);
app.use("/api/tenant", tenantPrepaidAccountingRouter);
app.use("/api/invites", invitesRouter);

// ─── Public APIs ─────────────────────────────────────────────────────────────
<<<<<<< HEAD
// PR-2: rate-limit public pricing/theme browsing
app.use("/api/public", publicApiLimiter, publicPricingRouter);
=======
app.use("/api/public", publicPricingRouter);
>>>>>>> origin/main

// ─── Uploads ─────────────────────────────────────────────────────────────────
app.use("/api/uploads", uploadsRouter);

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
