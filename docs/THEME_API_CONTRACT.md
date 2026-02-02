# THEME_API_CONTRACT.md
_Last updated: 2026-02-02_

This document defines the current and target API contract for tenant appearance payloads.

---

## 1) Current public endpoint
`GET /api/public/tenant-theme/:slug`

Source: `routes/publicTenantTheme.js`

Returns:
- tenant: id, slug, logo_url, banners, brand_overrides, branding (effective)
- theme: key, layout_key, tokens

Notes:
- uses Cache-Control (max-age=60, stale-while-revalidate=300)
- uses tenant `publish_status` + `branding_published` fallback rules

---

## 2) Target endpoint naming (Phase 1+)
We will introduce a dedicated “appearance” payload:
`GET /api/public/tenant-appearance/:slug`

The public booking UI should migrate to this endpoint once the DB contract is ready.

---

## 3) Owner/admin preview (Phase 1+)
Preview endpoint returns draft + published snapshots and metadata:
- draft JSON
- published JSON
- version + updated_at
- allowlist schema version
