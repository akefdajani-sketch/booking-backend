# BookFlow DB Relationship Policy (Foreign Keys)

**Status:** Authoritative  
**Applies to:** All Postgres schemas/tables used by BookFlow  
**Last updated:** 2026-01-26

## Purpose
This document defines the non-negotiable rules for database relationships (Foreign Keys) in BookFlow.
It prevents accidental data loss, enforces consistency across tenants, and supports scalability and auditability.

## Core Principles
1. **Tenant safety by design**
   - All tenant-owned tables MUST include `tenant_id`.
   - No foreign key relationship may allow cross-tenant references in practice.
2. **RESTRICT by default**
   - `ON DELETE RESTRICT` is the default for business-critical data.
   - `ON UPDATE RESTRICT` is preferred unless a strong reason exists.
3. **No silent destruction**
   - `ON DELETE CASCADE` is NOT allowed for core business entities (bookings, customers, memberships, invoices, payments).
4. **Optional relationships**
   - `ON DELETE SET NULL` is allowed only when the relationship is genuinely optional and the system behaves correctly with NULL.
5. **Join tables exception**
   - `ON DELETE CASCADE` is allowed only for “pure join tables” with no business meaning on their own (e.g., mapping tables), and must be documented as an approved exception.

## Required Artifacts
BookFlow must maintain:
- `docs/db/generated/fk_inventory_<date>.csv` (raw snapshot from the DB)
- `docs/db/FK_INVENTORY.md` (human-reviewed inventory)

## Audit & Release Gate (PR-C)
For every production release:
1. Generate a fresh FK snapshot CSV.
2. Diff the previous snapshot.
3. Review any changes to FKs, especially any `CASCADE` rules.
4. Update `FK_INVENTORY.md` (date + rationale notes).
5. If any `CASCADE` exists, it MUST be listed under “Approved Exceptions” in `FK_INVENTORY.md`.

## Approved Exceptions
Exceptions must be explicitly listed in `FK_INVENTORY.md` with:
- FK name and tables
- Delete/update rule
- Why it is safe
- Why it is necessary
- Date approved

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
