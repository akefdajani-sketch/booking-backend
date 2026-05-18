# Phase 5.3 — Rollback Plan (Scoping)

> **Purpose:** Safety net for the SectionRenderer refactor. If anything
> regresses post-flip, the `tenants.use_section_renderer` flag flips
> back to FALSE in seconds — no deploy, no rebuild.
>
> **When to read this:**
> - **Before** the implementation session ships Phase 5.3 — full read.
> - **During** an incident — jump to §3 (Rollback triggers) then §1 (SQL).

## TL;DR

| Symptom | One-liner |
|---|---|
| Single tenant regressed | `UPDATE tenants SET use_section_renderer = FALSE WHERE slug = '<slug>';` |
| Multiple tenants regressed | `UPDATE tenants SET use_section_renderer = FALSE WHERE slug IN ('a','b','c');` |
| Panic — roll back everyone | `UPDATE tenants SET use_section_renderer = FALSE;` |

Effect is immediate **if** the flag is read fresh on every request — see
§5 "Caching risk" for the must-verify list before flipping anyone.

## §1 — Rollback mechanism

Adds a single column to `tenants`:

```sql
tenants.use_section_renderer BOOLEAN NOT NULL DEFAULT FALSE
```

- **NOT NULL** with strict FALSE default. Three-valued logic ("NULL = use
  platform default") invites bugs; every tenant has an explicit boolean.
- **Per-tenant**, not global. Surgical rollback while leaving healthy
  tenants on the new code path.
- `BookTab.tsx` dispatch:
  - `tenant.use_section_renderer === true` → SectionRenderer composition
  - `tenant.use_section_renderer === false` → legacy monolithic render
    (the current 563-line `BookTab.tsx` body, unchanged)
- **Why a column on `tenants` and not a new `feature_flags` table?** No
  new infrastructure; the column is queryable for ad-hoc audits
  ("how many tenants are on the new path right now?"); migration
  pattern matches existing precedents (`shell_key`, `layout_key_v2`
  added in migration 070 the same way).

Rollback SQL forms:

```sql
-- Roll back ONE tenant (most common incident response)
UPDATE tenants SET use_section_renderer = FALSE WHERE slug = '<slug>';

-- Roll back ALL tenants (panic button)
UPDATE tenants SET use_section_renderer = FALSE;

-- Roll back by theme (e.g. all premium_v2 tenants)
UPDATE tenants SET use_section_renderer = FALSE WHERE theme_key = 'premium_v2';
```

## §2 — Rollout strategy

Five phases. Each phase has the same pass criterion:

- Diff harness `07_diff_against_baseline.js` returns exit 0 across the
  just-flipped tenant(s)
- Sentry error rate on flipped tenants stays within ±50% of pre-flip
  baseline over a 24h window
- Zero owner-reported regressions during the 24h soak

If any criterion fails, roll back that phase's tenants and do not advance.

| Phase | Action | Tenants | Verification |
|------:|---|---|---|
| **A** | Deploy code + migration 072. Flag defaults FALSE everywhere. | 7 — no behavior change | Migration applies cleanly; `SELECT use_section_renderer, COUNT(*) FROM tenants GROUP BY 1` returns 7 / FALSE. |
| **B** | Flip **Birdie** only (id 3 — most layered patches; premium theme; first canary). | 1 protected | Run 07 against pre-flip baseline (must = exit 0); 24h soak. |
| **C** | Flip 2–3 low-traffic **standard** tenants. | 2–3 standard | 07 + 24h soak. |
| **C½** | Flip **Al-Razi (21)** and **karamhomes (33)** individually, with a 24h soak each. The other two protected tenants are gated separately — cheap insurance against silent regressions on the highest-cost tenants. | 2 protected (sequentially, not parallel) | 07 + 24h soak per tenant. |
| **D** | Bulk flip remaining 1-2 standard tenants. | 1-2 standard | 07 against full 7-tenant set; 24h soak. |

The three protected tenants (Birdie/Al-Razi/karamhomes) all get
individual gating (Phases B + C½) before any bulk flip happens.

## §3 — Rollback triggers

**Tier 1 — automated (no judgment; flip immediately on signal):**

- Diff harness verdict = `DIFF` on any flipped tenant
- Sentry error rate > 2× pre-flip baseline on flipped tenants

**Tier 2 — judgment (single signal is sufficient; lean toward rollback):**

- Owner-reported visual regression (any single complaint = roll back
  that tenant)
- Booking conversion drops > 10% on flipped tenants in 24h window
- Specific feature regressions from `phase-5-3-patch-tracker.md`:
  - **PAY-2** pre-confirm modal fails to open or close
  - **PR A4** `<BookTabFillBlocks>` disappears for tenants where it
    should render
  - **PR-CAT4** service categories stop appearing in the selector
  - **PR-LC2** deep-link service pre-selection stops working
  - **REDESIGN-1** nightly hero re-introduces a page-wide hero on
    nightly tenants (the regression the original patch was written to
    prevent)

The patch-tracker's preservation contract entries map 1:1 onto these —
anything in the contract failing is a Tier 2 trigger.

## §4 — Migration shape (draft)

```sql
-- Migration 072 — THEMES-V2 Phase 5.3 SectionRenderer feature flag
--
-- Adds a per-tenant rollout flag for the SectionRenderer refactor.
-- See audit/2026-05-17/phase-5-3-rollback-plan.md for context.

BEGIN;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS use_section_renderer BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN tenants.use_section_renderer IS
  'Phase 5.3 rollout flag. FALSE = legacy BookTab render path (default '
  'for all tenants until explicitly flipped). TRUE = new SectionRenderer '
  'composition driven by platform_layouts. Per-tenant rollback by '
  'flipping to FALSE — no deploy needed. See '
  'audit/2026-05-17/phase-5-3-rollback-plan.md.';

COMMIT;
```

**Migration number:** `072` is the next free slot at time of scoping
(`071_tenants_features_jsonb.sql` is the last applied per the repo).
**Implementation session must confirm against `schema_migrations` on
prod before assigning the final number** — another migration may have
landed in the gap between scoping and implementation.

## §5 — Edge cases & operational notes

### What does NOT trigger rollback (false-positive guardrails)

- CSS-module class hash changes the diff harness should be normalizing.
  If a real CSS-module hash diff slips past the normalizer (rule
  `css_module_hash_suffix` in script 07), refine the normalizer
  rather than roll back.
- `api_drift` findings alone — surfaced separately by the diff
  harness; not a visual-parity failure on their own.
- Differences explicitly documented as **intentional** outcomes in the
  implementation-session PR description (e.g. a deliberate DOM-cleanup
  re-wrap that produces a diff but no visual change).

### Caching risk — the flag MUST be read fresh on every request

The flag flip only works in seconds if no layer is caching the tenant
row across requests. Cache layers in this codebase that could blunt a
rollback, **ordered by severity:**

#### 1. `appearance_snapshot_published_json` (HIGHEST severity — silent killer)

Cached at publish time. Refreshed only when the tenant clicks publish
in the appearance studio. Can be stale for hours/days. **If
`use_section_renderer` is ever read out of this snapshot, a `UPDATE
tenants SET use_section_renderer = FALSE` will not take effect until
the next publish.**

**Hard requirement on the implementation session:**
`use_section_renderer` is an **operational flag**, NOT an appearance
field. It MUST NOT be included in `appearance_snapshot_published_json`
or any related cached snapshot. The implementation PR must explicitly
state this in the description.

#### 2. Next.js ISR / static generation on `/book/[slug]`

If the booking page is statically rendered with ISR, the flag won't
take effect until the next revalidation window. Verify
`app/book/[slug]/page.tsx` uses `export const dynamic = "force-dynamic"`
or otherwise reads the flag server-side on every request. Per
PATCH 120+121, the page is dynamic for tenant-title hydration; this
needs reconfirmation before the implementation session ships.

#### 3. Vercel edge cache (CDN)

May serve cached HTML across requests. After a rollback flip, a CDN
purge may be required to evict cached HTML. The booking page should
already carry `Cache-Control: no-store` or `s-maxage=0` headers; if
not, the implementation session adds them as part of the flag wiring.

#### 4. Next.js React `cache()`

Per PATCH 121, the tenant lookup on `app/book/[slug]/page.tsx` is
already wrapped in React `cache()` for title hydration. This memoizes
the tenant row **per request** (usually fine — request-scoped, not
cross-request), but it means a single request reads one consistent
view of the tenant row.

**Hard requirement on the implementation session:** the flag MUST be
read in a separate, **non-cached** DB query inside the BookTab dispatch
path, NOT through the same cached lookup. This guards against future
devs accidentally widening `cache()` scope (e.g. moving to a
longer-lived memoizer) and freezing the flag's value.

### In-code-comment requirement

The SectionRenderer dispatch site in `BookTab.tsx` must include a
comment that:

1. Cites this rollback doc by path
2. States the cache-bypass requirement explicitly
3. Names `tenants.use_section_renderer` as the flag source

Example required-comment shape (implementation session writes the real
one; this is the contract):

```tsx
// Phase 5.3 rollout dispatch. Reads tenants.use_section_renderer
// directly (NOT through any cached snapshot or React cache()). See
// audit/2026-05-17/phase-5-3-rollback-plan.md §5 for why this matters
// for rollback latency.
if (tenant.use_section_renderer) {
  return <SectionRenderer ... />;
}
// fall through to legacy render
```

Defensive against future devs widening the cache and silently freezing
the flag's value.

### What to do if rollback itself fails

If a flag flip doesn't take visible effect within ~30 seconds:

1. Confirm the UPDATE actually ran (`SELECT slug, use_section_renderer
   FROM tenants WHERE slug = '<slug>';` should return FALSE).
2. If TRUE on DB but new renderer still serving: cache layer is
   capturing the value. Diagnose in §5's cache order — check snapshot,
   then ISR, then edge, then React cache.
3. As emergency override: deploy a hotfix that hardcodes
   `use_section_renderer = false` in the BookTab dispatch and ship it.
   Slower than a SQL flip, but always works.
4. Document the failure mode here as an amendment after the incident.

### Authority

- **Flag flips:** ak only (current state). No automated triggers.
- **Migration apply:** ak only (standard backend deploy pipeline).
- Implementation session decides if a slack-bot / web UI should be
  added later; out of scope for Phase 5.3 itself.

### Audit trail

**Minimum acceptable (Phase 5.3 launch):**

- Every flag flip recorded in a slack thread with timestamp + slug +
  reason.
- **Plus**: every flip accompanied by a committed SQL file at
  `ops/flag-flips/2026-MM-DD-flip-<slug>.sql` containing the exact
  UPDATE statement run. Tracks history in repo without new
  infrastructure; same audit trail as DB migrations get. Format:

  ```sql
  -- 2026-MM-DD — flip <slug> to use_section_renderer = TRUE/FALSE
  -- Reason: <one-line reason>
  -- Operator: ak
  UPDATE tenants SET use_section_renderer = <bool>
   WHERE slug = '<slug>' AND id = <tenant_id>;
  ```

**Aspirational (v1.1 add-on):** a `tenant_flag_audit` table with
trigger-based or app-side insertion on every UPDATE. Out of scope for
Phase 5.3; flagged for follow-up.

## §6 — Cross-references

- `phase-5-3-tenant-inventory.md` — the 7 tenants this plan covers.
- `phase-5-3-section-inventory.md` — what the refactor changes and
  where blockers live.
- `phase-5-3-patch-tracker.md` — preserved behavior contract (source
  of §3 Tier 2 trigger list).
- `phase-5-3-baseline-capture-extensions.md` — the diff-harness flow
  this rollback plan depends on for per-phase verification.
