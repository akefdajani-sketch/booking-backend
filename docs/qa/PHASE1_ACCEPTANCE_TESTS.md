# Phase 1 Acceptance Tests (DB + Backend Contract)

## 0) Preconditions
- You have applied the DB migration:
  - `migrations/20260202_phase1_appearance_contract.sql`
- Backend deployed or running locally

## 1) DB verification
Run:

```sql
\d+ tenants;
\d+ tenant_theme_schema_changelog;
```

Confirm:
- tenants has branding/theme_schema columns
- changelog table exists

## 2) Admin Read: canonical appearance
Request:

```
GET /api/admin/tenants/:tenantId/appearance
```

Expected:
- returns `theme_key`
- returns `branding` object with `draft/published`
- returns `theme_schema` object with `draft/published`

## 3) Branding draft/publish/rollback

### Save branding draft

```
POST /api/admin/tenants/:tenantId/branding/save-draft
{ "branding": { "primaryColor": "#111111" } }
```

Expected:
- `branding` updated
- `branding_draft_saved_at` set
- changelog action `BRANDING_SAVE_DRAFT`

### Publish branding

```
POST /api/admin/tenants/:tenantId/branding/publish
```

Expected:
- `branding_published` matches current `branding`
- `publish_status` set to `published`
- `branding_published_at` set
- changelog action `BRANDING_PUBLISH`

### Rollback branding

```
POST /api/admin/tenants/:tenantId/branding/rollback
```

Expected:
- `branding` overwritten with `branding_published`
- changelog action `BRANDING_ROLLBACK`

## 4) Theme schema draft/publish/rollback

### Save theme schema draft

```
POST /api/admin/tenants/:tenantId/theme-schema/save-draft
{ "schema": { "layout": { "home": "brand_first" } } }
```

Expected:
- `theme_schema_draft_json` set
- changelog action `THEME_SCHEMA_SAVE_DRAFT`

### Publish theme schema

```
POST /api/admin/tenants/:tenantId/theme-schema/publish
```

Expected:
- `theme_schema_published_json` matches draft
- changelog action `THEME_SCHEMA_PUBLISH`

### Rollback theme schema

```
POST /api/admin/tenants/:tenantId/theme-schema/rollback
```

Expected:
- `theme_schema_draft_json` overwritten with published
- changelog action `THEME_SCHEMA_ROLLBACK`

## 5) Public endpoint must return published only

```
GET /api/public/tenant-theme/:slug
```

Expected:
- `tenant.branding` uses published snapshot if tenant is published
- `tenant.theme_schema` equals `theme_schema_published_json` (or null)
- No draft values leaked

## 6) Theme key selection

```
POST /api/admin/tenants/:tenantId/theme-key
{ "theme_key": "premium_v1" }
```

Expected:
- rejects unknown or unpublished theme keys
- changelog action `THEME_KEY_SET`
