# Migrations 052 + 055 — applied to production

**Date:** 2026-05-17
**Author:** ak (Session 2 — audit hygiene)
**Branch:** `hygiene/audit-cleanup-2026-05-17`

---

## Status

Both migrations are **already applied** to production. No action was required
in this session beyond verification and documentation.

| Migration | Filename | Applied at (UTC) |
| --- | --- | --- |
| 052 | `052_tenant_notification_toggles.sql` | 2026-05-15 18:27:16.858 |
| 055 | `055_customer_booking_emails.sql` | 2026-05-15 18:27:17.731 |

The May 14 schema-drift audit identified these as pending in prod. They were
applied 2026-05-15 — the same window the Render pre-deploy migration hook
landed (PR #463). The hook ran `npm run migrate` automatically on the next
deploy and picked them up. No manual SQL execution occurred.

## Verification (this session)

```
$ DATABASE_SSL=true npm run migrate:list
…
  ✓ 052_tenant_notification_toggles.sql
  ✓ 055_customer_booking_emails.sql
…
70 applied, 0 pending
```

### Tenant toggle columns (12 expected — 4 SMS + 4 WA + 4 email)

```
email_cancellations_enabled
email_confirmations_enabled
email_reminder_1h_enabled
email_reminder_24h_enabled
sms_cancellations_enabled
sms_confirmations_enabled
sms_reminder_1h_enabled
sms_reminder_24h_enabled
wa_cancellations_enabled
wa_confirmations_enabled
wa_reminder_1h_enabled
wa_reminder_24h_enabled
```

All 12 present.

### Bookings email-reminder dedup columns (2 expected)

```
email_reminder_sent_1h
email_reminder_sent_24h
```

Both present.

## Schema deltas

### 052 — `tenants` table (8 new columns)

- `sms_confirmations_enabled  BOOLEAN NOT NULL DEFAULT TRUE`
- `sms_reminder_24h_enabled   BOOLEAN NOT NULL DEFAULT TRUE`
- `sms_reminder_1h_enabled    BOOLEAN NOT NULL DEFAULT TRUE`
- `sms_cancellations_enabled  BOOLEAN NOT NULL DEFAULT TRUE`
- `wa_confirmations_enabled   BOOLEAN NOT NULL DEFAULT TRUE`
- `wa_reminder_24h_enabled    BOOLEAN NOT NULL DEFAULT TRUE`
- `wa_reminder_1h_enabled     BOOLEAN NOT NULL DEFAULT TRUE`
- `wa_cancellations_enabled   BOOLEAN NOT NULL DEFAULT TRUE`

### 055 — `tenants` table (4 new columns) + `bookings` table (2 new columns) + 2 partial indexes

`tenants`:
- `email_confirmations_enabled BOOLEAN NOT NULL DEFAULT TRUE`
- `email_reminder_24h_enabled  BOOLEAN NOT NULL DEFAULT TRUE`
- `email_reminder_1h_enabled   BOOLEAN NOT NULL DEFAULT TRUE`
- `email_cancellations_enabled BOOLEAN NOT NULL DEFAULT TRUE`

`bookings`:
- `email_reminder_sent_24h TIMESTAMPTZ`
- `email_reminder_sent_1h  TIMESTAMPTZ`

Partial indexes:
- `idx_bookings_email_reminder_pending_24h` (filter `status='confirmed' AND email_reminder_sent_24h IS NULL`)
- `idx_bookings_email_reminder_pending_1h`  (filter `status='confirmed' AND email_reminder_sent_1h IS NULL`)

## Behavior change

**None.** All new boolean columns default to `TRUE`, which preserves the
implicit pre-migration behavior (every notification fires when credentials
+ plan allow). A tenant who wants to suppress an event now flips the
relevant toggle to `FALSE`.

## Production bugs closed

The May 14 audit flagged two prod incidents driven by the missing schema:

1. **Owner notification-settings PATCH returning 500.** The PATCH handler
   tried to write to `tenants.sms_confirmations_enabled` and similar columns
   that didn't exist in prod. With 052 applied, the columns are present and
   the PATCH succeeds.

2. **Customer email reminders throwing exceptions.** The reminder engine
   tried to update `bookings.email_reminder_sent_24h` / `_1h` to mark a
   reminder as sent. Without those columns the UPDATE failed. With 055
   applied, dedup stamps land cleanly and the engine no longer throws.

Both bugs require a code-path test to confirm they are clear in production,
but the underlying schema cause is resolved.

## Follow-up

- Confirm the next deploy of the booking-frontend owner-settings page can
  PATCH notification toggles without a 500.
- Confirm the next scheduled email-reminder cron run does not throw.
- Update the May 14 schema-drift audit (`audit/2026-05-14/booking-backend.md`)
  to reference this resolution.
