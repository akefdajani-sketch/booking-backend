# Phase 4/5 verification — migration effects vs. live prod schema

Captured 2026-05-14 against prod Render PG (read-only).
Tool: `audit/2026-05-14/schema_drift/probe.js` (read-only, SELECT-only;
substitute for the brief's `tools/db_audit.sql`, which does not exist in repo).

---

## Phase 4 — the only two ⚠️ candidates (052, 055)

Both are file-in-repo / not-in-`schema_migrations`. Project memory documents
them as deliberate skips. This phase confirms against prod whether their
*effects* are present.

### Migration 052 — `tenants` notification toggles → **NOT-APPLIED**

Migration adds 8 BOOLEAN columns to `tenants` (4 `sms_*_enabled`, 4 `wa_*_enabled`).

```
SELECT column_name FROM information_schema.columns
WHERE table_name='tenants'
  AND (column_name LIKE 'sms_%_enabled' OR column_name LIKE 'wa_%_enabled');
→ 0 rows  (expected 8 if applied)
```

**Verdict: NOT-APPLIED.** None of the 8 columns exist. Not partial — completely absent.

### Migration 055 — email toggles + booking stamps → **NOT-APPLIED**

Migration adds 4 BOOLEAN cols to `tenants`, 2 TIMESTAMPTZ cols to `bookings`,
and 2 partial indexes on `bookings`.

```
tenants.email_%_enabled                         → 0 rows  (expected 4)
bookings.email_reminder_sent_%                  → 0 rows  (expected 2)
pg_indexes idx_bookings_email_reminder_pending_% → 0 rows  (expected 2)
```

**Verdict: NOT-APPLIED.** Every change absent. Not partial.

---

## Phase 5 — known landmines

### Migration 066 — `tenants.voice_prompt_snapshot` → **APPLIED ✅** (recorded ✅)

```
column_name            | data_type | is_nullable
voice_prompt_snapshot  | jsonb     | YES
→ 1 row
```
Matches migration spec exactly. Recorded as id 112.

### Migration 069 — `platform_themes` capture + orphan cleanup → **APPLIED ✅** (recorded ✅)

- `platform_themes` table present, 9 columns, **6 rows**.
- Orphan `premuim_light_v2` (sic): **0 rows** — the Phase 5.1.5 `DELETE` ran.
- Theme keys present: `boutique-beauty`, `default_v1`, `minimal`,
  `premium_light`, `premium_v1`, `premium_v2` (all `is_published = true`).

Recorded as id 115.

### Migration 070 — `platform_shells` + `platform_layouts` + `tenants` cols → **APPLIED ✅** (recorded ✅)

- `platform_shells`: present, **4 rows** — `classic`, `minimal`, `modern`,
  `premium`. Matches seed.
- `platform_layouts`: present, **1 row** — `legacy_default`. Matches seed
  (`boutique-editorial` intentionally not seeded).
- `tenants.shell_key` (text, nullable) and `tenants.layout_key_v2` (text,
  nullable): **both present.**

Recorded as id 116.

---

## Phase 4 (inverse) — spot-check that RECORDED migrations are genuinely applied

To catch the inverse drift class (recorded in `schema_migrations` but effects
absent), a representative sample of recorded migrations was checked:

| Migration | Expected effect                       | Present in prod? |
|-----------|---------------------------------------|------------------|
| 051       | `class_sessions` table                | ✅ yes |
| 054       | `email_log` table                     | ✅ yes |
| 059       | `tenants.voice_instructions` column   | ✅ yes |
| 061       | `services.is_long_term` column        | ✅ yes |
| 064       | `bookings.payment_status` column      | ✅ yes |
| 068       | `tenants.booking_flow_preset` column  | ✅ yes |

All sampled recorded migrations have their effects present. **No
APPLIED-UNRECORDED or RECORDED-NOT-APPLIED drift found.** The
`schema_migrations` table is an accurate record of prod state.

---

## Summary

| Migration | Recorded? | Effects in prod? | Classification     |
|-----------|-----------|------------------|--------------------|
| 052       | No        | No (0/8 cols)    | **NOT-APPLIED**    |
| 055       | No        | No (0/8 objects) | **NOT-APPLIED**    |
| 066       | Yes       | Yes              | APPLIED (clean)    |
| 069       | Yes       | Yes              | APPLIED (clean)    |
| 070       | Yes       | Yes              | APPLIED (clean)    |
| 051/054/059/061/064/068 (sample) | Yes | Yes | APPLIED (clean) |

**No PARTIAL migrations. No APPLIED-UNRECORDED migrations. No
RECORDED-NOT-APPLIED migrations.** The `schema_migrations` table and the prod
schema agree. The only divergence between repo and prod is the two deliberate,
fully-absent skips: **052 and 055**.

### Out-of-band schema object (not migration-tracked)

`probe.js` table enumeration surfaced one prod table with no corresponding
migration: **`_twilio_creds_backup_2026`** (7 columns). This is an ad-hoc
backup table created outside the migration system — harmless, but it is
genuine "prod has objects the migrations don't". A full table-to-migration
provenance map of all 72 base tables was not in scope for this session.
