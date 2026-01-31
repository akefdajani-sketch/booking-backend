## Approved Exceptions — CASCADE Foreign Keys (Tenant Purge = YES)

**Source snapshot:** `docs/db/generated/fk_inventory_2026-02-01.csv`  
**Soft delete policy:** Business-critical entities are soft-deleted in normal operations.  
**Hard delete policy:** Physical deletes are permitted **only** via the controlled **Owner-only Tenant Purge** workflow.

### Tenant Purge Governance (required)
- **Workflow name:** Tenant Purge (Owner-only)
- **Allowed action:** Hard delete tenant + dependent tenant-owned data
- **Restriction:** Not available to tenants; not available via public APIs
- **Audit requirement:** Purge must be logged (who, when, which tenant, reason)

---

### ✅ Approved CASCADEs — Dependent-child cleanup (safe)
These children have no standalone business meaning and should be removed if the parent is hard-deleted.

| CASCADE FK (local → referenced) | Constraint | Why this CASCADE is safe / necessary | Approved by | Approved date |
|---|---|---|---|---|
| saas_plan_features.plan_id → saas_plans.id | saas_plan_features_plan_id_fkey | Feature rows are dependent on the plan; hard-deleting a plan must not leave orphan features. | Owner | 2026-01-26 |
| staff_weekly_schedule.staff_id → staff.id | fk_staff_weekly_schedule_staff | Weekly schedule rows are strictly dependent on the staff record; hard delete cleanup is correct. | Owner | 2026-01-26 |
| service_unavailability.service_id → services.id | fk_service_unavailability_service | Unavailability rows are strictly dependent on the service record; hard delete cleanup is correct. | Owner | 2026-01-26 |
| tenant_invoice_lines.invoice_id → tenant_invoices.id | tenant_invoice_lines_invoice_id_fkey | Invoice line items are dependent on the invoice; hard-deleting an invoice must remove its lines. | Owner | 2026-01-26 |
| tenant_payments.invoice_id → tenant_invoices.id | tenant_payments_invoice_id_fkey | Payments are dependent on the invoice record; hard delete cleanup prevents orphan payment rows. | Owner | 2026-01-26 |
| resource_service_links.resource_id → resources.id | resource_service_links_resource_id_fkey | Join rows are strictly dependent on resource; safe cleanup on hard delete. | Owner | 2026-02-01 |
| resource_service_links.service_id → services.id | resource_service_links_service_id_fkey | Join rows are strictly dependent on service; safe cleanup on hard delete. | Owner | 2026-02-01 |
| staff_resource_links.resource_id → resources.id | staff_resource_links_resource_id_fkey | Join rows are strictly dependent on resource; safe cleanup on hard delete. | Owner | 2026-02-01 |
| staff_resource_links.staff_id → staff.id | staff_resource_links_staff_id_fkey | Join rows are strictly dependent on staff; safe cleanup on hard delete. | Owner | 2026-02-01 |
| staff_service_links.service_id → services.id | staff_service_links_service_id_fkey | Join rows are strictly dependent on service; safe cleanup on hard delete. | Owner | 2026-02-01 |
| staff_service_links.staff_id → staff.id | staff_service_links_staff_id_fkey | Join rows are strictly dependent on staff; safe cleanup on hard delete. | Owner | 2026-02-01 |

---

### ⚠️ Approved CASCADEs — Tenant-owned children (purge-only)
These are approved **only because Tenant Purge exists**. Under soft delete operations, tenants are not physically deleted.

| CASCADE FK (local → referenced) | Constraint | Why this CASCADE is safe / necessary | Approved by | Approved date |
|---|---|---|---|---|
| customers.tenant_id → tenants.id | customers_tenant_id_fkey | Tenant Purge must fully remove tenant-owned customer rows to avoid orphaned tenant data after hard deletion. | Owner | 2026-01-26 |
| membership_plans.tenant_id → tenants.id | membership_plans_tenant_id_fkey | Tenant Purge removes tenant-owned plan records; plans have no meaning after tenant hard deletion. | Owner | 2026-01-26 |
| resources.tenant_id → tenants.id | resources_tenant_id_fkey | Tenant Purge removes tenant-owned resources; prevents orphan operational data after tenant deletion. | Owner | 2026-01-26 |
| services.tenant_id → tenants.id | services_tenant_id_fkey | Tenant Purge removes tenant-owned services; prevents orphan service definitions after tenant deletion. | Owner | 2026-01-26 |
| staff.tenant_id → tenants.id | staff_tenant_id_fkey | Tenant Purge removes tenant-owned staff; prevents orphan staff data after tenant deletion. | Owner | 2026-01-26 |
| service_unavailability.tenant_id → tenants.id | fk_service_unavailability_tenant | Tenant Purge removes tenant-owned scheduling blocks; no meaning after tenant deletion. | Owner | 2026-01-26 |
| staff_weekly_schedule.tenant_id → tenants.id | fk_staff_weekly_schedule_tenant | Tenant Purge removes tenant-owned schedule rows; no meaning after tenant deletion. | Owner | 2026-01-26 |
| tenant_blackouts.tenant_id → tenants.id | tenant_blackouts_tenant_id_fkey | Tenant Purge removes blackout records; prevents orphan scheduling rules after tenant deletion. | Owner | 2026-01-26 |
| tenant_entitlements.tenant_id → tenants.id | tenant_entitlements_tenant_id_fkey | Tenant Purge removes tenant entitlement rows; prevents orphan feature access records after tenant deletion. | Owner | 2026-01-26 |
| tenant_hours.tenant_id → tenants.id | tenant_hours_tenant_id_fkey | Tenant Purge removes tenant hours ledger/config rows; prevents orphan usage data after tenant deletion. | Owner | 2026-01-26 |
| tenant_invites.tenant_id → tenants.id | tenant_invites_tenant_id_fkey | Tenant Purge removes invites; prevents orphan access invites after tenant deletion. | Owner | 2026-01-26 |
| tenant_invoices.tenant_id → tenants.id | tenant_invoices_tenant_id_fkey | Tenant Purge removes tenant billing documents as part of complete tenant data removal (subject to retention policy). | Owner | 2026-01-26 |
| tenant_payments.tenant_id → tenants.id | tenant_payments_tenant_id_fkey | Tenant Purge removes tenant payment records as part of complete tenant data removal (subject to retention policy). | Owner | 2026-01-26 |
| tenant_subscriptions.tenant_id → tenants.id | tenant_subscriptions_tenant_id_fkey | Tenant Purge removes subscription records tied to the deleted tenant; prevents orphan subscription rows. | Owner | 2026-01-26 |
| tenant_users.tenant_id → tenants.id | tenant_users_tenant_id_fkey | Tenant Purge removes tenant-user mappings because the tenant no longer exists. | Owner | 2026-01-26 |
| resource_service_links.tenant_id → tenants.id | resource_service_links_tenant_id_fkey | Tenant Purge must fully remove tenant-owned link rows. | Owner | 2026-02-01 |
| staff_resource_links.tenant_id → tenants.id | staff_resource_links_tenant_id_fkey | Tenant Purge must fully remove tenant-owned link rows. | Owner | 2026-02-01 |
| staff_service_links.tenant_id → tenants.id | staff_service_links_tenant_id_fkey | Tenant Purge must fully remove tenant-owned link rows. | Owner | 2026-02-01 |

---

### ❌ Not approved under soft delete (change required)
This CASCADE conflicts with soft delete + auditability and should be changed to RESTRICT.

| CASCADE FK (local → referenced) | Constraint | Required change | Why |
|---|---|---|---|
| tenant_users.user_id → users.id | tenant_users_user_id_fkey | **ON DELETE RESTRICT** | Users are soft-deleted; mappings should remain for audit/history and controlled deactivation. |

## Approved Exceptions — CASCADE Foreign Keys (Auto-generated)

**Source snapshot:** `docs/db/generated/fk_inventory_2026-02-01.csv`  
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
