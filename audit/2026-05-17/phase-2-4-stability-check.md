# Phase 2.4 — Stability Check (Birdie Golf)

**Date:** 2026-05-17
**Tenant:** Birdie Golf (`tenants.id = 3`, `slug = birdie-golf`)
**Status:** **DEFER — premature.** Re-check on or after 2026-05-24.

## Summary

The Phase 2.4 stability check this session was set up against a faulty
assumption: that the `voice_two_query` flag had been on for ~7 days. It
hasn't. The flag flipped **today** (2026-05-17 ~04:03 +0300), giving
Birdie roughly **16 hours** of post-flip exposure as of writing. That is
not enough signal to call STABLE or UNSTABLE, regardless of whether the
underlying data looks clean. **Decision: DEFER.** No additional tenant
flips. Birdie stays on two-query. Re-run this check after 7 days of
real exposure (on or after **2026-05-24**).

## Background — the dating error

The session was framed as "Birdie has been on two-query for 7 days,
time to check stability." That framing came from a misread of the
project's own memory note, which actually said *"check around
2026-05-24"* (7 days post-flip), not "checked already 7 days in."

What the artifacts in this repo actually show:

| Artifact | Timestamp |
|---|---|
| Migration 071 applied to prod (`features` column added) | 2026-05-17 01:03:50 UTC |
| Phase 2.4 rollout doc committed (`8284f13`) | 2026-05-17 17:22:36 +0300 |
| Phase 2.3 incident postmortem | 2026-05-17 (overnight Amman time) |
| Most recent migration in `schema_migrations` | 071 |

The flag flip happened *after* the 071 migration applied — i.e. some
time today, May 17. Treating the May 10–16 window as "post-flip" is
incorrect; that window is pre-flip.

This isn't a code or data issue. It's a session-framing error. Calling
it out here so future re-reads of this audit folder don't repeat it.

## Current data state (verified today, read-only)

### Flag

```
SELECT id, slug, features FROM tenants WHERE id = 3;
→ id=3  slug=birdie-golf  features={"voice_two_query": true}
```

Confirmed on. Matches the `RETURNING` row in `phase-2-4-rollout.md`.

### Schema

Migration 071 (`ALTER TABLE tenants ADD COLUMN features JSONB ...`)
applied at `2026-05-17T01:03:50.114Z` per `schema_migrations`. No
pending migrations.

### Booking volume on tenant 3, May 3–17 Amman local

Daily totals (zero-booking days shown as `—`):

```
date         total  active  soft_deleted   notes
─────────────────────────────────────────────────────────
2026-05-03      5       5         0
2026-05-04      5       5         0
2026-05-05      1       1         0
2026-05-06      2       2         0
2026-05-07      —       —         —
2026-05-08      —       —         —
2026-05-09      6       6         0
2026-05-10      4       4         0
2026-05-11     10      10         0
2026-05-12      —       —         —
2026-05-13      4       4         0
2026-05-14      —       —         —
2026-05-15      4       4         0
2026-05-16     20      20         0       spike day
─────────────────────────────────────────────────────────
2026-05-17      2       2         0       partial day, post-flip
─────────────────────────────────────────────────────────
                       ↑ flag flipped sometime after 04:03 +0300
```

Period aggregates:

```
period            total   avg/day   span
─────────────────────────────────────────────
pre-flip (all)      63      4.5/d   May 3–16, 14 days
post-flip            2       —      May 17 only, partial
```

Note: **all 63 pre-flip bookings were created via the legacy
single-prompt path**, not via two-query. The +22-booking gap between
the earlier-week and later-week is *not* attributable to the
architecture switch.

Soft-deletes: **zero across the entire 15-day window.** Either Birdie
genuinely had no cancellations, or the cancel path doesn't soft-delete
on this tenant. Out of scope for this audit; flagged for separate
review.

### `audit_log` is dormant on this surface

```
SELECT event_type, COUNT(*) FROM audit_log
 WHERE tenant_id = 3 AND created_at >= '2026-05-10'
 GROUP BY event_type;
→ 0 rows
```

Empty. This is **not** evidence of "no events" — it's evidence that
`routes/bookings.js` does not call `writeAuditEvent` (`utils/auditLog.js`).
A grep across `routes/` confirms the audit-log writer is only invoked
from a handful of owner-side endpoints (DSR, settings, etc.), not the
customer booking-create path. We cannot use `audit_log` as a
substitute for Render logs for booking-level telemetry.

## What we *can* measure today (DB-only)

- **Flag state** ✅
- **Migration application** ✅
- **Total booking counts per tenant per day** ✅
- **Booking soft-delete activity** ✅
- **`audit_log` events** ✅ (but dormant for booking-create surface)

Together: enough to confirm the rollout *happened* and the system is
not visibly broken. **Not enough to discriminate voice-via-two-query
bookings from any other source.**

## What we *cannot* measure today

All four post-flip metrics named in the original brief live in
`console.warn` / Sentry only — there is no DB mirror:

| Metric | Source |
|---|---|
| `[AI create_booking] FABRICATION BLOCKED` count | `routes/ai.js:985` (`console.warn`) |
| `[AI create_booking] CONFLICT BLOCKED` count | `routes/ai.js:1005` (`console.warn`) |
| `[claudeService] confirmationMode=true but no valid ACTION parsed` | `utils/claudeService.js:826` (`console.warn`) |
| `/api/ai/*` and `/api/voice/*` 500s | Sentry / Render error log |

Without Render log export (CLI not installed; dashboard copy-paste
only) or Sentry access, these counts are unavailable. They are also
the **only** four metrics that would let us judge stability — total
booking counts can't tell you whether the agent fabricated a slot or
hit a conflict-blocked dead-end.

## What's needed for a real stability check

1. **Render log access.** Either:
   - Install Render CLI locally (`npm i -g @render-tools/cli` or
     similar — confirm the canonical install with Render docs at
     re-check time), authenticate, and query the booking-backend
     service's logs by time window + grep, *or*
   - Dashboard copy-paste of the four warning patterns, time-windowed
     to 2026-05-17 04:03 → re-check time.
2. **Source flag on `bookings`.** Right now `routes/ai.js:1047` POSTs
   to `/api/bookings` with the same payload shape as the form path —
   there is no `booking_source` / `created_via` / `origin` column to
   filter on. A short follow-up migration could add `created_via TEXT
   CHECK (created_via IN ('form','voice','chat','staff','walk_in'))`
   to `bookings` plus a `created_via` field in the AI create payload.
   This would let post-flip checks separate voice activity from
   everything else without needing log inspection. Out of scope for
   this session but worth filing.
3. **Prod-DB-activity latency benchmark.** `phase-2-4-rollout.md` and
   `voice-two-query-latency.md` line 75 both promised: *"Phase 2.4
   will re-run this benchmark with real production DB activity from
   Birdie before flipping the flag."* That re-run was never collected
   — the audit folder contains only the synthetic-fixture benchmark.
   At re-check time, run `scripts/benchmark/voice-two-query.js`
   against the real tenant context (Birdie services, resources, hours)
   to get a prod-realistic latency profile, not just isolated Claude
   round-trip time.

## Recommendation

**DEFER until on or after 2026-05-24** (≥7 days of real post-flip
exposure). Until then:

- `voice_two_query` **stays on** for Birdie Golf (tenant 3). No
  rollback. There is no evidence of regression — only insufficient
  evidence to confirm stability.
- **No other tenants get flipped.** The original brief asked whether
  Aqababooking or Al-Razi should be next. The honest answer today is
  "neither, yet — Birdie hasn't been observed long enough."
- The rollback SQL is preserved verbatim below for fast access if
  something surfaces in the next 7 days:

```sql
UPDATE tenants
   SET features = features - 'voice_two_query'
 WHERE slug = 'birdie-golf'
 RETURNING id, slug, features;
-- Expected RETURNING: features: {}
```

## Re-check checklist (to use on 2026-05-24)

When this audit is repeated, the runner should produce:

- [ ] Render log counts for the four warning patterns, window
      2026-05-17 04:03 → re-check time
- [ ] Booking volume on tenant 3 split pre-flip (May 3–16) vs
      post-flip (May 17 → re-check date)
- [ ] If `created_via` column has landed in the meantime: split
      post-flip bookings by source (voice / form / other)
- [ ] Re-run latency benchmark against real Birdie prod context, not
      synthetic fixtures
- [ ] Decision: STABLE → name the next tenant to flip with reasoning;
      UNSTABLE → execute the rollback SQL above and document why;
      DEFER → say so and set a new re-check date

## Appendices

### A. Source of the dating confusion

The session opened with a brief asserting "flipped Birdie Golf to
two-query on May 10, 2026" and "Birdie has been on two-query for 7
days." Both statements were the user's own paraphrase of a memory
note that actually read *"check around 2026-05-24"* (7 days *forward*
from the flip, not *behind*). The confusion only surfaced after the
DB query produced unexpectedly large post-flip booking counts that
didn't match a freshly-flipped flag. Cross-checking `git log` against
the rollout doc confirmed the flip was today, not a week ago.

Lesson: when a session is framed around a temporal claim ("X days
since Y happened"), the first verification step should be a `git log`
on the artifact that recorded Y, not just trusting the framing.

### B. Files consulted

- `audit/2026-05-17/phase-2-4-rollout.md`
- `audit/2026-05-17/voice-two-query-latency.md`
- `audit/2026-05-17/voice-legacy-latency.md`
- `audit/2026-05-17/phase-2-3-incident.md`
- `audit/2026-05-14/schema_drift/DB_SCHEMA_SNAPSHOT_2026-05-14.md`
- `routes/ai.js` (read-only — Phase 2 protected)
- `utils/claudeService.js` (read-only — Phase 2 protected)
- `utils/auditLog.js`
- `migrations/071_tenants_features_jsonb.sql`

### C. Queries executed (read-only)

All queries ran against prod Render Postgres via `DATABASE_SSL=true`
node script (pattern from `scripts/probe_schema.js`). The one-shot
script was deleted after use — not shipped.

1. Flag state on tenant 3 (`SELECT id, slug, features ...`)
2. `bookings` column presence check
3. Daily booking counts on tenant 3, May 3–17 Amman local
4. Period aggregate (pre-flip vs post-flip vs today)
5. `audit_log` event counts on tenant 3 since 2026-05-10
