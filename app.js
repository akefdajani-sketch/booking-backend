const express = require("express");
const cors = require("cors");

const { corsMiddleware, corsOptions } = require("./middleware/cors");
const { uploadDir } = require("./middleware/upload");

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

const uploadsRouter = require("./routes/uploads");

// NEW theme routers
const adminThemesRouter = require("./routes/adminThemes");
const adminTenantsThemeRouter = require("./routes/adminTenantsTheme");
const publicTenantThemeRouter = require("./routes/publicTenantTheme");

// Phase 3 links (staff/resources <-> services)
const linksRouter = require("./routes/links");

// Tenant custom domains (domain -> tenant slug)
const tenantDomainsRouter = require("./routes/tenantDomains");
const debugGoogleAuthRouter = require("./routes/debugGoogleAuth");

const app = express();

app.use(corsMiddleware);
app.options("*", cors(corsOptions));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/uploads", express.static(uploadDir));

// core APIs
app.use("/api/tenants", tenantsRouter);
app.use("/api/tenant-hours", tenantHoursRouter);
app.use("/api/tenant-blackouts", tenantBlackoutsRouter);
app.use("/api/services", servicesRouter);
app.use("/api/staff", staffRouter);
app.use("/api/resources", resourcesRouter);
app.use("/api/customers", customersRouter);
app.use("/api/bookings", bookingsRouter);
app.use("/api/availability", availabilityRouter);
app.use("/api/membership-plans", membershipPlansRouter);
app.use("/api/customer-memberships", customerMembershipsRouter);

// users/roles + invites
app.use("/api/tenant", tenantUsersRouter);
app.use("/api/tenant", tenantPlanRouter);
app.use("/api/tenant", tenantDashboardRouter);
app.use("/api/tenant", tenantStaffScheduleRouter);
app.use("/api/invites", invitesRouter);

// uploads
app.use("/api/uploads", uploadsRouter);

// THEME SYSTEM
app.use("/api/admin/themes", adminThemesRouter);
app.use("/api/admin/tenants", adminTenantsThemeRouter);
app.use("/api/public/tenant-theme", publicTenantThemeRouter);

// Relationship links
app.use("/api/links", linksRouter);

// Tenant custom domains
app.use("/api/tenant-domains", tenantDomainsRouter);

app.get("/health", (req, res) => res.json({ ok: true }));
// TEMP: auth debug endpoint (remove after fix)
app.use("/api/debug", debugGoogleAuthRouter);


app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

module.exports = app;
