// src/app.js
const express = require("express");

// If you already have cors/bodyparser configs, keep them and move them here:
const { corsMiddleware } = require("./middleware/cors");

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

// --- Global middleware (copy from index.js) ---
app.use(corsMiddleware);
app.use(express.json({ limit: "2mb" })); // match your current limits if different

// --- Route mounting ---
app.use("/api/tenants", tenantsRouter);
app.use("/api/tenant-hours", tenantHoursRouter);
app.use("/api/services", servicesRouter);
app.use("/api/staff", staffRouter);
app.use("/api/resources", resourcesRouter);
app.use("/api/customers", customersRouter);
app.use("/api/bookings", bookingsRouter);
app.use("/api/availability", availabilityRouter);
app.use("/api/memberships", membershipsRouter);

// Optional: your health check
app.get("/health", (req, res) => res.json({ ok: true }));

module.exports = app;
