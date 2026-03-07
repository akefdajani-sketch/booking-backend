# DSH-5 Alerts Intelligence Contract

## Goal
Deepen dashboard alerts so they act like an operations assistant, not just a list of warnings.

## Backend shape
`panels.alerts[]` entries may include:
- `id`
- `severity` = `info | warning | critical`
- `category` = `ops | setup`
- `title`
- `body`
- `why`
- `ctaLabel`
- `ctaAction`
- `href`
- `metricValue`
- `thresholdValue`
- `cooldownHours`
- `suppressed`

## Current alert families
- capacity underuse
- revenue drop
- booking drop
- repeat-customer decline
- no-show spike
- pending backlog
- cancellation spike
- retention risk
- setup/config warnings

## Notes
- Alerts are deduped by `id`.
- Critical alerts sort ahead of warning and info alerts.
- Cooldown is metadata for UI and future persistence.
- Existing `panels.rules` remains for backward compatibility.
