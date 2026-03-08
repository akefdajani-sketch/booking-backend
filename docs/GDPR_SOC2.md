# GDPR & SOC-2 Compliance — Flexrz / BookFlow

## Overview

This document describes how Flexrz / BookFlow addresses GDPR (EU 2016/679) obligations
and SOC-2 Type II criteria relevant to a multi-tenant SaaS booking platform.

**PR-8** adds the foundational controls. Full certification requires ongoing operational
processes described in Section 4.

---

## 1. GDPR Controls

### 1.1 Data Subject Rights (DSR)

| Article | Right | Implementation |
|---------|-------|---------------|
| Art. 15 | Right of access | `POST /api/dsr/request` → `type=access` → owner exports via `GET /api/dsr/:id/export` |
| Art. 17 | Right to erasure | `POST /api/dsr/request` → `type=erasure` → owner processes manually (legal-hold safe) |
| Art. 20 | Data portability | `POST /api/dsr/request` → `type=portability` → JSON export via `GET /api/dsr/:id/export` |

**Response SLA:** 30 days (stated in DSR confirmation message, per Art. 12).

**Idempotency:** Only one `pending` or `processing` request per email per type per tenant at a time.
Duplicate requests return `409 Conflict` with the existing `dsr_id`.

**Erasure process:** Erasure requests are intentionally *not* automated.
The tenant owner must:
1. Verify no active bookings or legal holds exist.
2. Manually delete the customer record (via `DELETE /api/customers/:id`).
3. Mark the DSR as `completed` via `PATCH /api/dsr/:id/status`.

This two-step process prevents accidental data loss while maintaining compliance.

### 1.2 Data Minimisation

- The DSR export (`GET /api/dsr/:id/export`) returns only:
  - Customer profile (name, email, phone)
  - Booking history (service name, times, status)
  - Membership history (plan name, status)
- No internal IDs, financial card data, or system metadata are included.

### 1.3 Audit Trail

All DSR actions are written to `audit_log` with:
- `actor_email` — who performed the action
- `event_type` — `dsr.access_requested`, `dsr.erasure_requested`, `dsr.completed`, etc.
- `ip_address` — for traceability
- `request_id` — correlates with server logs (X-Request-ID)

---

## 2. SOC-2 Controls

### 2.1 Security Headers (CC6.1, CC6.7)

Every HTTP response now includes:

| Header | Value | Control |
|--------|-------|---------|
| `X-Content-Type-Options` | `nosniff` | Prevents MIME-type confusion attacks |
| `X-Frame-Options` | `DENY` | Prevents clickjacking |
| `X-XSS-Protection` | `1; mode=block` | Legacy XSS protection |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Prevents URL leakage |
| `Permissions-Policy` | camera/mic/geo disabled | Feature restriction |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | HTTPS enforcement (production only) |
| ~~`X-Powered-By`~~ | removed | Removes Express fingerprint |

### 2.2 Audit Log (CC7.2, CC7.3)

The `audit_log` table provides an immutable append-only event trail.

**Design rules:**
- `INSERT` only — no `UPDATE` or `DELETE` ever issued by application code.
- Failures are non-fatal (logged at `error` level, never crash the request).
- PII is never stored in `meta` — only resource IDs and action types.
- Indexed by `(tenant_id, created_at DESC)` for efficient tenant-scoped queries.

**Covered event types:**

```
booking.created      booking.updated      booking.cancelled
customer.created     customer.deleted     customer.data_exported
staff.created        staff.deleted
service.created      service.deleted
membership.created   membership.cancelled
dsr.access_requested dsr.erasure_requested dsr.portability_requested
dsr.completed        dsr.rejected
tenant.settings_updated
auth.login           auth.logout
```

### 2.3 Rate Limiting (CC6.6)

Public-facing endpoints are rate-limited (PR-2):
- `/api/availability` — 60 req/min
- `POST /api/bookings` — 20 req/min
- General public API — 120 req/min

### 2.4 Tenant Isolation (CC6.3)

All DB queries are scoped by `tenant_id`. The `requireTenant` middleware resolves
and attaches `req.tenantId` before any route handler executes.

### 2.5 Authentication (CC6.1)

- Owner/admin operations require Google OAuth JWT or Access Token (PR-2 requireGoogleAuth)
- Admin API operations require `ADMIN_API_KEY` Bearer token
- Public booking operations require no auth (by design — public booking pages)

---

## 3. DSR API Reference

### Submit a DSR (Customer-facing)

```
POST /api/dsr/request
Content-Type: application/json
x-tenant-slug: <slug>          or  body.tenantSlug

Body:
{
  "email":        "customer@example.com",
  "request_type": "access" | "erasure" | "portability"
}

Response 201:
{
  "ok":          true,
  "dsr_id":      1,
  "status":      "pending",
  "request_type": "access",
  "message":     "Your data request has been received..."
}

Response 409 (duplicate pending request):
{
  "error":  "A pending request of this type already exists...",
  "dsr_id": 1
}
```

### List DSR Requests (Owner)

```
GET /api/dsr?tenantSlug=<slug>&status=pending&limit=50&offset=0
Authorization: Bearer <google-token>

Response 200:
{
  "data": [ { id, request_type, requester_email, status, created_at, ... } ],
  "meta": { "total": 5, "limit": 50, "offset": 0, "hasMore": false }
}
```

### Update DSR Status (Owner)

```
PATCH /api/dsr/:id/status
Authorization: Bearer <google-token>

Body: { "status": "processing" | "completed" | "rejected", "notes": "..." }

Response 200: { "ok": true, "dsr": { id, status, request_type, requester_email } }
```

### Export Customer Data (Owner — Art. 15/20)

```
GET /api/dsr/:id/export
Authorization: Bearer <google-token>

Response 200:
{
  "export_meta": { "generated_at", "dsr_id", "request_type", "requester", "gdpr_basis" },
  "customer":    { id, name, email, phone, created_at },
  "bookings":    [ { id, start_time, end_time, status, service_name } ],
  "memberships": [ { id, plan_name, status, created_at } ]
}
```

---

## 4. Operational Checklist (ongoing)

These processes must be followed by the platform operator:

- [ ] DSR requests acknowledged within **72 hours** of receipt (Art. 12)
- [ ] DSR requests completed within **30 days** (Art. 12)
- [ ] `audit_log` reviewed monthly for anomalous access patterns
- [ ] `ADMIN_API_KEY` rotated every 90 days
- [ ] Google OAuth client secret reviewed annually
- [ ] Sentry alerts reviewed within 24 hours of trigger
- [ ] Render environment variables audited quarterly

---

## 5. Out of Scope (Requires Additional Work)

| Item | Notes |
|------|-------|
| Cookie consent banner | Frontend responsibility |
| Privacy policy document | Legal responsibility |
| Data Processing Agreement (DPA) | Legal/commercial |
| Automated erasure execution | Planned — currently manual |
| DSAR for non-email-verified users | Edge case — requires identity verification process |
| Penetration testing | Recommended annually for SOC-2 Type II |
