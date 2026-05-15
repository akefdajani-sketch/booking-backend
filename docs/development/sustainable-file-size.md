# Sustainable File Size & Patch Discipline

**Status:** Active rules. Read before adding any feature to an existing file.

**Origin:** Phase 0 test net work (May 2026) on `routes/bookings/create.js`. The file grew from 1482L → 1680L between April and May through patches that were each locally rational. Globally, the accretion forced a 9-PR refactor with a Phase 0 test net costing several focused sessions. These rules exist to prevent that cycle from repeating.

**Scope:** Applies to both human-authored and Claude-Code-authored changes. Applies to backend, frontend, and auth repos. Applies equally to TypeScript, JavaScript, and SQL migration files.

---

## The Pattern These Rules Prevent

Every large file in the codebase was once small. The growth pattern:

1. Feature ships. Lands in the nearest existing file because that file already exists and the patch is small.
2. Six weeks later, another feature lands in the same file for the same reason.
3. The file is now doing three things, but its name and top-of-file comment still describe one.
4. Test coverage was never added at patch-time because "the test harness is hard to set up for this file."
5. After 6–12 months the file is 1500+ lines, every line touches every other line via shared closure variables, and any change requires a multi-session refactor with a test net built from scratch.

**The cost isn't the eventual destruction.** The cost is that nobody decided, at patch-time, that the new code was a new responsibility. Each patch was reasonable. The aggregate was a monster.

---

## Rule 1 — Soft Cap (400 lines)

When adding code to a file already above 400 lines, the default action is **propose a new module**, not extend the existing one.

- Below 400L: extend freely.
- 400–600L: extend if the new code is *the same responsibility* as the file's existing code. Otherwise extract.
- Above 600L: extract by default. Require an explicit "no, add it here" with a one-sentence reason before extending.

Hard caps for reference (these are *bad*, not targets):

- Backend routes/utils: 800L is the audit threshold.
- Frontend components: 600L is the audit threshold.

When extraction means a new file:

- Backend: new file in `routes/<feature>/` or `utils/<feature>.js`.
- Frontend: new component file in the same directory as the parent.
- Name the file after the responsibility, not the parent (e.g. `computePricing.js`, not `createHelpers2.js`).

---

## Rule 2 — Responsibility Test

Before adding code, write a one-sentence description of what the new code does. Then read the **top-of-file comment** of the file you're about to add to.

If the new responsibility doesn't fit inside the file's stated purpose, that's the signal for a new file. Not optional.

Example from `create.js`:

- File's stated purpose: *"POST / (booking creation engine)"*.
- PAY-INTENT-1 added `payment_method` derivation logic.
- PAY-INTENT-1's responsibility: *"Determine how a booking is paid given customer state, service config, and tenant payment methods."*
- That's not "creating a booking" — it's "pricing/payment routing." Different responsibility. Should have been `utils/paymentMethodResolver.js` from day one.

The test: if you have to *justify* why the new code belongs in the existing file, it doesn't.

---

## Rule 3 — Patch-Time Test Net

Every feature ships with **at least one test** that exercises the new behavior through the public interface.

- Not 100% coverage. One happy-path test minimum.
- The test goes in the same PR as the feature, not "later."
- If the existing test harness can't support the new test, that's a sign the harness needs work *now*, not when the file is already 1500 lines.

If `create.js` had carried one happy-path test per PATCH-XX as they landed, Phase 0 would have started with 30+ tests instead of zero, and the extractions would have been days of work instead of weeks.

**Exception:** pure documentation, comment-only edits, dependency bumps. Anything that changes runtime behavior needs a test.

---

## Rule 4 — The 13% Rule

Files that grow more than 10% between development phases get flagged for review at the start of the next phase.

- `create.js` April → May: 1482L → 1680L = **13.4%** growth.
- That growth was visible. It just wasn't being measured.

Implementation: `scripts/check-file-sizes.mjs` already exists as a guardrail. Extend it to also report deltas vs the previous tag/release. Any file >10% growth gets surfaced in the phase-start audit before new work begins.

Files that consistently grow >10% phase-over-phase are extraction candidates regardless of absolute size.

---

## Rule 5 — Architectural Decision Records (Inline)

When a patch introduces a new responsibility into an existing file (because Rules 1 and 2 were overridden for a real reason), add a one-line ADR comment at the top of the file:

    // PAY-INTENT-1 (2026-05-04): payment_method derivation logic added.
    // Lives here because the derivation depends on booking state computed
    // 50 lines above. Candidate for extraction once the upstream state
    // stabilizes (target: Phase 1 refactor).

These ADRs serve three purposes:

1. Future readers know what doesn't belong here and why.
2. Refactor planning has a ready-made target list.
3. Reviewers can challenge the "Lives here because..." reason at PR time.

---

## Rule 6 — Patch IDs Become Extraction Boundaries

Patches that ship with named IDs (PR-XX, PATCH-XX, VOICE-FIX-X, PAY-INTENT-X, etc.) define natural extraction boundaries. When refactoring, the first pass at module boundaries should follow the patch-ID seams.

This is already standard practice on this codebase — the audit in `audit/2026-05-14/phase1_preflight/create_js_audit.md` reverse-engineered the +198 line growth as `PAY-INTENT-1 + CLIQ-CONFIRM-1 + ...`. Going forward, patches that grow files significantly should leave a comment block marking their boundaries so reverse-engineering isn't needed:

    // ─── PAY-INTENT-1 (2026-05-04) start ────────────────────────────
    // payment_method derivation
    // ... 22 lines ...
    // ─── PAY-INTENT-1 end ───────────────────────────────────────────

Cheap at write-time. Saves hours at refactor-time.

---

## Rule 7 — Schema-First Discipline

Migrations must apply before the code that depends on them. Period.

- Code referencing a column that doesn't exist yet is a silent prod bug.
- `notification toggle column missing — migration 052 not applied yet` WARN spam for 4+ days was the symptom.
- Migrations are not "deploy after the code lands and verify." They are part of the same change.

Operational rule: every PR that adds columns must include both the migration file **and** a deploy-time `npm run migrate` step in the deploy checklist. Render auto-deploys backend code but **does not auto-apply migrations**. The author of the migration is responsible for running it.

---

## Rule 8 — Layered Superset Awareness

When editing files marked as layered supersets, never replace them with what looks like a clean version. Always merge into the existing layered file.

Current supersets (May 2026):

- `PublicBookingContent` (97+98+99+101+143)
- `MembershipsTab`/`PackagesTab` (98+99+143)
- `BookingHistory` (103)
- `registry.tsx` (105+107+113)
- `OwnerDayViewGrid` (108+114)
- `AppearanceUiTab` (100+116)
- `taxFormatting` (94–96+112c)
- `app/book/[slug]/page.tsx` (PATCH 120+121)
- `routes/publicTenantTheme.js` (tenants.name post-121)
- `__tests__/bookings_create.test.js` (PR 0.1 + 0.2 + 0.3)

If a file matches a superset ID, the file *is* the merge of all listed patches. There is no "clean version" to fall back to. Audit before edit. Confirm superset ID with the user before any destructive change.

---

## Rule 9 — Audit Before Code

Before any non-trivial change to an existing file:

1. Read the file end-to-end. Not skim.
2. Identify which rules above apply.
3. Surface the analysis to the user before writing code.
4. Wait for approval.

This is already the established workflow. It exists in writing now so it stays the established workflow when sessions are long, when the agent is tired, or when the user is half-paying-attention.

---

## When These Rules Apply (Default) vs Don't (Exceptions)

**Apply by default:**

- New features
- Bug fixes that add logic (vs change existing logic)
- Refactors
- Any code that crosses a responsibility boundary

**Don't apply (extend freely):**

- Typo fixes, comment edits
- Dependency version bumps with no behavior change
- Style/lint fixes that don't change logic
- Renaming a variable consistently across one file
- Adding a log line for observability

**Judgment calls:**

- "Small" features that feel like they fit existing code. *Apply Rule 2 — the responsibility test. If you have to justify the fit, extract.*
- Hot fixes that need to ship in minutes. *Document the rule break in the PR. Schedule the extraction in the next phase.*

---

## Adoption Plan

These rules are new. They don't apply retroactively to existing files. They apply to:

1. **All Phase 1 extraction PRs** (PRs 1–7 of the `create.js` refactor). Each extracted module must be born compliant.
2. **All new features** going forward — voice agent two-query refactor, Twilio WhatsApp dispatch, THEMES-V2 phase work, etc.
3. **Existing files only when they're already being touched** for other reasons. Don't open files just to apply these rules. Apply them when a file is open for legitimate work.

The goal is to *prevent* the next monster file, not to refactor every existing one.

---

## How to Use This Document

- **Claude (chat / planning):** read this before drafting any brief that adds code to an existing file. Surface relevant rules in the brief itself.
- **Claude Code (executor):** read this before any non-trivial edit. If the edit violates a rule, surface a stop-condition before writing code.
- **ak:** review at the start of each phase. Update with new patterns observed during phase work.

This document is itself subject to its own rules — when it grows past 500 lines or starts covering unrelated concerns, split it.

---

**Last updated:** May 15, 2026 — initial version, drafted at the end of PR 0.3 test net work.
