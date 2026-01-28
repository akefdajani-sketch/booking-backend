BookFlow – System Map (v1)
Frontend Routes
/                     → Landing (no backend)
/owner/dashboard      → Platform admin
/owner/[slug]         → Tenant operations
/book/[slug]          → Public booking

Frontend API Layer
/api/proxy/*           → Public, tenant-aware proxy
/api/proxy-admin/*    → Authenticated owner/admin proxy


Responsibilities:

Inject tenant context

Enforce auth (admin routes)

Forward requests without mutation

Backend Core
/api/public/tenant-theme/:slug   → Theme source of truth
/api/services                    → Tenant-scoped
/api/staff
/api/resources
/api/availability
/api/bookings


Rules:

Tenant required everywhere

Availability = single source of truth

Booking + membership ledger = atomic

Database Guarantees

Tenants isolated

Ledger append-only

No cross-tenant reads

No derived booking duration hacks

Mental Model (Non-Negotiable)

Theme → Services → Availability → Slots → Booking → Ledger

If a change breaks this chain, it is invalid.
