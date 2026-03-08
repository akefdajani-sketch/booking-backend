# DSH-7 Targets and Benchmarks Contract

This patch adds dashboard targets, pacing, and benchmarks without a schema migration.

## Storage
Tenant-specific values are read from `tenants.branding.dashboard_widgets.targets`.

Example:
```json
{
  "dashboard_widgets": {
    "targets": {
      "day": { "bookings": 12, "revenue_amount": 250, "utilizationPct": 45, "repeatPct": 40, "noShowRateMax": 8 },
      "week": { "bookings": 70, "revenue_amount": 1800, "utilizationPct": 50, "repeatPct": 45, "noShowRateMax": 8 },
      "month": { "bookings": 240, "revenue_amount": 7000, "utilizationPct": 55, "repeatPct": 50, "noShowRateMax": 7 }
    }
  }
}
```

## Response additions
`GET /api/tenant/:slug/dashboard-summary` now returns:

- `targets.mode`
- `targets.elapsedFraction`
- `targets.goals`
- `targets.benchmarks`

Each benchmark contains:
- `target`
- `actual`
- `progressPct`
- `pacePct`
- `paceTarget`
- `status` (`ahead`, `on_track`, `behind`, `critical`, `no_target`)
- `direction` (`at_least` or `at_most`)

## Notes
- `noShowRateMax` is evaluated as a ceiling (`at_most`).
- All other targets are evaluated as floor goals (`at_least`).
- When the selected period is already complete, pace falls back to full-target completion.
