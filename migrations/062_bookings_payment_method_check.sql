-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 062: Backfill missing CHECK constraint on bookings.payment_method
--
-- Found via the May 2026 DB schema audit (booking-backend/docs/DB_SCHEMA_SNAPSHOT.md):
-- the defensive ensurePaymentMethodColumn() helper (utils/ensurePaymentMethodColumn.js)
-- ALTERs `bookings ADD COLUMN IF NOT EXISTS payment_method TEXT CHECK (...)`. The
-- column was created elsewhere first (likely migration 019), so the IF NOT EXISTS
-- branch skipped the entire ALTER — and the CHECK constraint with it.
--
-- Effect today: the bookings.payment_method column accepts any string value.
-- Nothing currently writes garbage, but the validation is missing.
--
-- Audit also found 412 of 657 bookings (63%) currently have payment_method=NULL,
-- predominantly card/cliq bookings awaiting webhook backfill from the gateway.
-- NULL must remain valid pending the webhook fix (separate concern).
--
-- This migration adds the CHECK with NOT VALID — new writes are validated
-- immediately, but no historical scan happens. We can run VALIDATE CONSTRAINT
-- in a low-traffic window after spot-checking history if desired.
--
-- Idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.bookings'::regclass
      AND conname  = 'bookings_payment_method_check'
  ) THEN
    ALTER TABLE bookings
      ADD CONSTRAINT bookings_payment_method_check
      CHECK (
        payment_method IS NULL
        OR payment_method IN ('card', 'cliq', 'cash', 'membership', 'package', 'free')
      )
      NOT VALID;
  END IF;
END $$;

COMMIT;
