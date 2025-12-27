// src/app.js
const express = require("express");
const cors = require("cors");

const { corsMiddleware, corsOptions } = require("./middleware/cors");
const { uploadDir } = require("./middleware/upload");

// Routers
const tenantsRouter = require("./routes/tenants");
const tenantHoursRouter = require("./routes/tenantHours");
const servicesRouter = require("./routes/services");
const staffRouter = require("./routes/staff");
const resourcesRouter = require("./routes/resources");
const customersRouter = require("./routes/customers");
const bookingsRouter = require("./routes/bookings");
const availabilityRouter = require("./routes/availability");
const membershipsRouter = require("./routes/memberships");

const app = express();

/**
 * --- Global middleware (match your current index.js behavior) ---
 */

// CORS (including OPTIONS preflight)
app.use(corsMiddleware);
app.options("*", cors(corsOptions));

// Body parsing
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// Static uploads (keep same URL path as before)
app.use(
  "/uploads",
  express.static(uploadDir, {
    fallthrough: false,
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
app.use("/api/memberships", membershipsRouter);

/**
 * --- Health check ---
 */
app.get("/health", (req, res) => res.json({ ok: true }));

/**
 * --- 404 handler for API routes (optional but helpful) ---
 */
app.use("/api", (req, res) => {
  res.status(404).json({ error: "Not found" });
});

/**
 * --- Global error handler (keeps crashes out of prod) ---
 */
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

module.exports = app;
