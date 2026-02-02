# TEST_MATRIX_THEMES_LAYOUTS.md
_Last updated: 2026-02-02_

This matrix defines the **minimum acceptance tests** required whenever:
- a theme pack changes
- a layout changes
- Theme Studio preview/publish changes

---

## A) Booking Engine (must never regress)
1. Multi-slot selection works (customer)
2. Multi-slot selection works (owner manual booking)
3. Service controls slot granularity (`slot_interval_minutes`)
4. Booking duration stored equals selected slots × interval
5. Tenant isolation verified (no cross-tenant data)

---

## B) Public Booking Layouts (per layout key)
Run on each key:
- `classic`
- `premium`
- `premium_light`
- `modern`
- `minimal`

Checklist:
1. No “flash” (SSR tokens applied)
2. Hero/banner renders
3. Tabs: Home/Book/Reservations/Memberships/Account load
4. Booking form completes successfully
5. Reservations list renders for signed-in customer
6. Memberships section renders
7. Account section renders

---

## C) Theme Studio (Phase 3)
1. Preview shows draft instantly
2. Publish updates public (after cache TTL)
3. Reset to default works
4. Premium cannot be broken by allowed controls
