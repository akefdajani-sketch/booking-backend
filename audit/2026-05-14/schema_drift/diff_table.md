# Migration diff table — repo files vs `schema_migrations` (prod)

Captured 2026-05-14. Source: `migrate.js --list` + direct `schema_migrations`
query + `probe.js` schema verification.

**Legend**
- ✅ **Applied** — file in repo, recorded in `schema_migrations`
- 🔴 **Deliberately not applied** — file in repo, NOT recorded, project memory documents the skip; effects **verified absent** in prod
- ⬜ **Numbering gap** — no file in repo
- ⚠️ **Missing record** — file in repo, NOT recorded, status unknown *(none found)*
- ❓ **Recorded but file missing** — recorded, no file in repo *(none found)*

| #   | Filename                                          | In `schema_migrations`? | Applied at            | Classification |
|-----|---------------------------------------------------|-------------------------|-----------------------|----------------|
| 001 | 001_core_tables.sql                               | Y (id 1)                | 2026-04-23 15:34      | ✅ Applied |
| 002 | 002_rbac_links_memberships.sql                    | Y (id 2)                | 2026-04-23 15:34      | ✅ Applied |
| 003 | 003_saas_billing_booking_columns.sql              | Y (id 3)                | 2026-04-23 15:34      | ✅ Applied |
| 004 | 004_stripe_customer_id.sql                        | Y (id 4)                | 2026-04-23 15:34      | ✅ Applied |
| 005 | 005_soft_delete.sql                               | Y (id 5)                | 2026-04-23 15:34      | ✅ Applied |
| 006 | 006_patch_invoice_columns.sql                     | Y (id 6)                | 2026-04-23 15:34      | ✅ Applied |
| 007 | 007_bookings_soft_delete.sql                      | Y (id 7)                | 2026-04-23 15:34      | ✅ Applied |
| 008 | 008_service_hours.sql                             | Y (id 8)                | 2026-04-23 15:34      | ✅ Applied |
| 009 | 009_service_hours_overnight.sql                   | Y (id 9)                | 2026-04-23 15:34      | ✅ Applied |
| 010 | 010_service_min_slots.sql                         | Y (id 10)               | 2026-04-23 15:34      | ✅ Applied |
| 011 | 011_add_tenant_appearance_snapshot.sql            | Y (id 11)               | 2026-04-23 15:34      | ✅ Applied |
| 012 | 012_drop_booking_range_exclude.sql                | Y (id 12)               | 2026-04-23 15:34      | ✅ Applied |
| 013 | 013_seed_premium_v2.sql                           | Y (id 13)               | 2026-04-23 15:34      | ✅ Applied |
| 014 | 014_service_categories.sql                        | Y (id 14)               | 2026-04-23 15:34      | ✅ Applied |
| 015 | 015_media_library.sql                             | Y (id 15)               | 2026-04-23 15:34      | ✅ Applied |
| 016 | 016_service_closed_days.sql                       | Y (id 16)               | 2026-04-23 15:34      | ✅ Applied |
| 017 | 017_network_payments.sql                          | Y (id 17)               | 2026-04-23 15:34      | ✅ Applied |
| 018 | 018_tenant_payment_credentials.sql                | Y (id 18)               | 2026-04-23 15:34      | ✅ Applied |
| 019 | 019_payment_methods.sql                           | Y (id 19)               | 2026-04-23 15:34      | ✅ Applied |
| 020 | 020_staff_profile_fields.sql                      | Y (id 20)               | 2026-04-23 15:34      | ✅ Applied |
| 021 | 021_rate_rules_membership_package.sql             | Y (id 21)               | 2026-04-23 15:34      | ✅ Applied |
| 022 | 022_rate_rules_any_flags.sql                      | Y (id 22)               | 2026-04-23 15:34      | ✅ Applied |
| 023 | 023_property_rental_and_gallery.sql               | Y (id 23)               | 2026-04-23 15:34      | ✅ Applied |
| 024 | 024_nightly_rental_suite.sql                      | Y (id 24)               | 2026-04-23 15:34      | ✅ Applied |
| 025 | 025_publish_history.sql                           | Y (id 25)               | 2026-04-23 15:34      | ✅ Applied |
| 026 | 026_booking_code_system.sql                       | Y (id 26)               | 2026-04-23 15:34      | ✅ Applied |
| 027 | 027_rental_unit_management.sql                    | Y (id 27)               | 2026-04-23 15:34      | ✅ Applied |
| 028 | 028_rental_payment_links.sql                      | Y (id 28)               | 2026-04-23 15:34      | ✅ Applied |
| 029 | 029_tenant_whatsapp_credentials.sql               | Y (id 29)               | 2026-04-23 15:34      | ✅ Applied |
| 030 | 030_payment_link_reminders.sql                    | Y (id 30)               | 2026-04-23 15:34      | ✅ Applied |
| 031 | 031_tax_service_charge.sql                        | Y (id 31)               | 2026-04-23 15:34      | ✅ Applied |
| 032 | 032_maintenance_tickets.sql                       | Y (id 32)               | 2026-04-23 15:34      | ✅ Applied |
| 033 | 033_lease_renewal_contracts.sql                   | Y (id 33)               | 2026-04-23 15:34      | ✅ Applied |
| 034 | 034_customer_avatar.sql                           | Y (id 34)               | 2026-04-23 15:34      | ✅ Applied |
| 035 | 035_tenant_domains_verification.sql               | Y (id 35)               | 2026-04-23 15:34      | ✅ Applied |
| 036 | 036_tenant_twilio_credentials.sql                 | Y (id 36)               | 2026-04-23 15:34      | ✅ Applied |
| 037 | 037_dashboard_performance_indexes.sql             | Y (id 37)               | 2026-04-23 15:34      | ✅ Applied |
| 038 | 038_demo_tenant_flag.sql                          | Y (id 38)               | 2026-04-23 15:34      | ✅ Applied |
| 039 | 039_saas_plans_stripe_and_display.sql             | Y (id 39)               | 2026-04-23 15:34      | ✅ Applied |
| 040 | 040_seed_saas_plans_and_features.sql              | Y (id 40)               | 2026-04-23 15:34      | ✅ Applied |
| 041 | 041_grandfather_tenant_subscriptions.sql          | Y (id 41)               | 2026-04-23 15:34      | ✅ Applied |
| 042 | 042_booking_reminder_columns.sql                  | Y (id 42)               | 2026-04-23 15:34      | ✅ Applied |
| 043 | 043_whatsapp_reminder_columns.sql                 | Y (id 43)               | 2026-04-23 15:34      | ✅ Applied |
| 044 | 044_payment_schedule_templates.sql                | Y (id 44)               | 2026-04-23 15:36      | ✅ Applied |
| 045 | 045_contracts.sql                                 | Y (id 45)               | 2026-04-23 15:36      | ✅ Applied |
| 046 | 046_contract_invoices.sql                         | Y (id 46)               | 2026-04-23 15:36      | ✅ Applied |
| 047 | 047_bookings_contract_link.sql                    | Y (id 47)               | 2026-04-23 15:36      | ✅ Applied |
| 048 | 048_seed_platform_payment_templates.sql           | Y (id 48)               | 2026-04-23 15:36      | ✅ Applied |
| 049 | 049_tenants_contract_columns.sql                  | Y (id 49)               | 2026-04-23 15:36      | ✅ Applied |
| 050 | 050_contract_invoice_reminders_and_renewal.sql    | Y (id 99)               | 2026-04-26 00:15      | ✅ Applied |
| 051 | 051_classes_g1.sql                                | Y (id 100)              | 2026-04-26 00:15      | ✅ Applied |
| 052 | 052_tenant_notification_toggles.sql               | **N**                   | —                     | 🔴 **Deliberately not applied — verified NOT-APPLIED** |
| 053 | 053_trial_warning_timestamp.sql                   | Y (id 101)              | 2026-05-10 20:50      | ✅ Applied |
| 054 | 054_email_log.sql                                 | Y (id 102)              | 2026-05-10 20:50      | ✅ Applied |
| 055 | 055_customer_booking_emails.sql                   | **N**                   | —                     | 🔴 **Deliberately not applied — verified NOT-APPLIED** |
| 056 | 056_contract_schedule_fix.sql                     | Y (id 103)              | 2026-05-10 20:50      | ✅ Applied |
| 057 | 057_contract_invoice_payment_links.sql            | Y (id 104)              | 2026-05-10 20:50      | ✅ Applied |
| 058 | 058_contract_invoice_reminder_windows.sql         | Y (id 105)              | 2026-05-10 20:50      | ✅ Applied |
| 059 | 059_tenant_voice_instructions.sql                 | Y (id 106)              | 2026-05-10 20:50      | ✅ Applied |
| 060 | *(no file)*                                       | N                       | —                     | ⬜ Numbering gap |
| 061 | 061_services_is_long_term.sql                     | Y (id 107)              | 2026-05-10 20:50      | ✅ Applied |
| 062 | 062_bookings_payment_method_check.sql             | Y (id 108)              | 2026-05-10 20:50      | ✅ Applied |
| 063 | 063_backfill_payment_method.sql                   | Y (id 109)              | 2026-05-10 20:50      | ✅ Applied |
| 064 | 064_payment_status.sql                            | Y (id 110)              | 2026-05-10 20:50      | ✅ Applied |
| 065 | 065_schema_cleanup.sql                            | Y (id 111)              | 2026-05-10 20:50      | ✅ Applied |
| 066 | 066_tenants_voice_prompt_snapshot.sql             | Y (id 112)              | 2026-05-10 20:50      | ✅ Applied |
| 067 | 067_themes_v2_tenant_theme_key_constraint.sql     | Y (id 113)              | 2026-05-10 20:50      | ✅ Applied |
| 068 | 068_themes_v2_booking_flow_preset.sql             | Y (id 114)              | 2026-05-10 20:50      | ✅ Applied |
| 069 | 069_themes_v2_platform_themes_capture.sql         | Y (id 115)              | 2026-05-10 20:50      | ✅ Applied |
| 070 | 070_themes_v2_shells_layouts.sql                  | Y (id 116)              | 2026-05-10 20:50      | ✅ Applied |

## Tally

| Classification                          | Count |
|-----------------------------------------|-------|
| ✅ Applied                              | 67    |
| 🔴 Deliberately not applied (verified)  | 2     |
| ⬜ Numbering gap                        | 1     |
| ⚠️ Missing record (unknown)             | 0     |
| ❓ Recorded but file missing            | 0     |
| **Repo files total**                    | **69** |
| **`schema_migrations` rows total**       | **67** |

## The brief's premise vs. reality

The brief expected "~13 unaccounted-for migrations" based on a 2026-05-03
snapshot showing 51 `schema_migrations` rows against 69 files (delta 18).

**That delta is fully explained and there is no mystery drift:**

- The 2026-05-03 snapshot's 51 rows = migrations 001-051 (every numbered file
  ≤ 051, all applied by 2026-04-26).
- On **2026-05-10 20:50** a 16-migration catch-up batch applied 053-070
  (everything between 052 and 070 except the 052/055 skips and the 060 gap).
- 51 + 16 = 67, the current row count.
- The remaining 2 of the "18 delta" are migrations **052 and 055** — the
  deliberate skips documented in project memory.

The audit's `✅ Migrations 052 / 055 reconcile` note was reconciled against
migration *files*; this session reconciled against *prod* and confirms 052 and
055 are genuinely **not applied** — see `verification.md`.
