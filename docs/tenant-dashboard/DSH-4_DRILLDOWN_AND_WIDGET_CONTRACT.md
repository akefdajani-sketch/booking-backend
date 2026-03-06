# DSH-4 Drill-down + Widget Contract

## Purpose
DSH-4 adds drill-down routing metadata and widget-level support metadata without breaking the existing dashboard payload.

## New payload sections

### `meta.widgetSupport`
Signals whether a widget is backed by data in the current tenant/range.

### `meta.widgetVisibilityDefaults`
Server-safe defaults for widgets before tenant appearance overrides are applied.

### `drilldowns`
Relative application routes that the frontend can use for operational navigation.

Example:

```json
{
  "drilldowns": {
    "bookings": { "href": "/birdie?tab=bookings&from=...&to=..." },
    "utilization": { "href": "/birdie?tab=dayview&date=2026-03-07&focus=utilization" },
    "repeatCustomers": { "href": "/birdie?tab=customers&segment=returning" }
  }
}
```

## Backwards compatibility
- Existing `kpis`, `panels`, `utilization`, and `series` blocks remain unchanged.
- Frontend must treat `drilldowns` as optional and fall back to local route builders if missing.
