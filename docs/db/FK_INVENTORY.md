> **Soft delete note:** BookFlow uses soft delete for business-critical entities.
> CASCADE FKs are treated as “purge-only” behavior and must be explicitly justified.
> Any CASCADE that would destroy audit history under normal operations must be changed to RESTRICT.

# BookFlow Foreign Key Inventory (Critical Tables)

**Last audited:** 2026-01-26  
**Source of truth snapshot:** `docs/db/generated/fk_inventory_2026-01-26.csv`  
**Scope (MVP):** bookings, membership_ledger, customer_memberships, tenant_subscriptions, users, tenant_users, tenants

## How to read this
- **Delete rule**: what happens if the referenced row is deleted
- **Tenant safety**: SAFE if tenant boundaries cannot be violated
- **Rationale**: one-line reason this FK exists

---

## 1) Bookings (core revenue object)

| FK (table.column → ref) | Delete | Update | Tenant safety | Rationale |
|---|---|---|---|---|
| bookings.tenant_id → tenants.id | RESTRICT | RESTRICT | SAFE | Booking must belong to a tenant |
| bookings.customer_id → customers.id | RESTRICT | RESTRICT | SAFE | Booking must have a valid customer |
| bookings.service_id → services.id | RESTRICT | RESTRICT | SAFE | Booking must reference a valid service |
| bookings.resource_id → resources.id | RESTRICT | RESTRICT | SAFE | Booking reserves a resource (e.g., simulator) |
| bookings.staff_id → staff.id | SET NULL / RESTRICT | RESTRICT | SAFE | Optional staff assignment (if applicable) |
| bookings.customer_membership_id → customer_memberships.id | SET NULL / RESTRICT | RESTRICT | SAFE | Optional membership association |

> Replace SET NULL / RESTRICT with whatever your actual FK rules are.

---

## 2) Membership Ledger (append-only accounting)

| FK (table.column → ref) | Delete | Update | Tenant safety | Rationale |
|---|---|---|---|---|
| membership_ledger.customer_membership_id → customer_memberships.id | RESTRICT | RESTRICT | SAFE | Ledger lines must map to a membership |
| membership_ledger.booking_id → bookings.id | RESTRICT / SET NULL | RESTRICT | SAFE | Link debits to bookings when applicable |
| membership_ledger.tenant_id → tenants.id | RESTRICT | RESTRICT | SAFE | Ledger lines belong to a tenant |

---

## 3) Customer Memberships (balance + status)

| FK (table.column → ref) | Delete | Update | Tenant safety | Rationale |
|---|---|---|---|---|
| customer_memberships.tenant_id → tenants.id | RESTRICT | RESTRICT | SAFE | Membership belongs to tenant |
| customer_memberships.customer_id → customers.id | RESTRICT | RESTRICT | SAFE | Membership belongs to customer |
| customer_memberships.membership_plan_id → membership_plans.id | RESTRICT | RESTRICT | SAFE | Membership created from plan |

---

## 4) Tenant Subscriptions (SaaS billing link)

| FK (table.column → ref) | Delete | Update | Tenant safety | Rationale |
|---|---|---|---|---|
| tenant_subscriptions.tenant_id → tenants.id | RESTRICT | RESTRICT | SAFE | Subscription belongs to tenant |
| tenant_subscriptions.plan_id → saas_plans.id / platform_plans.id | RESTRICT | RESTRICT | SAFE | Tenant subscribes to a plan |

> Use the actual referenced table name from your schema.

---

## 5) Users & Tenant Users (access control)

| FK (table.column → ref) | Delete | Update | Tenant safety | Rationale |
|---|---|---|---|---|
| tenant_users.tenant_id → tenants.id | RESTRICT | RESTRICT | SAFE | User is assigned to tenant |
| tenant_users.user_id → users.id | RESTRICT | RESTRICT | SAFE | Assignment references platform user |

---

## 6) Tenants (root entity)

| FK (table.column → ref) | Delete | Update | Tenant safety | Rationale |
|---|---|---|---|---|
| tenants.owner_user_id → users.id (if exists) | RESTRICT | RESTRICT | SAFE | Optional owner mapping |

