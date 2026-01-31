## CASCADE Review Verdict (Soft Delete Policy)

**Context:** BookFlow uses **soft delete** for business-critical entities (users, tenants, bookings, memberships, invoices).  
**Meaning:** `ON DELETE CASCADE` should be treated as **purge-only behavior**, not normal operations.

### ✅ KEEP (Dependent-child CASCADE is appropriate)
These are “child rows with no standalone business meaning.” If the parent is ever hard-deleted (rare), cleaning children is correct.

| CASCADE FK (local → referenced) | Constraint | Verdict reason |
|---|---|---|
| saas_plan_features.plan_id → saas_plans.id | saas_plan_features_plan_id_fkey | Dependent feature rows; safe dependent cleanup |
| staff_weekly_schedule.staff_id → staff.id | fk_staff_weekly_schedule_staff | Schedule rows are dependent on staff |
| service_unavailability.service_id → services.id | fk_service_unavailability_service | Unavailability rows are dependent on service |
| tenant_invoice_lines.invoice_id → tenant_invoices.id | tenant_invoice_lines_invoice_id_fkey | Line items are dependent on invoice |
| tenant_payments.invoice_id → tenant_invoices.id | tenant_payments_invoice_id_fkey | Payments are dependent on invoice record |
| resource_service_links.resource_id → resources.id | resource_service_links_resource_id_fkey | Join rows are dependent on resource |
| resource_service_links.service_id → services.id | resource_service_links_service_id_fkey | Join rows are dependent on service |
| staff_resource_links.resource_id → resources.id | staff_resource_links_resource_id_fkey | Join rows are dependent on resource |
| staff_resource_links.staff_id → staff.id | staff_resource_links_staff_id_fkey | Join rows are dependent on staff |
| staff_service_links.service_id → services.id | staff_service_links_service_id_fkey | Join rows are dependent on service |
| staff_service_links.staff_id → staff.id | staff_service_links_staff_id_fkey | Join rows are dependent on staff |

---

### ⚠️ KEEP ONLY IF “TENANT PURGE” EXISTS (Otherwise change to RESTRICT)
These are tenant-owned tables that cascade from `tenants.id`. Under soft delete, you normally **won’t hard-delete tenants**, so CASCADE is unnecessary and risky unless you have a controlled **Owner-only Tenant Purge** workflow.

| CASCADE FK (local → referenced) | Constraint | Verdict rule |
|---|---|---|
| customers.tenant_id → tenants.id | customers_tenant_id_fkey | Keep only if hard-delete tenant purge exists |
| membership_plans.tenant_id → tenants.id | membership_plans_tenant_id_fkey | Keep only if tenant purge exists |
| resources.tenant_id → tenants.id | resources_tenant_id_fkey | Keep only if tenant purge exists |
| services.tenant_id → tenants.id | services_tenant_id_fkey | Keep only if tenant purge exists |
| staff.tenant_id → tenants.id | staff_tenant_id_fkey | Keep only if tenant purge exists |
| service_unavailability.tenant_id → tenants.id | fk_service_unavailability_tenant | Keep only if tenant purge exists |
| staff_weekly_schedule.tenant_id → tenants.id | fk_staff_weekly_schedule_tenant | Keep only if tenant purge exists |
| tenant_blackouts.tenant_id → tenants.id | tenant_blackouts_tenant_id_fkey | Keep only if tenant purge exists |
| tenant_entitlements.tenant_id → tenants.id | tenant_entitlements_tenant_id_fkey | Keep only if tenant purge exists |
| tenant_hours.tenant_id → tenants.id | tenant_hours_tenant_id_fkey | Keep only if tenant purge exists |
| tenant_invites.tenant_id → tenants.id | tenant_invites_tenant_id_fkey | Keep only if tenant purge exists |
| tenant_invoices.tenant_id → tenants.id | tenant_invoices_tenant_id_fkey | Keep only if tenant purge exists (billing history risk) |
| tenant_payments.tenant_id → tenants.id | tenant_payments_tenant_id_fkey | Keep only if tenant purge exists (billing history risk) |
| tenant_subscriptions.tenant_id → tenants.id | tenant_subscriptions_tenant_id_fkey | Keep only if tenant purge exists (billing/audit history risk) |
| tenant_users.tenant_id → tenants.id | tenant_users_tenant_id_fkey | Keep only if tenant purge exists (audit history risk) |

**If you do NOT have Tenant Purge:** change all rows in this section to **ON DELETE RESTRICT**.
| resource_service_links.tenant_id → tenants.id | resource_service_links_tenant_id_fkey | Keep only if hard-delete tenant purge exists |
| staff_resource_links.tenant_id → tenants.id | staff_resource_links_tenant_id_fkey | Keep only if hard-delete tenant purge exists |
| staff_service_links.tenant_id → tenants.id | staff_service_links_tenant_id_fkey | Keep only if hard-delete tenant purge exists |

---

### ❌ CHANGE TO RESTRICT (Conflicts with soft delete + auditability)
These CASCADEs are risky under soft delete and can destroy audit trails if a parent is ever hard-deleted accidentally.

| CASCADE FK (local → referenced) | Constraint | Recommended change | Why |
|---|---|---|---|
| tenant_users.user_id → users.id | tenant_users_user_id_fkey | **RESTRICT** | A soft-deleted user should keep mappings for audit/history; hard-delete should be gated |

---

### Action summary (for PR-C documentation)
- ✅ Dependent-child CASCADEs: **Approved**
- ⚠️ Tenant-owned CASCADEs: **Approved only with Tenant Purge governance** (otherwise must change to RESTRICT)
- ❌ User mapping CASCADE: **Must change to RESTRICT** (soft delete + audit)

**Decision log fields to fill (required):**
- Owner/Approver:
- Approved date:
- Tenant Purge exists? (YES/NO):
- If YES: where is it documented? (link to doc/PR)
