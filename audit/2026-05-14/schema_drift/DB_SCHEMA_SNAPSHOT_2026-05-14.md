# DB_SCHEMA_SNAPSHOT — 2026-05-14

Generated read-only against prod Render PG by
`audit/2026-05-14/schema_drift/probe.js`.

> **Note on tooling:** the brief's `scripts/build_snapshot.py` does not exist in
> this repo (no Python scripts present). This snapshot was produced from
> `information_schema` queries via the read-only `probe.js` Node script instead.
> It is a table/column-count inventory, not a full column-level DDL dump.
>
> **No prior `DB_SCHEMA_SNAPSHOT.md` was available locally** for a structural
> diff (the 2026-05-14 audit INDEX.md confirms this). Deltas below are stated
> relative to the brief's quoted figures from the 2026-05-03 snapshot.

## Top-line

| Metric                          | Value     | vs. 2026-05-03 baseline |
|---------------------------------|-----------|--------------------------|
| `tenants` row count             | **26**    | 23 → 26 (+3 tenants)     |
| Base tables (`public` schema)   | **72**    | not quoted in baseline   |
| `schema_migrations` rows        | **67**    | 51 → 67 (+16, the 053-070 batch) |
| Migration files in repo         | 69        | —                        |
| Migrations not applied          | 2 (052, 055) | —                     |

## `schema_migrations` state

67 rows. Every numbered migration file 001-070 is recorded **except 052 and
055** (deliberate skips) and **060** (numbering gap, no file). Last applied
batch: 053-070 on 2026-05-10 20:50. See `applied_migrations.txt` for the full
list and `diff_table.md` for the classification.

## Base tables (72) — name + column count

| Table | Cols | | Table | Cols |
|---|---:|---|---|---:|
| `_twilio_creds_backup_2026` ⚠️ | 7 | | `rate_rules` | 25 |
| `audit_log` | 12 | | `rental_payment_links` | 22 |
| `bookings` | 63 | | `resource_addons` | 13 |
| `class_session_seats` | 16 | | `resource_amenities` | 9 |
| `class_session_waitlist` | 12 | | `resource_gallery` | 15 |
| `class_sessions` | 14 | | `resource_service_links` | 4 |
| `contract_invoice_payment_links` | 13 | | `resources` | 18 |
| `contract_invoices` | 26 | | `role_permissions` | 3 |
| `contracts` | 32 | | `roles` | 5 |
| `customer_memberships` | 17 | | `saas_plan_features` | 8 |
| `customer_prepaid_entitlements` | 17 | | `saas_plans` | 20 |
| `customers` | 10 | | `schema_migrations` | 3 |
| `dsr_requests` | 9 | | `service_categories` | 10 |
| `email_log` | 10 | | `service_closed_days` | 5 |
| `instructors` | 13 | | `service_hours` | 8 |
| `lease_renewal_reminders` | 10 | | `service_sessions` | 11 |
| `maintenance_tickets` | 17 | | `service_unavailability` | 8 |
| `media_asset_links` | 10 | | `services` | 37 |
| `media_assets` | 18 | | `staff` | 17 |
| `membership_ledger` | 9 | | `staff_resource_links` | 4 |
| `membership_plans` | 15 | | `staff_schedule_overrides` | 11 |
| `network_payments` | 17 | | `staff_service_links` | 4 |
| `payment_link_reminders` | 9 | | `staff_weekly_schedule` | 12 |
| `payment_schedule_templates` | 13 | | `tenant_blackouts` | 11 |
| `permissions` | 4 | | `tenant_domains` | 9 |
| `platform_layouts` | 8 | | `tenant_entitlements` | 8 |
| `platform_plans` | 6 | | `tenant_hours` | 6 |
| `platform_shells` | 6 | | `tenant_invites` | 14 |
| `platform_themes` | 9 | | `tenant_invoice_lines` | 7 |
| `prepaid_products` | 22 | | `tenant_invoices` | 19 |
| `prepaid_redemptions` | 11 | | `tenant_payments` | 11 |
| `prepaid_sales` | 12 | | `tenant_subscriptions` | 18 |
| `prepaid_transactions` | 13 | | `tenant_theme_schema_changelog` | 6 |
| | | | `tenant_user_permission_overrides` | 7 |
| | | | `tenant_user_roles` | 5 |
| | | | `tenant_users` | 7 |
| | | | `tenant_working_hours` | 7 |
| | | | `tenants` | **99** |
| | | | `users` | 7 |

⚠️ `_twilio_creds_backup_2026` — ad-hoc backup table, not created by any
migration. Out-of-band; harmless but untracked.

## THEMES-V2 catalog contents (migrations 069 + 070)

**`platform_themes`** (6 rows, all `is_published = true`):
`boutique-beauty`, `default_v1`, `minimal`, `premium_light`, `premium_v1`,
`premium_v2`. Orphan `premuim_light_v2` confirmed deleted.

**`platform_shells`** (4 rows): `classic`, `minimal`, `modern`, `premium`.

**`platform_layouts`** (1 row): `legacy_default`.

## Notable column counts

- `tenants` — **99 columns**. Consistent with migrations 052 (8 cols) and
  055 (4 cols) **not** being applied; if applied it would be 111.
- `bookings` — **63 columns**. Consistent with 055's 2 booking stamp columns
  **not** being applied.

## Structural deltas vs. baseline

Cannot produce a precise structural diff — no prior snapshot file was available
locally. Known changes since the 2026-05-03 snapshot, from migration history:

- **+16 migrations applied** (053-070 batch, 2026-05-10): adds `email_log`
  table, `class_sessions`/`instructors`/etc. were already in by 051, voice
  prompt snapshot column, themes-v2 tables (`platform_themes`,
  `platform_shells`, `platform_layouts`), payment-status columns, etc.
- **+3 tenants** (23 → 26).
- Migrations **052 and 055 remain unapplied** — their columns are absent.
