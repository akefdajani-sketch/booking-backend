# DSH-6 Personalization Contract

DSH-6 adds tenant-scoped dashboard personalization through `tenant.branding.dashboard_widgets`.

## Supported fields

```json
{
  "dashboard_widgets": {
    "layout": {
      "density": "compact|comfortable|expanded",
      "section_order": ["trends", "deep_dive", "operations"],
      "trends_order": ["bookings_over_time", "revenue_by_service"],
      "deep_dive_order": ["utilization", "customer_pulse"],
      "operations_order": ["next_up", "customer_pulse_panel", "rules_alerts", "insights"]
    },
    "bookings_over_time": { "visible": true },
    "revenue_by_service": { "visible": true },
    "utilization": { "visible": true },
    "customer_pulse": { "visible": true },
    "next_up": { "visible": true },
    "customer_pulse_panel": { "visible": true },
    "rules_alerts": { "visible": true },
    "insights": { "visible": true }
  }
}
```

## Backend metadata

`dashboardSummary.meta.personalizationDefaults` returns safe defaults so frontend shells can render even when no tenant overrides exist.

## Notes

- Hidden widgets do not change the backend data contract.
- Order arrays are sanitized on the frontend and missing widgets are appended automatically.
- Density is a UI concern only and does not alter metric calculations.
