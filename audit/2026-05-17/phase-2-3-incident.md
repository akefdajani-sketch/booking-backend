# Phase 2.3 Production Incident — `tenants.features` Column Missing

**Date:** 2026-05-17 (incident timeline 03:34 → 04:03 local)
**Phase:** 2.3 — orchestrator wire-up (PR #460)
**Severity:** P1 — all Anthropic-backed AI features down for every Birdie tenant surface
**Duration:** ~30 minutes
**Window:** low-traffic (overnight Amman time)
**Status:** Resolved via migration 071 application; no code revert needed

## Timeline

| Time (UTC, ~) | Event |
|---|---|
| 03:34 | PR #460 merged to `main` (Phase 2.3 — orchestrator wire-up + migration 071) |
| 03:35 | Render auto-deploys the new code to production |
| 03:38 | Customer reports voice booking failure on mobile (`birdiegolf-jo.com`): "Error Column Features Doesn't Exist" |
| 03:40 | Investigation begins. Three surfaces confirmed broken: customer voice, customer text chat, Flexrz Assistant |
| 03:42 | Hypothesis: migration 071 (`ALTER TABLE tenants ADD COLUMN features JSONB ...`) was never applied to production; `utils/tenants.js` now SELECTs `features` column → `getTenantBySlug` throws → every code path that starts with tenant lookup fails before reaching Claude |
| 03:45 | Read-only verification on prod DB confirms: `features` column MISSING from `tenants`; last applied migration is `070_themes_v2_shells_layouts.sql` |
| 03:50 | `npm run migrate:list` confirms scope: exactly one migration pending (071), no surprises beyond it |
| 04:03 | `DATABASE_SSL=true npm run migrate` applied 071. Column added, existing rows backfilled with `'{}'::jsonb` default. AI layer recovered immediately on next request |
| 04:05 | All three surfaces verified working again. No Render redeploy needed — schema change was sufficient |

## Root cause

**Migration-after-deploy ordering violation.** Phase 2.3 introduced a new schema dependency:

- `utils/tenants.js:44` SELECTs `features` column (added in PR #460)
- `migrations/071_tenants_features_jsonb.sql` adds the column (added in PR #460)
- The PR was tested locally against a dev database that had the migration applied
- When merged, Render auto-deployed the code but **did not** auto-apply the migration
- Production code reached for a column that didn't exist
- `getTenantBySlug` threw on every request
- Every customer-facing route (voice, chat, owner assistant) starts with a tenant lookup → all three surfaces 500'd in lockstep

**This is a workflow gap, not a code bug.** The code is correct. The migration is correct. The deploy ordering was wrong: schema change must land in production BEFORE the code that depends on it.

## Recovery

A single command resolved the incident:

```bash
DATABASE_SSL=true npm run migrate
```

Output:
```
Running 1 migration(s)...
  ✓ 071_tenants_features_jsonb.sql
Done.
```

Verifications:
- `SELECT column_name FROM information_schema.columns WHERE table_name='tenants' AND column_name='features'` → returns one row (`features` exists)
- `SELECT filename, applied_at FROM schema_migrations WHERE filename='071_...'` → row present, `applied_at = 2026-05-17T01:03:50.114Z`
- `SELECT slug, features FROM tenants LIMIT 5` → all rows show `features: {}` (default backfilled correctly)

Migration was idempotent (`ADD COLUMN IF NOT EXISTS`, `DEFAULT '{}'::jsonb NOT NULL`) — safe to re-run, would no-op on a second invocation. The `NOT NULL DEFAULT` clause caused Postgres to backfill every existing row with `'{}'::jsonb` atomically during the `ALTER TABLE`, so no existing tenant ended up with `NULL features`.

After the migration, the very next inbound request succeeded: `getTenantBySlug` resolved the tenant with `features: {}`, the orchestrator's triple-AND guard saw `features?.voice_two_query !== true`, fell back to legacy `runSupportAgent`, and Claude responded normally. No code change, no redeploy.

## Impact

- ~30 min hard-down for three AI surfaces on Birdie Golf
- Low-traffic window (overnight Amman time); customer-reported failure count was minimal
- No data loss (no writes were affected; all failures were reads on the new column)
- No revenue impact (failures occurred on AI assistance flows, not the primary booking checkout)
- No cascading failures into other services

## Lessons

1. **Render auto-deploys code but does NOT auto-apply migrations.** This is the third documented instance of this pattern (052, 055, 071). The workflow gap is real and recurring.
2. **Always check migration-list against migration-applied state before merging code that depends on new schema.** A pre-merge gate that compares `migrations/*.sql` filenames against `schema_migrations.filename` in prod would have caught this.
3. **Idempotent migrations matter.** 071 used `ADD COLUMN IF NOT EXISTS` and `DEFAULT '{}'::jsonb NOT NULL`. If 071 had been a non-idempotent migration with NOT NULL but no default, applying it post-deploy would have failed (`column "features" of relation "tenants" contains null values` style error). The `NOT NULL DEFAULT` combo made recovery trivial.
4. **Defensive `getTenantBySlug` would have masked but not fixed.** Wrapping the SELECT in a try/catch would have prevented the cascading 500s but masked the real issue. The current behavior (loud failure → quick diagnosis → migration applied) is preferable to silent degradation.

## Future prevention

**Priority follow-up: add a Render release-phase hook** that runs `npm run migrate` automatically on every deploy. Separate ticket; needs:

- Render configuration: `releaseCommand: npm run migrate` in `render.yaml` or service settings
- Idempotency check: the migration runner already skips applied migrations, so re-running on every deploy is safe
- Failure handling: if a migration fails during release, the deploy must be aborted (Render's release commands support this via exit code)
- Logging: migration output should surface in Render's deploy logs for visibility

Secondary follow-ups:

- **Pre-merge migration check in CI**: a GitHub Actions job that runs `npm run migrate:list --dry-run` against a staging DB and fails the PR if there's a pending migration with a code dependency. Catches the issue at PR time rather than post-merge.
- **`migrate:dry` against prod in PR description**: for PRs that include a migration, require the PR description to include the output of `DATABASE_SSL=true npm run migrate:dry` as evidence the migration was previewed against prod schema.
- **Migration-application checklist** on PR templates for schema-changing PRs: a checkbox forcing the author to confirm the migration was applied to prod before merging.

## Related context

- The hardcoded `VOICE_PROMPT_FEATURE_SLUGS = ["birdie-golf"]` array in `utils/voiceContext.js:145` was originally a TODO comment pointing at the eventual `tenants.features` JSONB column. Migration 071 finally adds that column. The voice-prompt feature gate itself has NOT been migrated to the new column yet — that's a separate follow-up.
- Phase 2.0/2.1/2.2 were strict dark-ship PRs with zero production impact. **Phase 2.3 was the first PR with a production-code path referencing the new modules, and it shipped with a critical schema dependency.** The flag default-false safety did its job — no customer ever hit the brain+persona path during the incident — but the unrelated `features` column SELECT in `getTenantBySlug` was the unmasked dependency.
- Migration 071 was idempotent by design (decision from Phase 2.3 pre-flight): `ADD COLUMN IF NOT EXISTS` + `DEFAULT '{}'::jsonb NOT NULL`. That decision proved load-bearing during recovery — it made the migration safe to apply post-deploy with zero ambiguity about state.
