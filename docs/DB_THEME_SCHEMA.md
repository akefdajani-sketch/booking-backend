# DB_THEME_SCHEMA.md
_Last updated: 2026-02-02_

Phase 0 doc: we do **not** assume the DB is exactly as intended yet.
This doc captures what we know from code and what we will confirm in Phase 1.

---

## 1) What we know exists (from backend code)
### Table: `tenants`
Referenced columns:
- `id`, `slug`
- `theme_key`
- `brand_overrides_json`
- `branding` (working copy)
- `branding_published` (snapshot)
- `publish_status`
- `banner_home_url`, `banner_book_url`, `banner_account_url`, `banner_reservations_url`
- `logo_url`

### Table: `platform_themes`
Referenced columns:
- `key`, `name`, `version`
- `is_published`
- `layout_key`
- `tokens_json`

---

## 2) What we must confirm before migrations (Phase 1)
To avoid guessing, we will confirm:
- exact column names + types
- existing constraints / indexes
- whether any tenant appearance table already exists
- whether runtime “ensureColumns()” has already modified production

---

## 3) Target schema direction (Phase 1)
Recommended: create `tenant_appearance` (or `tenant_theme_settings`) table for:
- draft/published snapshots
- per-tab layouts JSON
- bounded overrides JSON
- versioning
