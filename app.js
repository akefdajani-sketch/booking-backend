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
const tenantStaffPortalRouter = require("./routes/tenantStaffPortal");
const tenantUserPermissionsRouter = require("./routes/tenantUserPermissions");
const tenantStaffScheduleRouter = require("./routes/tenantStaffSchedule");
const serviceHoursRouter = require("./routes/serviceHours");
const tenantHomeLandingRouter = require("./routes/tenantHomeLanding");
const tenantBookingPolicyRouter = require("./routes/tenantBookingPolicy"); // Patch 151b-fix
const tenantBrandingRouter = require("./routes/tenantBranding");
const tenantMembershipCheckoutRouter = require("./routes/tenantMembershipCheckout");
const tenantRatesRouter = require("./routes/tenantRates");
const tenantCategoriesRouter = require("./routes/tenantCategories"); // PR-CAT1
const tenantBookingsRouter = require("./routes/tenantBookings");
const sessionsRouter       = require("./routes/sessions");        // PR-SESSIONS
const tenantPrepaidCatalogRouter = require("./routes/tenantPrepaidCatalog");
const tenantPrepaidAccountingRouter = require("./routes/tenantPrepaidAccounting");

// G2a-1: Long-term contracts + payment schedule templates
const contractsRouter                 = require("./routes/contracts");
const paymentScheduleTemplatesRouter  = require("./routes/paymentScheduleTemplates");

// PAY-1: Network payment routes
const networkPaymentsRouter       = require("./routes/networkPayments");
const tenantPaymentSettingsRouter = require("./routes/tenantPaymentSettings");
// WA-1: Per-tenant WhatsApp settings
const tenantWhatsAppSettingsRouter = require("./routes/tenantWhatsAppSettings");
// PR 145: Per-tenant Twilio settings
const tenantTwilioSettingsRouter = require("./routes/tenantTwilioSettings");
const tenantNotificationSettingsRouter = require("./routes/tenantNotificationSettings"); // D5: per-tenant notification toggle matrix
const ownerDashboardRouter = require("./routes/ownerDashboard"); // E: platform-admin overview metrics
const trialSweepJobRouter = require("./routes/trialSweepJob"); // F: defensive trial-status sync via Stripe
const emailReminderJobRouter = require("./routes/emailReminderJob"); // PR H — Email booking reminders
const emailLogRouter = require("./routes/emailLog"); // G2: owner-facing email log surface
const ownerAlertsRouter = require("./routes/ownerAlerts"); // I: real platform-health alerts
const tenantEmailLogRouter = require("./routes/tenantEmailLog"); // K: tenant-side email log
const activationStatusRouter = require("./routes/activationStatus"); // L: activation flow + nudge
const reminderJobRouter = require("./routes/reminderJob");
const smsReminderJobRouter = require("./routes/smsReminderJob"); // Patch H3.5.2 — SMS booking reminders
const whatsappReminderJobRouter = require("./routes/whatsappReminderJob"); // Patch H3.5.3 — WhatsApp booking reminders
const contractInvoiceReminderJobRouter = require("./routes/contractInvoiceReminderJob"); // G2a-S3d — Contract invoice reminders

// PR-TAX-1: Tax & service charge configuration
const tenantTaxRouter = require("./routes/tenantTax");
const { publicTaxRouter } = require("./routes/tenantTax");

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
const plansRouter = require("./routes/plans"); // Patch D4: public pricing data

// PR-4: Billing — webhook MUST be mounted before express.json() (needs raw body)
const stripeWebhookRouter = require("./routes/stripeWebhook");
const billingRouter = require("./routes/billing");

// AI: Claude-powered support agent + landing copy generator
const aiRouter = require("./routes/ai");

const app = express();
const ENABLE_DEBUG_ROUTES =
  String(process.env.ENABLE_DEBUG_ROUTES || "").toLowerCase() === "true";

// ─── Trust proxy (Render sits behind a load balancer) ────────────────────────
app.set("trust proxy", 1);

// ─── Observability (must be first) ───────────────────────────────────────────
app.use(correlationId);   // attaches req.requestId + X-Request-ID header
app.use(securityHeaders); // PR-8: X-Content-Type-Options, X-Frame-Options, HSTS etc.
app.use(requestLogger);   // structured pino-http logging for every request
app.use(apiVersion);      // PR-3: adds X-API-Version header to every response

// ─── CORS ────────────────────────────────────────────────────────────────────
app.use(corsMiddleware);
app.options("*", cors(corsOptions));

// ─── PR-4: Stripe webhook (raw body — MUST be before express.json()) ─────────
app.use("/api/billing", stripeWebhookRouter);

// ─── Body parsers ────────────────────────────────────────────────────────────
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser()); // PR-16: needed for CSRF double-submit cookie

// ─── Static uploads ──────────────────────────────────────────────────────────
app.use("/uploads", express.static(uploadDir));

// ─── Health (before API routes — no auth required, no rate limit) ────────────
app.use("/health", healthRouter);
app.use("/api/plans", plansRouter); // Patch D4: public pricing data (no auth)


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
app.use("/api/tenants", tenantLookupLimiter, tenantsRouter);

app.use("/api/tenant-hours", tenantHoursRouter);
app.use("/api/tenant-blackouts", tenantBlackoutsRouter);
app.use("/api/services", servicesRouter);
app.use("/api/staff", staffRouter);
app.use("/api/resources", resourcesRouter);
app.use("/api/tenant-categories", tenantCategoriesRouter); // PR-CAT1
app.use("/api/customers", customersRouter);

app.use("/api/bookings", bookingCreateLimiter, bookingsRouter);

app.use("/api/availability", availabilityLimiter, availabilityRouter);

// RENTAL-1: nightly rental availability check + blocked-dates calendar feed.
app.use("/api/rental-availability", availabilityLimiter, require("./routes/rentalAvailability"));
app.use("/api/rental-payment-links", require("./routes/rentalPaymentLinks"));
// G2-PL-2: Payment links for long-term contract invoices (parallel to rental).
//          Public portal at /pay-invoice/{token}; supports MPGS card, CliQ, cash.
app.use("/api/contract-invoice-payment-links", require("./routes/contractInvoicePaymentLinks"));
app.use("/api/maintenance-tickets", require("./routes/maintenanceTickets")); // PR-MAINT-1
app.use("/api/booking-contracts",   require("./routes/bookingContracts"));   // PR-CONTRACT-1

// G2a-1: long-term contracts + payment schedule templates
app.use("/api/contracts",                  contractsRouter);
app.use("/api/payment-schedule-templates", paymentScheduleTemplatesRouter);

// G1: Group / class bookings (sessions, seats, waitlist, instructors)
app.use("/api/classes",                    require("./routes/classes"));

app.use("/api/reminder-job", reminderJobRouter);
app.use("/api/sms-reminder-job", smsReminderJobRouter); // Patch H3.5.2 — SMS booking reminders
app.use("/api/whatsapp-reminder-job", whatsappReminderJobRouter); // Patch H3.5.3 — WhatsApp booking reminders
app.use("/api/email-reminder-job", emailReminderJobRouter); // PR H — Email booking reminders
app.use("/api/contract-invoice-reminder-job", contractInvoiceReminderJobRouter); // G2a-S3d — Contract invoice reminders

app.use("/api/membership-plans", membershipPlansRouter);
app.use("/api/customer-memberships", customerMembershipsRouter);

// ─── Tenant-scoped APIs ───────────────────────────────────────────────────────
app.use("/api/tenant", tenantUsersRouter);
app.use("/api/tenant", tenantStaffPortalRouter);
app.use("/api/tenant", tenantUserPermissionsRouter);
app.use("/api/tenant", tenantPlanRouter);
app.use("/api/tenant", tenantDashboardRouter);
app.use("/api/tenant", tenantStaffScheduleRouter);
app.use("/api/tenant", serviceHoursRouter); // PR-SH1: per-service time windows
app.use("/api/tenant", sessionsRouter);     // PR-SESSIONS: group/parallel booking sessions
app.use("/api/tenant", tenantHomeLandingRouter);
app.use("/api/tenant", tenantBookingPolicyRouter); // Patch 151b-fix: /:slug/booking-policy
app.use("/api/tenant", tenantBrandingRouter);
app.use("/api/tenant", tenantMembershipCheckoutRouter);
app.use("/api/tenant", tenantRatesRouter);
app.use("/api/tenant", tenantBookingsRouter);
app.use("/api/tenant", tenantPrepaidCatalogRouter);
app.use("/api/tenant", tenantPrepaidAccountingRouter);
app.use("/api/tenant", tenantPaymentSettingsRouter); // PAY-1: /:slug/payment-settings
app.use("/api/tenant", tenantWhatsAppSettingsRouter); // WA-1: /:slug/whatsapp-settings
app.use("/api/tenant", tenantTwilioSettingsRouter);   // PR 145: /:slug/twilio-settings
app.use("/api/tenant", tenantNotificationSettingsRouter); // D5: /:slug/notification-settings
app.use("/api/tenant", tenantEmailLogRouter); // K: /:slug/email-log + /:slug/email-log/stats (owner only)
app.use("/api/tenant", activationStatusRouter); // L: /:slug/activation-status (viewer+)
app.use("/api/tenant", tenantTaxRouter);              // PR-TAX-1: /:slug/tax-config
app.use("/api/invites", invitesRouter);

// ─── PAY-1: Network payment flow (public — customer checkout) ─────────────────
app.use("/api/network-payment", networkPaymentsRouter);

// ─── PR-4: Billing REST endpoints (checkout, portal, status) ─────────────────
app.use("/api/billing", billingRouter);
app.use("/api/dsr", csrfProtection, dsrRouter); // PR-16 // PR-8: GDPR Data Subject Requests

// ─── Public APIs ─────────────────────────────────────────────────────────────
app.use("/api/public", publicApiLimiter, publicPricingRouter);
app.use("/api/public", publicApiLimiter, publicTaxRouter); // PR-TAX-1: /:slug/tax-info
app.use("/api/guest",  publicApiLimiter, require("./routes/guestPortal")); // PR-GUEST-1

// ─── Uploads ─────────────────────────────────────────────────────────────────
app.use("/api/uploads", uploadsRouter);

// ─── Media Library ────────────────────────────────────────────────────────────
app.use("/api/media-library", mediaLibraryRoutes);

// ─── Theme system ─────────────────────────────────────────────────────────────
app.use("/api/admin/themes", adminThemesRouter);
app.use("/api/owner-alerts", ownerAlertsRouter); // I: GET / (admin-only)
app.use("/api/email-log", emailLogRouter); // G2: GET email log + stats (admin-only)
app.use("/api/jobs", trialSweepJobRouter); // F: POST /api/jobs/trial-sweep (admin-only)
app.use("/api/jobs", activationStatusRouter); // L: POST /api/jobs/activation-nudge (cron)
app.use("/api/owner-dashboard", ownerDashboardRouter); // E: GET /overview (admin-only)
app.use("/api/admin/tenants", adminTenantsThemeRouter);
app.use("/api/public/tenant-theme", publicApiLimiter, publicTenantThemeRouter);

// ─── Misc ─────────────────────────────────────────────────────────────────────
app.use("/api/links", linksRouter);
app.use("/api/tenant-domains", tenantDomainsRouter);

// AI: Claude-powered routes
app.use("/api/ai", aiRouter);

if (ENABLE_DEBUG_ROUTES && process.env.NODE_ENV !== "production") {
  app.use("/api/debug", debugGoogleAuthRouter);
}

// ─── 404 catch-all for /api/* ─────────────────────────────────────────────────
app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));

// ─── Central error handler (must be last) ────────────────────────────────────
app.use(errorHandler);

module.exports = app;
