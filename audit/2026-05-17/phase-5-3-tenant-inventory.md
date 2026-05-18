# Phase 5.3 — Tenant Inventory (Scoping)

> **Status:** SQL written; **results PENDING** — owner to run against prod
> and paste results back into this doc.
> Snapshot intent date: **2026-05-17**.
> Re-run before the implementation session lands (tenant set drifts).

## Purpose

The Phase 5.3 SectionRenderer refactor must produce **zero visual diff**
across 25 production tenants. To verify that, the diff harness (script 05
extension, see `phase-5-3-baseline-capture-extensions.md`) needs to know,
per tenant:

- which URL to fetch (slug-routed on flexrz.com vs custom-domain)
- what theme / shell / layout the backend reports for that tenant
- whether it's one of the three protected tenants (Birdie 3, Al-Razi 21,
  aqababooking 33)

This doc captures that table once and is the source of truth for the
harness invocation. The query is read-only; idempotent; safe to re-run.

## Source

- `routes/publicTenantTheme.js:24` — selects `shell_key`, `layout_key_v2`
  alongside the existing appearance fields.
- `migrations/070_themes_v2_shells_layouts.sql:109-111` — adds nullable
  `shell_key`, `layout_key_v2` columns to `tenants`.
- `migrations/070_themes_v2_shells_layouts.sql:113-117` — semantics:
  NULL = derive at read time.

The query below intentionally does NOT do shell derivation — it captures
raw column values so we can see which tenants have been migrated
explicitly vs which rely on the read-time fallback.

## Query

Run from the backend root with prod credentials:

```sql
-- Phase 5.3 tenant inventory — captures: identity, theme, shell/layout
-- selection, custom domain, publish state. Read-only; safe to run any time.
SELECT
  t.id                AS tenant_id,
  t.slug              AS slug,
  t.name              AS name,
  t.theme_key         AS theme_key,
  t.shell_key         AS shell_key,         -- NULL = derive from theme_key
  t.layout_key_v2     AS layout_key_v2,     -- NULL = use legacy_default
  td.domain           AS custom_domain,     -- NULL if none
  td.is_primary       AS custom_domain_is_primary,
  t.publish_status    AS publish_status,
  t.updated_at        AS tenant_updated_at,
  CASE
    WHEN t.id IN (3, 21, 33) THEN 'PROTECTED'
    ELSE 'standard'
  END                 AS protection_tier
FROM tenants t
LEFT JOIN tenant_domains td
  ON td.tenant_id = t.id AND td.is_primary = TRUE
WHERE t.publish_status = 'published'           -- exclude drafts
  AND COALESCE(t.is_deleted, FALSE) = FALSE    -- exclude tombstoned (if column exists)
ORDER BY
  CASE WHEN t.id IN (3, 21, 33) THEN 0 ELSE 1 END,
  t.id;
```

If `tenants.is_deleted` does not exist on this schema, drop that line —
no tombstone column has shipped as of migration 071.

If `tenant_domains` doesn't have an `is_primary` column on this schema,
fall back to `td.id = MIN(td.id) GROUP BY tenant_id` or pick the
lowest-id domain row. (Schema audit pending; coordinate with the
schema_drift report at `audit/2026-05-14/schema_drift/REPORT.md`.)

## How to run

Option A — `psql` direct (preferred):
```bash
psql "$DATABASE_URL" -f - <<'SQL'
-- paste the query above
SQL
```

Option B — node one-shot using existing `db.js`:
```bash
cd booking-backend
node -e "
require('dotenv').config();
const db = require('./db');
db.query(\`
SELECT t.id, t.slug, t.name, t.theme_key, t.shell_key, t.layout_key_v2,
       td.domain AS custom_domain, t.publish_status,
       CASE WHEN t.id IN (3,21,33) THEN 'PROTECTED' ELSE 'standard' END AS protection_tier
FROM tenants t
LEFT JOIN tenant_domains td ON td.tenant_id = t.id AND td.is_primary = TRUE
WHERE t.publish_status = 'published'
ORDER BY CASE WHEN t.id IN (3,21,33) THEN 0 ELSE 1 END, t.id;
\`).then(r => { console.table(r.rows); process.exit(0); }).catch(e => { console.error(e); process.exit(1); });
"
```

## Results

> **PENDING** — paste the result of the query into the table below before
> the implementation session.

Expected: ~25 rows (per the brief). The three protected rows appear first.

| tenant_id | slug | name | theme_key | shell_key | layout_key_v2 | custom_domain | publish_status | protection_tier |
|-----------|------|------|-----------|-----------|---------------|---------------|----------------|-----------------|
| 3 | `birdie-golf` | _Birdie Golf_ | | | | | `published` | **PROTECTED** |
| 21 | `alrazi` | _Al-Razi_ | | | | | `published` | **PROTECTED** |
| 33 | `aqababooking` | _aqababooking_ | | | | | `published` | **PROTECTED** |
| … | … | … | | | | | | standard |

Note from earlier audits (`audit/2026-05-14/schema_drift/` and the
themes_v2 Phase 5.2 verification logs): Birdie + aqababooking were
already verified at `shell.key=premium` (derived at read time from
`theme_key=premium_v2`). `shell_key` itself is expected to be NULL for
**every** tenant post-Phase-5.2 because Phase 5.2 explicitly did NOT
populate the new columns. Same for `layout_key_v2`. Re-confirm on
re-query.

## Baseline-capture URL per tenant

The diff harness (extended script 05) builds the target URL using this
priority:

1. If `custom_domain IS NOT NULL` and the row's `is_primary = TRUE`:
   - HTML target: `https://<custom_domain>/`
   - (Optional secondary capture: `https://<custom_domain>/book` — some
     tenants land directly on book.)
2. Else (slug-routed on flexrz.com):
   - HTML target: `https://flexrz.com/book/<slug>`
   - API target: `https://api.flexrz.com/api/public/tenant-theme/<slug>`
     (or backend's hosted URL — exact prod API base captured in
     `audit/2026-05-17/phase-2-4-rollout.md` if needed).

This is the input to `scripts/themes_v2/05_capture_render_baseline.js
--prod --custom-domains` (see extension doc).

## What this doc is NOT

- Not a published source for tenant counts. The 25-tenant figure comes
  from the user brief; the query may return more or fewer (drafts,
  recently added). Take the query output as truth.
- Not authoritative on custom-domain primacy. If multiple
  `tenant_domains` rows exist for a tenant and none has
  `is_primary = TRUE`, the harness must skip that tenant and surface a
  blocker — not pick arbitrarily.
- Not a migration plan. Phase 5.3 will NOT populate `shell_key` or
  `layout_key_v2` per-tenant; the SectionRenderer reads layout via the
  derivation path that already works (NULL → legacy_default).

## Cross-references

- `phase-5-3-section-inventory.md` — what BookTab actually renders and
  how it maps (or doesn't) to migration 070's 8 supported section types.
- `phase-5-3-patch-tracker.md` — every patch on the refactor target
  (BookTab.tsx) whose behavior the SectionRenderer must preserve.
- `phase-5-3-baseline-capture-extensions.md` — `--prod` /
  `--custom-domains` CLI flag additions to script 05.
- `phase-5-3-rollback-plan.md` — `tenants.use_section_renderer`
  feature-flag rollback mechanism.
