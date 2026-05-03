-- Migration 064: Track booking payment_status separately from payment_method
--
-- ─── CONTEXT ─────────────────────────────────────────────────────────────────
--
-- After WEBHOOK-PAYMENT-METHOD-BACKFILL-1, bookings.payment_method records
-- customer INTENT (the method they chose). But "intent to pay via CliQ" is
-- not the same as "operator confirmed the bank transfer landed." Until now
-- the system has had no place to record that distinction:
--
--   - card  → MPGS gateway autoconfirms (writes payment_method = 'card')
--   - cliq  → bank transfer; manual; nothing in the system tracks receipt
--   - cash  → taken at venue; nothing in the system tracks "no-show didn't pay"
--
-- This migration adds the missing field. payment_status is the canonical
-- truth of "did the money actually move":
--
--   pending    — booking created with intent to pay; not yet settled
--   completed  — money received (or auto-settled for membership/package/free)
--   failed     — gateway rejected, or operator marked unpaid
--   refunded   — money returned to customer
--   NULL       — historical pre-PAY-INTENT-1 bookings; unknown
--
-- Plus three audit fields on the same row (operator accountability, cheaper
-- than a separate booking_payment_log table for MVP — can be split later if
-- multi-state-history becomes needed):
--
--   payment_confirmed_by_user_id  — who clicked "Mark Received"
--   payment_confirmed_at          — when
--   payment_reference             — optional bank ref / receipt #
--
-- ─── BACKFILL RULES ──────────────────────────────────────────────────────────
--
-- For existing bookings, infer payment_status from payment_method + cross-refs:
--
--   payment_method IN ('membership','package','free')  → 'completed'
--     (these settle at booking creation; the act of booking IS the payment)
--
--   payment_method = 'cash'                            → 'completed'
--     (operator convention: cash is taken at the venue. If a no-show didn't
--      pay, operator can patch payment_status='failed' via the new endpoint.)
--
--   payment_method = 'card' AND completed network_payment exists → 'completed'
--   payment_method = 'card' AND no completed network_payment    → 'pending'
--
--   payment_method = 'cliq'                            → 'pending'
--     (CliQ always requires operator confirmation. There is no automated
--      bank webhook in scope.)
--
--   payment_method IS NULL → leave NULL (the historical 404 unrecoverable rows)
--
-- Idempotent: every UPDATE has WHERE payment_status IS NULL.

BEGIN;

-- ── 1. Schema ────────────────────────────────────────────────────────────────

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS payment_status                  TEXT,
  ADD COLUMN IF NOT EXISTS payment_confirmed_by_user_id    INTEGER,
  ADD COLUMN IF NOT EXISTS payment_confirmed_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payment_reference               TEXT;

-- FK on payment_confirmed_by_user_id (separate ALTER so IF NOT EXISTS works
-- on the column even when the FK already exists from a prior partial run).
DO $fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'bookings'::regclass
       AND conname  = 'bookings_payment_confirmed_by_user_id_fkey'
  ) THEN
    ALTER TABLE bookings
      ADD CONSTRAINT bookings_payment_confirmed_by_user_id_fkey
      FOREIGN KEY (payment_confirmed_by_user_id)
      REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $fk$;

-- CHECK constraint on payment_status values.
DO $chk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'bookings'::regclass
       AND conname  = 'bookings_payment_status_check'
  ) THEN
    ALTER TABLE bookings
      ADD CONSTRAINT bookings_payment_status_check
      CHECK (payment_status IS NULL
             OR payment_status IN ('pending', 'completed', 'failed', 'refunded'));
  END IF;
END $chk$;

-- Index for "show me all CliQ bookings awaiting confirmation" — the most
-- common operator query. Partial index keeps it tiny.
CREATE INDEX IF NOT EXISTS idx_bookings_pending_payment
  ON bookings (tenant_id, payment_method, created_at DESC)
  WHERE payment_status = 'pending';

-- ── 2. Backfill ──────────────────────────────────────────────────────────────

-- 2a. membership/package/free → 'completed'
UPDATE bookings
   SET payment_status = 'completed',
       updated_at     = NOW()
 WHERE payment_status IS NULL
   AND payment_method IN ('membership', 'package', 'free');

-- 2b. cash → 'completed'
UPDATE bookings
   SET payment_status = 'completed',
       updated_at     = NOW()
 WHERE payment_status IS NULL
   AND payment_method = 'cash';

-- 2c. card with completed network_payment → 'completed'
UPDATE bookings b
   SET payment_status = 'completed',
       updated_at     = NOW()
  FROM network_payments np
 WHERE b.payment_status IS NULL
   AND b.payment_method = 'card'
   AND b.id        = np.booking_id
   AND b.tenant_id = np.tenant_id
   AND np.status   = 'completed';

-- 2d. card without completed network_payment → 'pending'
UPDATE bookings
   SET payment_status = 'pending',
       updated_at     = NOW()
 WHERE payment_status IS NULL
   AND payment_method = 'card';

-- 2e. cliq → 'pending' (always needs operator confirmation)
UPDATE bookings
   SET payment_status = 'pending',
       updated_at     = NOW()
 WHERE payment_status IS NULL
   AND payment_method = 'cliq';

-- ── 3. Diagnostic output ────────────────────────────────────────────────────

DO $report$
DECLARE
  rec RECORD;
BEGIN
  RAISE NOTICE '[064] Backfill complete. payment_status distribution:';
  FOR rec IN
    SELECT COALESCE(payment_status, 'NULL') AS status, COUNT(*) AS count
      FROM bookings
     GROUP BY payment_status
     ORDER BY count DESC
  LOOP
    RAISE NOTICE '[064]   % : %', rec.status, rec.count;
  END LOOP;
END $report$;

COMMIT;
