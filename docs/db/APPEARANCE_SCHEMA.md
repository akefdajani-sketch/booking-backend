# Appearance DB Schema (Phase 1)

This schema supports the **Appearance & Brand** workflow:

- Theme selection (`tenants.theme_key`)
- Branding draft/published
- Theme schema draft/published
- Audit trail of changes

## Migration

Run the SQL migration:

- `migrations/20260202_phase1_appearance_contract.sql`

### Recommended execution (DBeaver)
1. Open the file in DBeaver
2. Execute in your target database (staging first)
3. Verify tables/columns exist

## Tables

### `tenants`
Required columns (some may already exist in your DB):

- `theme_key` (text)
- `branding` (jsonb)
- `branding_published` (jsonb)
- `publish_status` (text)
- `branding_draft_saved_at` (timestamp)
- `branding_published_at` (timestamp)
- `theme_schema_draft_json` (jsonb)
- `theme_schema_published_json` (jsonb)
- `theme_schema_draft_saved_at` (timestamp)
- `theme_schema_published_at` (timestamp)

### `tenant_theme_schema_changelog`
Audit table used by both branding and theme-schema actions.

Columns:
- `tenant_id` (int)
- `action` (text)
- `actor` (text)
- `metadata` (jsonb)
- `created_at` (timestamp)

Indexes:
- `(tenant_id, created_at desc)`
- `(tenant_id, action, created_at desc)`

## Notes

- This repo previously ensured some columns at runtime. Phase 1 formalizes the schema with migrations.
- The runtime guards remain as fallback to avoid breaking older environments.
