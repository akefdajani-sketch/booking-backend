# Customer Routes Audit — 2026-05-10

Scope: `routes/customers.js` (orchestrator) and the seven mounted sub-files in `routes/customers/`:
`admin.js`, `meProfile.js`, `meAvatar.js`, `mePrepaid.js`, `meBookings.js`, `meMemberships.js`, `mePackages.js`.

Reviewed against `CLAUDE.md` rules for **tenant isolation**, **soft-delete**, and **logging**. No code changes were made — this is read-only.

`routes/customers.js` itself is a thin router; all findings below live in the seven sub-files.

---

## High severity

### H1. `me*.js` ignore soft-delete entirely — soft-deleted customers retain full self-service access
Every `me*.js` file imports `softDeleteClause` from `utils/customerQueryHelpers` and uses it nowhere. The customer-resolution lookup is identical across all six files and has no `deleted_at` predicate:

```sql
SELECT id FROM customers WHERE tenant_id=$1 AND LOWER(email)=LOWER($2) LIMIT 1
```

A customer soft-deleted via `admin.js DELETE /:customerId` can still hit `/me`, fetch bookings, memberships, packages, prepaid entitlements, and upload/clear avatars.

Customer lookup occurrences:
- `routes/customers/meProfile.js:82-88`
- `routes/customers/meProfile.js:128-131`
- `routes/customers/meAvatar.js:148-154`
- `routes/customers/meAvatar.js:241-248` (UPDATE-with-WHERE acts as the lookup)
- `routes/customers/mePrepaid.js:22-25`
- `routes/customers/mePrepaid.js:86-89`
- `routes/customers/meBookings.js:23-26`
- `routes/customers/meBookings.js:209-212`
- `routes/customers/meMemberships.js:22-25`
- `routes/customers/meMemberships.js:197-200`
- `routes/customers/meMemberships.js:249-252`
- `routes/customers/mePackages.js:105-108`
- `routes/customers/mePackages.js:170-173`
- `routes/customers/mePackages.js:231-234`

Rule violated: `CLAUDE.md` — "Use `softDeleteClause()` from utils … Don't hand-write `WHERE deleted_at IS NULL`." (Here the violation is the *absence* of any soft-delete check, which is worse.)

### H2. `meProfile.js` POST `/me` silently resurrects soft-deleted customers
`routes/customers/meProfile.js:33-50` — `INSERT … ON CONFLICT (tenant_id, email) DO UPDATE SET name = …, phone = …`. If a soft-deleted row exists with the same `(tenant_id, email)`, the UPSERT updates it without touching `deleted_at`. The next `/me` call returning that row will see updated profile data; combined with H1, the customer is functionally un-deleted on next sign-in. Soft-delete is reversible by the affected customer.

### H3. `meBookings.js` returns soft-deleted bookings to the customer
`routes/customers/meBookings.js:180-184`:

```sql
WHERE b.tenant_id = $1 AND b.customer_id = $2
ORDER BY ${startTime} DESC
LIMIT 200
```

No `b.deleted_at IS NULL`. The admin booking list (`admin.js:346`) filters deleted bookings; the customer-facing equivalent does not. Customers see history they shouldn't.

The DELETE handler at `routes/customers/meBookings.js:216-220` similarly has no `deleted_at` filter on its existence check, so a customer can act on a soft-deleted booking row.

### H4. `admin.js` POST `/` trusts body-supplied `tenantId` / `tenantSlug`
`routes/customers/admin.js:129-164`. Despite `requireTenant` being on the route, the INSERT writes to `resolvedTenantId`, derived solely from `req.body.tenantId` or a slug lookup at `admin.js:138`. `req.tenantId` is never compared. A user authenticated as staff for tenant A who passes `{ tenantId: B, ... }` would have `requireAdminOrTenantRole("staff")` evaluated against tenant A but the row inserted into tenant B.

Whether this is exploitable end-to-end depends on the role-check internals (whether it scopes to `req.tenantId` strictly), but the route is at minimum trusting client-controlled `tenant_id` for a write — exactly the cross-tenant leakage shape `CLAUDE.md` calls out.

Rule violated: `CLAUDE.md` — "Tenant isolation is sacred … Adding a query? Ask whether it could ever return rows from another tenant — if yes, it's wrong." Same logic applies to writes.

### H5. `meMemberships.js` subscribe — transaction commands run on the shared pool
`routes/customers/meMemberships.js:288, 304, 333, 414, 430, 433` — `pool.query("BEGIN")`, `pool.query("COMMIT")`, `pool.query("ROLLBACK")` plus interleaved `pool.query(...)` writes to `customer_memberships` and `membership_ledger`. `pg`'s `Pool` returns a different client per call, so `BEGIN` and `COMMIT` may land on different connections. Under concurrency the membership creation + ledger grant can be split across transactions or interleaved with another request's transaction.

The other transactional routes in the same directory use the correct pattern (`meBookings.js:229` `pool.connect()` + dedicated client; `mePackages.js:220` ditto). This one does not.

Rule violated: `CLAUDE.md` — "Membership ledger is append-only. No edits, no deletes. Debits/credits must be idempotent under retries." Atomicity is a precondition for that rule and is not actually held here.

---

## Medium severity

### M1. `admin.js` hand-writes `deleted_at IS NULL` / `IS NOT NULL` in five places
- `routes/customers/admin.js:185` (PATCH /:customerId)
- `routes/customers/admin.js:218` (DELETE /:customerId)
- `routes/customers/admin.js:241` (PATCH /:customerId/restore)
- `routes/customers/admin.js:346` (GET /:customerId/bookings — bookings data query)
- `routes/customers/admin.js:367` (GET /:customerId/bookings — count query)

Rule violated: `CLAUDE.md` — "Don't hand-write `WHERE deleted_at IS NULL`."

The `customers` table has the column post-migration `005`, so the customer mutations work; the bookings ones (`admin.js:346`, `:367`) are the more meaningful risk because they assume `bookings.deleted_at` exists in every environment.

### M2. `meMemberships.js` runs DDL from a request handler
`routes/customers/meMemberships.js:339-343`:

```js
await pool.query(`
  ALTER TABLE customer_memberships
    ADD COLUMN IF NOT EXISTS payment_method TEXT
      CHECK (payment_method IS NULL OR payment_method IN ('card','cliq','cash','free'))
`).catch(() => { /* ... */ });
```

Rule violated: `CLAUDE.md` — "Adding a migration over hand-running SQL on Render." Schema mutations from a POST handler also bypass `migrations/`'s sequencing and `npm run migrate:dry` review.

### M3. `meAvatar.js` bypasses `requireTenant`
`routes/customers/meAvatar.js:103-106` and `:221`. Both routes resolve `tenantSlug` themselves via `req.body.tenantSlug || req.query.tenantSlug` (`:114-118`, `:223-227`) and look the tenant up directly (`:129-132`, `:231-234`). `requireTenant` is not on either route.

Currently not exploitable because the customer row is then matched on `(tenant_id, LOWER(email))`, but it diverges from every other `me*.js` route and would silently break if `requireTenant` ever adds checks beyond slug→id lookup (e.g. host-binding, deactivation, etc.).

### M4. `meMemberships.js` ledger handler reads the wrong request property
`routes/customers/meMemberships.js:187`: `const email = req.user?.email;`. Every other handler reads `req.googleUser?.email`. `requireAppAuth` populates `req.googleUser`, not `req.user` (per the rest of the file and the other six route files). Result: this handler returns 401 "Missing user" for all callers. Functional bug, not a security issue, but worth flagging in the same pass.

---

## Low severity

### L1. `console.error` is used everywhere instead of `utils/logger`
Rule violated: `CLAUDE.md` — "Use `utils/logger` (pino), not `console.*`. Errors: `logger.error({ err }, 'message')` — `err` as a key, structured."

Occurrences:
- `routes/customers/admin.js:48, 119, 161, 202, 226, 249, 382`
- `routes/customers/meProfile.js:54, 92, 105, 187`
- `routes/customers/meAvatar.js:204, 256`
- `routes/customers/mePrepaid.js:75, 114`
- `routes/customers/meBookings.js:190, 251`
- `routes/customers/meMemberships.js:170, 230, 434, 438`
- `routes/customers/mePackages.js:157, 215, 361`

Total: ~24 calls, zero use of `utils/logger`.

### L2. `meBookings.js` GET `/me/bookings` has no pagination knobs
`routes/customers/meBookings.js:182-184` — hard `LIMIT 200` with no `offset`/`limit` query params. Bounded, so not unbounded-load class, but inconsistent with `admin.js:63-66`'s `limit`/`offset`/`total`/`hasMore` shape, and a customer with >200 bookings cannot page back.

### L3. Inconsistent tenant-id source between handlers
`meBookings.js:202` reads `req.tenant?.id`, while every other `me*.js` handler reads `req.tenantId || req.tenant?.id`. Not a security issue (both are populated by `requireTenant`), but a brittle inconsistency.

---

## Summary

| Severity | Count | Theme |
|---|---|---|
| High | 5 | Soft-delete bypass at customer scope (H1–H3); cross-tenant write surface in admin POST (H4); membership-ledger transaction integrity (H5) |
| Medium | 4 | Hand-written `deleted_at` predicates (M1); DDL from request handler (M2); avatar route diverges from middleware pattern (M3); broken `req.user` reference (M4) |
| Low | 3 | Logger non-use (L1); pagination shape (L2); minor inconsistency (L3) |

Highest-leverage single fix: introduce `softDeleteClause` (or an equivalent) into the customer-resolution lookup that's duplicated across all six `me*.js` files. That one change closes H1 and partly mitigates H2/H3.

Highest-correctness single fix: convert `meMemberships.js` subscribe to `pool.connect()` + dedicated client (H5).
