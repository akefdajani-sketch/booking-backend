# Phase 5.3 — Section Inventory (Scoping)

> **Scope confirmed in scoping Q&A:** the SectionRenderer refactors
> `components/public-booking/BookTab.tsx`, **not** the top-level
> `PublicBookingContent.tsx` tab dispatcher. The 6-tab dispatcher stays
> as-is; only the BOOK tab's composition becomes section-driven.

## Source of truth for the 8 supported types

`migrations/070_themes_v2_shells_layouts.sql:94-103` — `legacy_default`
layout, `supported_section_types_json`:

```
nav_header
hero
service_selector
service_grid
date_picker
time_slots
customer_form
footer
```

The same migration's `sections_json` lists 7 of those (everything except
`service_grid`) in this order: nav_header → hero → service_selector →
date_picker → time_slots → customer_form → footer.

## What BookTab.tsx actually renders today

Read of `components/public-booking/BookTab.tsx` (563L) below. The file
is one big render block gated by `paymentRedirecting` / `view` /
`customer / isProfileComplete` / `isNightlyService` flags. Top-level
children, in render order:

| Pos | What renders | Component / element | Conditional on | BookTab.tsx line |
|----:|--------------|---------------------|----------------|------------------|
| 1 | nav header text | `<HeaderText />` (passed as prop) | `!isPremium` only | 124 |
| 2 | payment-redirect spinner | inline JSX | `paymentRedirecting` | 126-169 |
| 3 | success confirmation modal | `<ConfirmationModal />` | `view === "confirmation" && confirmedBooking` | 171-201 |
| 4 | error banner | inline JSX | `!loading && error` | 205-219 |
| 5 | "no services configured" warning | inline JSX | `!loading && !error && services.length === 0` | 221-235 |
| 6 | **booking form (nightly)** | `<NightlyBookingFormCard />` | `customer && isProfileComplete && isNightlyService` | 245-304 |
| 6′ | **booking form (timeslot)** | `<BookingFormCard />` | `customer && isProfileComplete && !isNightlyService` | 307-379 |
| 7 | loading text | inline `<p>` | `loading` (gate fallback) | 382-384 |
| 8 | "complete your profile" prompt | inline `<p>` | `!loading && !isProfileComplete(customer)` | 386-389 |
| 9 | **pre-confirm summary modal** | `<ConfirmationModal preConfirm />` | controlled by `summaryOpen`; mounted unconditionally inside the `view !== "confirmation"` branch | 393-500 |
| 10 | "sign in from Account tab" caption | inline `<p>` | `services.length > 0 && !customer` | 502-513 |
| 11 | **Book Tab fill blocks (PR A4)** | `<BookTabFillBlocks />` (with `deriveBookTabBusinessType`) | `!loading && !error`; gated internally by `businessType` | 515-556 |

The booking form itself (#6 / #6′) is **not** composed of separate
`service_selector` + `date_picker` + `time_slots` + `customer_form`
children at the BookTab level — those are *internals* of
`<BookingFormCard>` / `<NightlyBookingFormCard>`. From BookTab's
perspective, the form is one component.

## Mapping to the 8 supported_section_types

| migration 070 type | BookTab equivalent | Match quality | Notes |
|---|---|---|---|
| `nav_header` | `<HeaderText />` (pos 1) | **partial** | Only renders when `!isPremium`. Premium tenants render nav in the page shell (outside BookTab). The SectionRenderer must replicate this conditional, or the seed must encode "premium tenants skip this section." |
| `hero` | none (standalone). Hero image is *inside* `<NightlyBookingFormCard />` via `defaultBannerSrc` (line 262-269); no hero on the timeslot variant. | **mismatch** | The seed's `hero` assumes a standalone hero section. BookTab today has no standalone hero. **BLOCKER**. |
| `service_selector` | internal to `<BookingFormCard />` (line 337 `services={services}`) | **mismatch** | Embedded, not a separate section. **BLOCKER** — see "Composition mismatch" below. |
| `service_grid` | closest analogue: `<BookTabFillBlocks />` "Book again" tiles (PR A4) — but those are gated by business-type and history, not a primary selector | **partial / questionable** | Not a 1:1. Likely the seed's `service_grid` is intended for tenants whose first impression is a grid (boutique-editorial layouts), which doesn't apply to legacy_default. |
| `date_picker` | internal to `<BookingFormCard />` (line 314 `selectedDate`, line 347 `setSelectedDate`) | **mismatch** | Embedded. **BLOCKER**. |
| `time_slots` | internal to `<BookingFormCard />` (line 343 `timeSlots`, line 358 `onToggleSlot`) | **mismatch** | Embedded. **BLOCKER**. |
| `customer_form` | NOT in BookTab. Customer authentication / profile lives in `AccountTab` (a separate top-level tab). BookTab gates on `isProfileComplete(customer)` and shows a "tap profile icon" prompt (line 386-389) | **mismatch** | Customer form ≠ BookTab's domain. **BLOCKER** — see "Cross-tab dependency" below. |
| `footer` | None in BookTab. Footer is in the page shell. | **OK** | Shell-level concern; out of BookTab refactor scope. |

## Composition mismatch — the headline blocker

The migration 070 seed assumes a **granular** composition: 7 ordered
sections, each addressable by ID, each enableable/disableable
independently. BookTab today renders a **monolithic** booking form
(`BookingFormCard` or `NightlyBookingFormCard`) whose contents
(service / date / time / payment) are not separately mountable.

To make the SectionRenderer work as the seed describes, one of two
things has to happen — **decision deferred to the implementation
session, not chosen here**:

1. **Extract first, render second.** Split `BookingFormCard` into
   discrete `<ServiceSelector />`, `<DatePicker />`, `<TimeSlots />`,
   `<CustomerForm />` (or equivalent) components. SectionRenderer then
   composes them in the order `sections_json` specifies. This is a
   real refactor of BookingFormCard, not a thin shim over BookTab. The
   regression surface widens significantly.

2. **Render the seed but keep the monolith.** Treat `service_selector`
   + `date_picker` + `time_slots` + `customer_form` as a single
   compound "booking_form" section in the legacy layout, and re-seed
   `legacy_default` to reflect that. This means amending the migration
   070 seed (or shipping a new migration) before the implementation
   session, **before** the renderer is written.

Option 2 is lower-risk; option 1 is closer to the brief's stated intent.

## Cross-tab dependency (customer_form)

`customer_form` in the seed implies the booking page composition can
include the customer-profile UI inline. Today, customer-profile UI is
exclusively in `AccountTab` (`components/booking/AccountTab.tsx`, not
extracted from BookTab). BookTab only checks `isProfileComplete(customer)`
and routes the user to AccountTab if not.

Possible reconciliations (also implementation-session decisions):

- Treat the seed's `customer_form` as referring to a non-existent
  not-yet-built inline auth shim; mark it as unimplemented in the
  registry and skip on render. Forward to AccountTab when needed.
- Build the inline auth shim now and wire it as a section. Larger
  scope; impacts `useCustomerAuth` and related hooks.

## BookTab features outside the 8 supported types (no seed equivalent)

These must be preserved by the SectionRenderer but have no entry in
`supported_section_types_json`. The renderer architecture must allow
for "non-section" content (modals + transient overlays + status banners)
to remain rendered alongside the section list, OR the supported types
must be expanded.

- **Payment-redirect spinner** (pos 2). Transient. Not a section.
- **Success confirmation modal** (pos 3). Overlay; opens on
  `view === "confirmation"`.
- **Pre-confirm summary modal** (pos 9). Overlay; opens on `summaryOpen`.
- **Error banner** (pos 4) and "no services configured" warning (pos 5).
  Status alerts; could plausibly be modeled as conditional sections OR
  remain ambient.
- **Loading / "complete your profile" / "sign in" prompts** (pos 7, 8,
  10). Empty-state copy.
- **`<BookTabFillBlocks />`** (pos 11). PR A4 addition; "Book again"
  tiles by business type. Closest seed analogue is `service_grid` but
  it's actually a *recent-history* re-book affordance, not a primary
  selector. Likely needs its own seed entry: `fill_blocks` or
  `quick_rebook`.

## Recommendation for the implementation session

1. **Decide composition strategy first**, before writing renderer code.
   Pick option 1 (extract first) or option 2 (compound section) above.
   Document the choice in `phase-5-3-implementation-plan.md` once it
   exists.

2. **Patch the seed** before the renderer ships. The current seed
   doesn't reflect what tenants actually render — if the renderer reads
   the seed literally, every tenant breaks. Either:
   - Add a new migration `072_themes_v2_legacy_default_v2.sql` that
     re-seeds `legacy_default` with sections that match BookTab, OR
   - Add a `booking_form_compound` supported type and a re-ordered
     `sections_json`.

3. **Treat modals + transient UI as non-section.** Add a clear contract
   in the SectionRenderer's API: it renders the ordered sections; the
   parent (BookTab itself or a thin wrapper) still owns the modal
   overlays and the redirect spinner. Don't try to model everything as
   a section.

## What this doc is NOT

- Not a renderer design. That's the implementation session's job.
- Not a re-seed proposal. It points out the seed/component mismatch and
  defers the resolution.
- Not exhaustive on BookingFormCard internals. The 4 embedded section
  types (service_selector, date_picker, time_slots, customer_form)
  could be enumerated further by reading BookingFormCard.tsx; that's
  premature here.

## Cross-references

- `phase-5-3-tenant-inventory.md` — what we're diffing against.
- `phase-5-3-patch-tracker.md` — preserved behavior contract.
- `phase-5-3-baseline-capture-extensions.md` — diff harness.
- `phase-5-3-rollback-plan.md` — fallback if any tenant shows a diff.
