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

## Approved Exceptions — CASCADE Foreign Keys (Auto-generated)

**Source snapshot:** `docs/db/generated/fk_inventory_2026-01-26.csv`  
**Rule:** Every CASCADE must be explicitly approved and justified.

| CASCADE FK (local → referenced) | ON DELETE | ON UPDATE | Constraint | Why this CASCADE is safe / necessary | Approved by | Approved date |
|---|---|---|---|---|---|---|
| customers.tenant_id → tenants.id | CASCADE | NO ACTION | customers_tenant_id_fkey | TODO | TODO | 2026-01-26 |
| membership_plans.tenant_id → tenants.id | CASCADE | NO ACTION | membership_plans_tenant_id_fkey | TODO | TODO | 2026-01-26 |
| resources.tenant_id → tenants.id | CASCADE | NO ACTION | resources_tenant_id_fkey | TODO | TODO | 2026-01-26 |
| saas_plan_features.plan_id → saas_plans.id | CASCADE | NO ACTION | saas_plan_features_plan_id_fkey | TODO | TODO | 2026-01-26 |
| service_unavailability.service_id → services.id | CASCADE | NO ACTION | fk_service_unavailability_service | TODO | TODO | 2026-01-26 |
| service_unavailability.tenant_id → tenants.id | CASCADE | NO ACTION | fk_service_unavailability_tenant | TODO | TODO | 2026-01-26 |
| services.tenant_id → tenants.id | CASCADE | NO ACTION | services_tenant_id_fkey | TODO | TODO | 2026-01-26 |
| staff.tenant_id → tenants.id | CASCADE | NO ACTION | staff_tenant_id_fkey | TODO | TODO | 2026-01-26 |
| staff_weekly_schedule.staff_id → staff.id | CASCADE | NO ACTION | fk_staff_weekly_schedule_staff | TODO | TODO | 2026-01-26 |
| staff_weekly_schedule.tenant_id → tenants.id | CASCADE | NO ACTION | fk_staff_weekly_schedule_tenant | TODO | TODO | 2026-01-26 |
| tenant_blackouts.tenant_id → tenants.id | CASCADE | NO ACTION | tenant_blackouts_tenant_id_fkey | TODO | TODO | 2026-01-26 |
| tenant_entitlements.tenant_id → tenants.id | CASCADE | NO ACTION | tenant_entitlements_tenant_id_fkey | TODO | TODO | 2026-01-26 |
| tenant_hours.tenant_id → tenants.id | CASCADE | NO ACTION | tenant_hours_tenant_id_fkey | TODO | TODO | 2026-01-26 |
| tenant_invites.tenant_id → tenants.id | CASCADE | NO ACTION | tenant_invites_tenant_id_fkey | TODO | TODO | 2026-01-26 |
| tenant_invoice_lines.invoice_id → tenant_invoices.id | CASCADE | NO ACTION | tenant_invoice_lines_invoice_id_fkey | TODO | TODO | 2026-01-26 |
| tenant_invoices.tenant_id → tenants.id | CASCADE | NO ACTION | tenant_invoices_tenant_id_fkey | TODO | TODO | 2026-01-26 |
| tenant_payments.invoice_id → tenant_invoices.id | CASCADE | NO ACTION | tenant_payments_invoice_id_fkey | TODO | TODO | 2026-01-26 |
| tenant_payments.tenant_id → tenants.id | CASCADE | NO ACTION | tenant_payments_tenant_id_fkey | TODO | TODO | 2026-01-26 |
| tenant_subscriptions.tenant_id → tenants.id | CASCADE | NO ACTION | tenant_subscriptions_tenant_id_fkey | TODO | TODO | 2026-01-26 |
| tenant_users.tenant_id → tenants.id | CASCADE | NO ACTION | tenant_users_tenant_id_fkey | TODO | TODO | 2026-01-26 |
| tenant_users.user_id → users.id | CASCADE | NO ACTION | tenant_users_user_id_fkey | TODO | TODO | 2026-01-26 |

### Notes for reviewers (how to fill “Why safe / necessary”)
Typical acceptable justifications:
- **Tenant-owned child tables:** cascading on tenant deletion prevents orphan data after a tenant is intentionally removed.
- **Pure join/mapping tables:** safe to cascade because records have no standalone business meaning.
- **Line items / schedules:** safe if they are strictly dependent children of a parent entity (invoice lines → invoice, weekly schedule → staff).

If any CASCADE affects core immutable business history (e.g., bookings, ledger), it should be changed to RESTRICT unless you have a written retention/archival policy.

