# Phase 5.3 — Tenant Inventory (Scoping)

> **Status:** SQL captured against prod on **2026-05-18**. Results
> pasted below. Schema-drift caveats updated against actual prod
> schema (see "Schema-drift caveats" section).
> Snapshot intent date: **2026-05-17** (kept for audit-folder
> alignment; actual capture: 2026-05-18).
> Re-run before the implementation session lands (tenant set drifts).

## Purpose

The Phase 5.3 SectionRenderer refactor must produce **zero visual diff**
across 7 published tenants. To verify that, the diff harness (script 05
extension, see `phase-5-3-baseline-capture-extensions.md`) needs to know,
per tenant:

- which URL to fetch (slug-routed on flexrz.com vs custom-domain)
- what theme / shell / layout the backend reports for that tenant
- whether it's one of the three protected tenants (Birdie 3, Al-Razi 21,
  karamhomes 33)

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

**Schema-drift caveats (confirmed against prod 2026-05-18):**

- `tenants.is_deleted` — does **NOT** exist on prod. Drop the
  `AND COALESCE(t.is_deleted, FALSE) = FALSE` line when running. No
  tombstone column has shipped as of migration 071.
- `tenants.updated_at` — does **NOT** exist on prod (discovered
  2026-05-18). Drop the `t.updated_at AS tenant_updated_at` line when
  running. Not a standard tombstone-style column so easy to miss in
  audits — this caveat was not anticipated in the original draft.
- `tenant_domains.is_primary` — **CONFIRMED** to exist on prod
  (2026-05-18). The LEFT JOIN as written works as-is; no fallback
  needed. Earlier draft flagged this as "potentially missing" — now
  resolved.

Coordinate with the schema_drift report at
`audit/2026-05-14/schema_drift/REPORT.md` if new drifts surface.

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

Captured against prod on **2026-05-18**: 7 published tenants. The
three protected rows (IDs 3 / 21 / 33) appear first.

| tenant_id | slug | name | theme_key | shell_key | layout_key_v2 | custom_domain | publish_status | protection_tier |
|-----------|------|------|-----------|-----------|---------------|---------------|----------------|-----------------|
| 3 | `birdie-golf` | _Birdie Golf_ | `premium-hospitality` | `null` | `null` | `birdiegolf-jo.com` | `published` | **PROTECTED** |
| 21 | `alrazi` | _Al Razi_ | `premium_v2` | `null` | `null` | `alrazi-jo.com` | `published` | **PROTECTED** |
| 33 | `karamhomes` | _Karam Homes_ | `premium_v1` | `null` | `null` | `null` | `published` | **PROTECTED** |
| 22 | `dingdong` | _Ding Dong_ | `premium_v1` | `null` | `null` | `null` | `published` | standard |
| 27 | `meesh` | _Meesh's App_ | `premium` | `null` | `null` | `null` | `published` | standard |
| 32 | `abz` | _ABZ_ | `minimal` | `null` | `null` | `null` | `published` | standard |
| 39 | `clinicx` | _Clinic X_ | `premium_light` | `null` | `null` | `null` | `published` | standard |

Findings from the 2026-05-18 capture:

- **Tenant ID 33 is now `karamhomes`** (was `aqababooking` in original
  scoping brief). Owner renamed the slug in the General-tab settings;
  same business, same `tenant_id`. The (3, 21, 33) protected-tenant
  contract is unchanged — slugs in docs are labels, `tenant_id` is the
  stable identifier.
- **`shell_key` and `layout_key_v2` are NULL for every tenant** —
  confirms Phase 5.2's explicit-non-population guarantee. Phase 5.3
  implementation will rely entirely on the read-time derivation path
  (`null → legacy_default`).
- **Theme-key distribution skews premium:** 6 of 7 tenants use a
  `premium*` variant; ABZ is the lone `minimal`. The themes break
  down as: premium-hospitality (Birdie), premium_v2 (Al-Razi),
  premium_v1 (karamhomes + Ding Dong), premium (Meesh), premium_light
  (Clinic X), minimal (ABZ).
- **Two tenants have primary custom domains:** Birdie
  (`birdiegolf-jo.com`) and Al-Razi (`alrazi-jo.com`). Script 05's
  `--custom-domains` flag fires for those 2; the other 5 capture via
  `https://flexrz.com/book/<slug>`.
- **Nightly-business tenant:** karamhomes (tenant 33). REDESIGN-1
  patch (hero relocation into the booking card) applies to this
  tenant. See `phase-5-3-patch-tracker.md` for the full REDESIGN-1
  context.

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

- Not a published source for tenant counts. The 7-tenant figure was
  confirmed against prod on 2026-05-18; the query may return more or
  fewer in future runs (drafts published, tenants added). Take the
  query output as truth.
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
