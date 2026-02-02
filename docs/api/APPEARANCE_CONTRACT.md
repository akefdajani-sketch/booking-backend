# Appearance Contract (Phase 1)

This document defines the **canonical backend contract** for tenant appearance, used by:

- **Theme Studio / Appearance & Brand** in the Tenant Dashboard
- **Public booking pages** (`/book/[slug]`) — *published values only*

## Goals

- Single source of truth for **theme selection**, **branding**, and **theme schema**
- Support **draft → publish → rollback** workflows
- Prevent frontend guesswork (no “UI hardcoded fallbacks” beyond safe defaults)
- Keep **multi-tenant isolation** strict

---

## Public endpoint (published-only)

### `GET /api/public/tenant-theme/:slug`

Returns:
- tenant branding **effective published** (falls back to draft if not published)
- tenant **published theme schema** (or `null` if none)
- platform theme tokens + default layout key

**Important:** Draft theme schema is never served publicly.

Payload (high-level):

```json
{
  "tenant": {
    "id": 123,
    "slug": "acme",
    "branding": {},
    "theme_schema": {},
    "brand_overrides": {},
    "banners": { "home": "", "book": "", "account": "", "reservations": "" }
  },
  "theme": {
    "key": "premium_v1",
    "layout_key": "classic",
    "tokens": {}
  }
}
```

---

## Admin endpoints (draft-aware)

All admin endpoints require `requireAdmin` and are mounted under:

- `/api/admin/tenants/*`

### `GET /api/admin/tenants/:tenantId/appearance`
Canonical read for Theme Studio:

Returns:
- `theme_key`
- `branding` (`draft`, `published`, timestamps)
- `theme_schema` (`draft`, `published`, timestamps)
- minimal tenant identity (id/slug/name)

### Theme selection

- `POST /api/admin/tenants/:tenantId/theme-key`

Body:
```json
{ "theme_key": "premium_v1" }
```

Validates that `platform_themes.key` exists and is `is_published = true`.

### Theme schema

- `GET /api/admin/tenants/:tenantId/theme-schema`
- `POST /api/admin/tenants/:tenantId/theme-schema/save-draft`
- `POST /api/admin/tenants/:tenantId/theme-schema/publish`
- `POST /api/admin/tenants/:tenantId/theme-schema/rollback`
- `GET /api/admin/tenants/:tenantId/theme-schema/changelog`

### Branding

- `GET /api/admin/tenants/:tenantId/branding`
- `POST /api/admin/tenants/:tenantId/branding/save-draft`
- `POST /api/admin/tenants/:tenantId/branding/publish`
- `POST /api/admin/tenants/:tenantId/branding/rollback`

---

## Changelog / audit

Table: `tenant_theme_schema_changelog`

Actions written by the backend include:
- `THEME_SCHEMA_SAVE_DRAFT`
- `THEME_SCHEMA_PUBLISH`
- `THEME_SCHEMA_ROLLBACK`
- `BRANDING_SAVE_DRAFT`
- `BRANDING_PUBLISH`
- `BRANDING_ROLLBACK`
- `THEME_KEY_SET`

Actor is taken from the header:
- `x-admin-actor`

---

## Security and tenancy

- All writes are scoped to `tenantId` and require admin.
- Public endpoint is read-only and scoped by `slug`.
- No public endpoint exposes drafts.
