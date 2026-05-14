# Schema-Drift Triage — Report
**Date:** 2026-05-14
**Scope:** `booking-backend` prod Render PG, read-only.
**Artifacts:** this file + `applied_migrations.txt`, `migration_files.txt`,
`diff_table.md`, `verification.md`, `DB_SCHEMA_SNAPSHOT_2026-05-14.md`, `probe.js`.

---

## 0. Tooling note (read this first)

The brief named three tools. Reality:

| Brief said | Status |
|---|---|
| `tools/db_audit.sql` | **Does not exist.** Only `tools/payment_method_audit.sql` is present. |
| `scripts/build_snapshot.py` | **Does not exist.** There are no Python scripts in the repo. |
| `scripts/migrate.js --dry` | Exists. Flags are `--list` / `--dry-run` (not `--dry`). |

Substitute used: a purpose-built **read-only, SELECT-only** probe at
`audit/2026-05-14/schema_drift/probe.js`, modeled on the existing
`scripts/probe_schema.js` and the documented "dev against prod" workflow. No
DDL, no DML, no writes, `schema_migrations` untouched. Connectivity is via the
`.env` `DATABASE_URL` (prod) loaded by `dotenv`, run with `DATABASE_SSL=true` —
the shell env vars the brief expected were not set, but the repo's own scripts
all load `.env`, so this matched the established pattern.

---

## 1. Executive summary

**The brief's premise — "~13 migrations unaccounted for" — does not hold.**
That number came from comparing a stale 2026-05-03 snapshot (51
`schema_migrations` rows) against 69 migration files. Since that snapshot, a
**16-migration catch-up batch (053-070) was applied on 2026-05-10 20:50**.
Current state:

- **69** migration files in repo (001-070, no 060).
- **67** rows in `schema_migrations`.
- **2** migrations not applied: **052** and **055** — verified absent from prod,
  matching the deliberate-skip note in project memory.
- **0** "missing record / status unknown" migrations.
- **0** "recorded but file missing" migrations.
- **0** partial migrations.
- **0** applied-unrecorded migrations (6 recorded migrations spot-checked
  against prod — all genuinely applied).

The `schema_migrations` table is an **accurate** record of prod. The only
real divergence between repo and prod is the two fully-absent skips.

| Bucket | Count |
|---|---|
| Applied (file + recorded + effects verified where checked) | 67 |
| Genuinely NOT applied (052, 055) | 2 |
| Applied-unrecorded | 0 |
| Recorded-not-applied | 0 |
| Partial | 0 |
| Numbering gap (060) | 1 |

---

## 2. Critical findings

**There is one real problem, and it is a code-vs-schema drift, not a
`schema_migrations` bookkeeping drift:**

> ### 🔴 The notification-toggle + customer-email feature code is deployed, but its schema (migrations 052 + 055) is not applied to prod.
>
> `utils/notificationGates.js`, `utils/emailReminderEngine.js`,
> `routes/tenantNotificationSettings.js`, and call sites in
> `routes/bookings/create.js` + `routes/bookings/crud.js` all reference columns
> that **do not exist in prod**:
> - `tenants.{sms,wa,email}_*_enabled` (12 columns — migrations 052 + 055)
> - `bookings.email_reminder_sent_{24h,1h}` (2 columns — migration 055)
>
> Effects in prod (see §4 for the full path-by-path breakdown):
> - **Owners cannot save notification settings** — the PATCH endpoint 500s.
> - **Customer email reminders never send** — the reminder engine throws every run.
> - Send-time per-event toggles are silently ignored (fail-open to "enabled").

No tenant-isolation issue, no data-loss issue, no security issue was found in
this session. The schema bookkeeping is clean.

### Minor: out-of-band table

`_twilio_creds_backup_2026` exists in prod with no corresponding migration —
an ad-hoc backup table. Harmless, but it is genuine untracked schema state.
A full provenance map of all 72 base tables was not in scope.

---

## 3. Reconciliation actions needed

### 3a. APPLIED-UNRECORDED migrations → **none**

No SQL to propose. Nothing to INSERT into `schema_migrations`. **Do not
hand-edit `schema_migrations`** — there is nothing to reconcile there.

### 3b. NOT-APPLIED migrations (052, 055) → **apply them via the runner**

Both are pending and both are safe to apply:
- Idempotent (`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`).
- Purely additive — no data migration, no drops.
- All new toggle columns are `BOOLEAN NOT NULL DEFAULT TRUE` → existing
  tenants keep current behavior (every notification fires); the new columns
  just make the already-deployed toggle UI and reminder engine *work*.

**Proposed action (NOT executed this session):**
```bash
# against staging first:
npm run migrate:dry         # confirm 052 + 055 are the only pending
npm run migrate             # applies 052 + 055; records them in schema_migrations automatically
```
The migration runner records each file in `schema_migrations` itself inside the
same transaction — so applying them *is* the reconciliation. No separate
bookkeeping step.

**Caveat:** project memory documents 052/055 as *deliberately* not applied.
That decision predates the feature code being deployed. Confirm with whoever
made the call that the deliberate-skip is no longer intended before applying —
but note that the current half-state (code deployed, schema absent) is itself
broken, so "leave as-is" is not a stable option.

### 3c. PARTIAL migrations → **none**

### 3d. Numbering gap 060 → **document only**

No file 060 ever existed; it is not in `schema_migrations`. Files jump
059 → 061. Recommend a one-line note in the migrations README so future
readers don't hunt for it. No action against prod.

---

## 4. `notificationGates.js` impact — path-by-path

With 052 + 055 columns absent (current prod), behavior splits into
**silently degraded** vs. **hard fail**:

### Silently degraded (still functional, but wrong + log spam)

| Path | Behavior |
|---|---|
| `readToggle()` (`notificationGates.js:78`) | Catches `column does not exist`, logs **WARN**, returns `true`. Per-event toggle gate is effectively a no-op. |
| `shouldSendSMS` / `shouldSendWA` (gate 3) | Plan + credentials gates still enforced. Gate 3 always passes. SMS/WA fire as if every toggle were ON — i.e. legacy pre-052 behavior. One WARN log line per send. |
| `shouldSendEmail` (gate 3) | Same — gate 3 fails open. Plan (`email_reminders`) + `RESEND_API_KEY` still enforced. |
| `getTenantNotificationToggles()` (`:199`) | Catches missing columns, logs WARN, returns all-`true` legacy defaults. The GET endpoint behind the frontend toggle matrix still renders (everything shows enabled). |

Net: notifications still go out (correct fail-open choice by the original
author), but **the toggle feature is cosmetic** and prod logs carry a WARN on
every notification send.

### Hard fail (throws / 500)

| Path | Behavior |
|---|---|
| `updateTenantNotificationToggles()` (`:254`) | Builds `UPDATE tenants SET <col> = $n …` and runs it with **no column-missing guard**. Any real toggle change throws `column does not exist`, uncaught → propagates. The owner-facing **PATCH `/tenant-notification-settings` endpoint 500s.** (A no-op patch with zero changes short-circuits safely.) **Owners cannot save notification preferences.** |
| `utils/emailReminderEngine.js` (`:99-107`, `:155`) | `WHERE b.${stampColumn} IS NULL` and `UPDATE bookings SET ${stampColumn} = NOW()` reference `bookings.email_reminder_sent_{24h,1h}` directly, **no guard**. Every engine run throws on the SELECT for both windows → **zero customer email reminders are ever sent**, error logged each tick. |

> Note: customer booking *confirmation* emails (the non-reminder path via
> `shouldSendEmail`) are only *degraded*, not broken — they can still send if
> the plan + `RESEND_API_KEY` allow. It is the *reminder* emails that are fully
> dead, because they additionally depend on the reminder engine's stamp columns.

---

## 5. Recommended next session

**Apply migrations 052 and 055 to prod** (after confirming the deliberate-skip
is no longer intended — see §3b caveat). Smallest safe step:

1. `npm run migrate:dry` against **staging** → confirm 052 + 055 are the only
   pending.
2. `npm run migrate` against **staging** → verify the toggle UI saves and the
   email reminder engine runs clean.
3. `npm run migrate` against **prod** in a low-traffic window.

This is low-risk (idempotent, additive, `DEFAULT TRUE`) and it closes the only
real finding: the deployed-code / absent-schema split that currently 500s the
owner notification-settings endpoint and silently kills customer email
reminders.

No `schema_migrations` hand-edit is needed or advisable — there is no
applied-unrecorded drift to reconcile.
