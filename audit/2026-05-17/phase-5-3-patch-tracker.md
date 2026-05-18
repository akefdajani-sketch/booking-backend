# Phase 5.3 — Patch Tracker (Scoping)

> **Purpose:** Enumerate every patch whose behavior the SectionRenderer
> refactor must preserve. The implementation session uses this as the
> "do not regress" contract.
>
> **Methodology:** `git log -p` and patch-marker greps on the refactor
> target (`BookTab.tsx`) and its adjacent dispatcher
> (`PublicBookingContent.tsx`, kept for context per scoping Q&A).
> The standing-rules floor (`97, 98, 99, 101, 143`) is the **minimum**;
> code-marker grep is the source of truth.

## Standing-rules floor — applies to PublicBookingContent, NOT BookTab

The user's standing rules cite five patches on `PublicBookingContent.tsx`
that the SectionRenderer refactor must not regress:
`97, 98, 99, 101, 143`. Grep traceability into current code:

| Patch | Marker found at | Subject | Affects BookTab? |
|-------|-----------------|---------|------------------|
| 97 | `components/booking/MembershipStatementBanner.tsx:12` | "Patch 97 moved the detailed [banner] into the 'Active membership card' section." | **No** — Memberships tab. |
| 98 | (no surviving marker) | Per standing rules, lands on `MembershipsTab` + `PackagesTab`. | **No** — Memberships/Packages tabs. |
| 99 | (no surviving marker) | Per standing rules, lands on `MembershipsTab` + `PackagesTab`. | **No** — Memberships/Packages tabs. |
| 101 | (no surviving marker) | Per standing rules, lands on `PublicBookingContent` cosmetically (likely wrapper-style; verify in git log when the implementation session runs). | **No** for BookTab; need diff vs PublicBookingContent to confirm. |
| 143 | `PR-TAX-3 (Patch 143)` — many locations | Tenant `tax_config` forwarded to `MembershipPurchaseModal` + `PackagePurchaseModal` for VAT/service-charge rendering. | **No** — Memberships/Packages modals, not BookTab. |

Since the SectionRenderer refactor scope is **BookTab**, none of these
five floor patches intersect the refactor surface directly. The contract
is still: BookTab refactor must not cause regressions on those other
tabs *as a side effect* (e.g. via shared state, theme tokens, or
provider plumbing). That's a sanity check, not a section-renderer
concern.

## Patches that DO land in BookTab (the actual contract)

Grep'd from `components/public-booking/BookTab.tsx`. Each must be
preserved by the SectionRenderer — either by routing the rendered
sub-tree through the section that owns the behavior, or by leaving the
non-section overlay/banner code alone in BookTab itself.

### PR A4 — Book tab fill blocks (v2 §1.4)

- **Marker:** `BookTab.tsx:115` (`// PR A4 — Book tab fill blocks (v2 §1.4)`).
- **What it added:** `<BookTabFillBlocks />` below the booking form,
  business-type-gated via `deriveBookTabBusinessType(tenant)`. Renders
  "Book again" tiles for `time-slot-single`; stubs for other business
  types. Reads `services`, `history`, `customer`. Returns `null` when
  the block has no content.
- **Render location:** `BookTab.tsx:515-556`, wrapped in the same
  `var(--surface-max-consumer, 860px)` container the form card uses
  (FILL-BLOCK-ALIGN; see below).
- **SectionRenderer contract:** PR A4 has no equivalent in the seed's 8
  supported types. Closest analogue is `service_grid` but the semantics
  are different (it's a *recent-history* re-book affordance, not a
  primary selector). The implementation session must either:
  - Add a new supported type (e.g. `fill_blocks` / `quick_rebook`) to
    the layout seed and render it via SectionRenderer, OR
  - Render `<BookTabFillBlocks />` as a non-section trailing element
    after the section list (parent owns it).

### REDESIGN-1 — Hero image source for nightly pre-selection

- **Marker:** `BookTab.tsx:256-269` (`// REDESIGN-1: hero image source for the pre-selection banner.`).
- **What it added:** A fallback chain for the hero image inside
  `<NightlyBookingFormCard defaultBannerSrc=...>`. The fallback order:
  `tenant.banner_book_url` →
  `tenant.branding.assets.banners.book` →
  `tenant.cover_image_url` →
  `tenant.branding.assets.coverImageUrl` →
  `filteredResources[0].image_url` → `null`.
- **Why surprising:** This image used to be a page-wide hero (a
  separate top-level section) — the REDESIGN-1 patch *moved it inside*
  the booking card for nightly tenants, in the same slot the property
  gallery occupies after a resource is selected.
- **SectionRenderer contract:** The seed's `hero` section is exactly
  the page-wide hero that REDESIGN-1 *removed* for nightly tenants.
  If the renderer obeys the seed literally, it'll re-introduce the
  page-wide hero on nightly tenants — a regression. Either:
  - Encode the conditional in the seed (e.g. `hero` enabled only when
    `!isNightlyService` for this tenant), OR
  - Drop the seed's `hero` entry for nightly tenants and rely on the
    card-internal banner.

### PR-CAT4 — Categories + category label

- **Marker:** `BookTab.tsx:367` (`categories={categories ?? []} // PR-CAT4`)
  and `BookTab.tsx:368` (`categoryLabel={labels?.categoryLabel || "Category"} // PR-CAT4`).
- **What it added:** Tenant-configured service categories surfaced into
  `BookingFormCard`. Backend ships `categories` and `labels.categoryLabel`
  via the tenant theme/labels payload; BookTab forwards both into the
  form card.
- **Render location:** `BookTab.tsx:367-368`.
- **SectionRenderer contract:** Internal to `BookingFormCard` —
  invisible at the BookTab level. As long as `BookingFormCard` keeps
  receiving these props, the SectionRenderer doesn't need to know.
  **Risk:** if the implementation session chooses option 1 from the
  section-inventory doc (extract BookingFormCard internals into discrete
  sections), the `service_selector` section needs `categories` +
  `categoryLabel` passed through. Easy to miss.

### PAY-2 — Payment method + Pre-confirm Summary modal

- **Markers:** `BookTab.tsx:369` (`// PAY-2: payment method`),
  `BookTab.tsx:392` (`// PAY-2: Pre-confirm Booking Summary modal`).
- **What it added:** Two things bundled under one patch tag:
  1. Payment-method state (`availablePaymentMethods`,
     `selectedPaymentMethod`, `onPaymentMethodChange`,
     `paymentAmount`) plumbed into `BookingFormCard`.
  2. A **second** `<ConfirmationModal preConfirm />` rendered inline
     with the booking flow (lines 393-500). Distinct from the success
     `<ConfirmationModal />` at line 171.
- **Render location:** `BookTab.tsx:369-378` (form card props),
  `BookTab.tsx:392-500` (pre-confirm modal).
- **SectionRenderer contract:**
  - The payment-method state lives inside `BookingFormCard`; preserved
    by passing the same props through. Same caveat as PR-CAT4 if
    option 1 from the section-inventory doc is taken.
  - **The pre-confirm modal is NOT a section.** It's an overlay that
    must remain owned by BookTab (or a sibling) and rendered alongside
    the section list. SectionRenderer should NOT try to render it.
    `summaryOpen`-controlled visibility must continue to work end-to-end
    (open from form-card review → close on submit or "Book another").

### PR-LC2 — Deep-link intent

- **Marker:** `BookTab.tsx:374` (`// PR-LC2: deep-link intent`).
- **What it added:** `deepLinkIntent` prop on `BookingFormCard` plus
  `onDeepLinkConsumed={() => setDeepLinkIntent(null)}` handler. Lets a
  URL like `/book/<slug>?service=…` pre-select the service when the
  form mounts.
- **Render location:** `BookTab.tsx:374-376`.
- **SectionRenderer contract:** Internal to `BookingFormCard`. Same
  caveat as PR-CAT4 and PAY-2 if internals get extracted into separate
  sections — `service_selector` section needs `deepLinkIntent` +
  the consume callback.

### Patch 151 — Tenant prop for timezone display features

- **Marker:** `BookTab.tsx:377` (`// Patch 151: tenant for timezone display features`).
- **What it added:** Passes `tenant={tenant}` into `BookingFormCard` so
  the card can read timezone configuration directly (was previously
  derived per-prop). Enables future timezone-aware UI inside the form.
- **Render location:** `BookTab.tsx:378`.
- **SectionRenderer contract:** Internal to `BookingFormCard`. Preserve
  by continuing to pass the tenant object; verify after refactor.

### FILL-BLOCK-ALIGN — Wrapper maxWidth alignment

- **Marker:** `BookTab.tsx:520` (`FILL-BLOCK-ALIGN: wrap in the same maxWidth container the form card uses`).
- **What it added:** Wraps `<BookTabFillBlocks />` in the same
  `var(--surface-max-consumer, 860px)` container that the booking form
  card uses on premium themes. Without this, the "Book again" tiles
  extend wider than the calendar card on premium tenants (Aqaba was the
  reported regression).
- **Render location:** `BookTab.tsx:528-533`.
- **SectionRenderer contract:** If the renderer wraps each section in a
  per-section container, this max-width rule must apply uniformly to
  the BookTabFillBlocks-equivalent section. If the renderer expects the
  parent to provide the wrapper, it must continue to wrap by surface
  class.

## Patches in PublicBookingContent.tsx (context, not refactor target)

These do not land in BookTab and the SectionRenderer doesn't touch
PublicBookingContent. Listed here so the implementation session has a
single doc to reference if cross-tab regressions surface.

| Patch | PublicBookingContent.tsx line | Subject |
|---|---|---|
| PR 130 | 180, 438 | Customer avatar wiring (upload/delete via `/api/proxy/customers/me/avatar`); reads `customer.avatar_url`; calls `refreshCustomerProfile` after each. |
| PR 131 | 279, 416 | Forward ledger data (`ledgerItems`, `loadingLedger`, `ledgerError`) into `MembershipsTab` and `AccountContext` so the re-mounted activity modal has data. |
| VAL-DISP-1 | 211, 434 | Resolve `validityDisplayUnit` from `tenant.branding`, forward into `MembershipsTab`, `PackagesTab`, `AccountTab`. Default `'days'` preserves pre-patch behavior. |
| PR-TAX-3 (Patch 143) | 298, 344 | Forward `tax_config` into `MembershipsTab` and `PackagesTab` so purchase modals render VAT + service-charge rows. |
| PR A1.1 | 295 | "See details" on membership statement banner → navigate to Account tab. |
| PR A1.2 | 341 | "See details" on packages statement banner → navigate to Account tab. |
| PR A1.3 | 390 | New context props wired into `MyAccountShell` (membership plans, package state, etc.). |
| PR A3.3 | 363 | Wire CTAs for new visual empty states on `BookingHistory`. |

## Method note for the implementation session

When you start the SectionRenderer implementation:

1. Re-run the patch-marker grep — comments rot:
   ```
   grep -nE "(?:PR|Patch|PR-)[ -]?(?:[A-Z]+[0-9]+[a-z]?|[0-9]+[a-z]?)|VAL-DISP-|FILL-BLOCK|REDESIGN-|PAY-|PR-LC|PR-CAT|PR-TAX" \
     components/public-booking/BookTab.tsx \
     components/public-booking/PublicBookingContent.tsx
   ```
2. Cross-check git blame on the file to catch any patch landed without
   a code marker.
3. Add new patches discovered to this doc as a follow-up commit. This
   file is meant to be living until the refactor lands.

## Cross-references

- `phase-5-3-tenant-inventory.md` — diff baseline.
- `phase-5-3-section-inventory.md` — section/component mismatch
  blockers.
- `phase-5-3-baseline-capture-extensions.md` — diff harness.
- `phase-5-3-rollback-plan.md` — fallback contract.
