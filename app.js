const express = require("express");
const cors = require("cors");

const { corsMiddleware, corsOptions } = require("./middleware/cors");
const { uploadDir } = require("./middleware/upload");

// Core routers
const tenantsRouter = require("./routes/tenants");
const tenantHoursRouter = require("./routes/tenantHours");
const servicesRouter = require("./routes/services");
const staffRouter = require("./routes/staff");
const resourcesRouter = require("./routes/resources");
const customersRouter = require("./routes/customers");
const bookingsRouter = require("./routes/bookings");
const availabilityRouter = require("./routes/availability");
const membershipPlansRouter = require("./routes/membershipPlans");
const customerMembershipsRouter = require("./routes/customerMemberships");

// Users & Roles
const tenantUsersRouter = require("./routes/tenantUsers");
const invitesRouter = require("./routes/invites");
const tenantPlanRouter = require("./routes/tenantPlan");

// Uploads
const uploadsRouter = require("./routes/uploads");

// NEW: Theme system routes
const adminThemesRouter = require("./routes/adminThemes");
const adminTenantsThemeRouter = require("./routes/adminTenantsTheme");
const publicTenantThemeRouter = require("./routes/publicTenantTheme");

const app = express();

/**
 * --- Global middleware ---
 */
app.use(corsMiddleware);
app.options("*", cors(corsOptions));

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(
  "/uploads",
  express.static(uploadDir, {
    fallthrough: true,
    setHeaders: (res) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    },
  })
);

/**
 * --- Routes ---
 */
app.use("/api/tenants", tenantsRouter);
app.use("/api/tenant-hours", tenantHoursRouter);
app.use("/api/services", servicesRouter);
app.use("/api/staff", staffRouter);
app.use("/api/resources", resourcesRouter);
app.use("/api/customers", customersRouter);
app.use("/api/bookings", bookingsRouter);
app.use("/api/availability", availabilityRouter);
app.use("/api/membership-plans", membershipPlansRouter);
app.use("/api/customer-memberships", customerMembershipsRouter);

// Users & Roles
app.use("/api/tenant", tenantUsersRouter);
app.use("/api/tenant", tenantPlanRouter);
app.use("/api/invites", invitesRouter);

// Uploads
app.use("/api/uploads", uploadsRouter);

// Theme system
app.use("/api/admin/themes", adminThemesRouter);
app.use("/api/admin/tenants", adminTenantsThemeRouter);
app.use("/api/public/tenant-theme", publicTenantThemeRouter);

/**
 * --- Health check ---
 */
app.get("/health", (req, res) => res.json({ ok: true }));

/**
 * --- 404 handler for API routes ---
 */
app.use("/api", (req, res) => {
  res.status(404).json({ error: "Not found" });
});

/**
 * --- Global error handler ---
 */
app.use((err, req, res, next) => {
  if (err && err.code === "ENOENT" && req.originalUrl && req.originalUrl.startsWith("/uploads")) {
    return res.status(404).end();
  }
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

module.exports = app;
