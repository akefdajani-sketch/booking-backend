// routes/tenantBookings.js
// Tenant-scoped bookings router wrapper.
//
// Adds:
//   GET /api/tenant/:slug/bookings
// (and any other routes exposed by ./bookings)
//
// Why:
// - The Next.js frontend proxy forwards /api/proxy/tenant/:slug/bookings
//   to the backend as /api/tenant/:slug/bookings.
// - Backend already supports bookings at /api/bookings (tenant-scoped via tenantSlug),
//   but did not expose the tenant-prefixed route.
//
// This wrapper injects req.query.tenantSlug from :slug and delegates to the existing
// bookings router so auth/RBAC and response shape stay consistent.

const express = require("express");
const router = express.Router();

// Reuse existing bookings router (contains requireTenant / RBAC)
const bookingsRouter = require("./bookings");

router.use(
  "/:slug/bookings",
  (req, _res, next) => {
    req.query = req.query || {};
    req.query.tenantSlug = req.params.slug;
    next();
  },
  bookingsRouter
);

module.exports = router;
