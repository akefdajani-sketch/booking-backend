-- Migration 063: Backfill bookings.payment_method from inferable sources
--
-- ─── CONTEXT ─────────────────────────────────────────────────────────────────
--
-- The DB audit (May 3-4, 2026) revealed that 412 of 657 bookings (63%) have
-- payment_method = NULL. Causes break down into four buckets:
--
--   1. Pre-PAY-2 bookings (column added in migration 019, 2025-Q4) — created
--      before the column existed. Pure historical data.
--
--   2. CliQ bookings — actively broken until WEBHOOK-PAYMENT-METHOD-BACKFILL-1
--      patches routes/bookings/create.js. The old code only set payment_method
--      = 'cliq' when networkPaymentOrderId was present, but CliQ never has an
--      order ID (it's a manual bank transfer, not a gateway transaction).
--      So every CliQ booking landed with NULL.
--
--   3. Card bookings where the gateway result page didn't reach the success
--      endpoint (mobile abandonment, network drops). The MPGS callback at
--      routes/networkPayments.js:254 only fires on verified-success.
--
--   4. Cash bookings where the legacy frontend didn't send paymentMethod='cash'
--      in the create-booking request body.
--
-- This migration backfills (1)-(4) where we can prove what payment method was
-- used by cross-referencing other tables. The forward fix in bookings/create.js
-- prevents new NULLs from accumulating.
--
-- ─── INFERENCE RULES ─────────────────────────────────────────────────────────
--
--   network_payments.status='completed' + booking_id link  → 'card'
--   membership_ledger.type='debit' with booking_id        → 'membership'
--   prepaid_redemptions row with booking_id               → 'package'
--   bookings.price_amount = 0 (or NULL)                   → 'free'
--
-- Idempotent: every UPDATE has `WHERE payment_method IS NULL` so re-running
-- the migration is safe.
--
-- Safe: no DELETEs, no schema changes. Honors the CHECK constraint added by
-- migration 062 (only ever writes 'card'/'cliq'/'cash'/'membership'/'package'/'free').
--
-- After running this, a residual set of NULLs is expected — those are
-- bookings we cannot prove the payment method for (likely abandoned card
-- attempts or legacy cash bookings without client-side method tagging).
-- Run booking-backend/tools/payment_method_audit.sql to see the breakdown.
--
-- ─── EXECUTION ──────────────────────────────────────────────────────────────

BEGIN;

-- Sanity: verify required tables exist before running.
DO $check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='bookings') THEN
    RAISE EXCEPTION '[063] bookings table missing — aborting';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='bookings'
                    AND column_name='payment_method') THEN
    RAISE EXCEPTION '[063] bookings.payment_method missing — apply migration 019 first';
  END IF;
END $check$;

-- ── Pre-fix counts (for the migration log) ──────────────────────────────────
DO $pre$
DECLARE
  v_null_total INTEGER;
  v_grand_total INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_null_total
    FROM bookings WHERE payment_method IS NULL;
  SELECT COUNT(*) INTO v_grand_total FROM bookings;
  RAISE NOTICE '[063] Pre-backfill: % of % bookings have payment_method = NULL',
               v_null_total, v_grand_total;
END $pre$;

-- ─── 1. Free bookings (price = 0) ────────────────────────────────────────────
-- Safe ordering rationale: do this first because it's the broadest match and
-- doesn't conflict with any other inference rule (a price=0 booking can't have
-- a card payment, membership debit, or package redemption recorded).
WITH updated AS (
  UPDATE bookings
     SET payment_method = 'free',
         updated_at     = NOW()
   WHERE payment_method IS NULL
     AND COALESCE(price_amount, 0) = 0
   RETURNING id
)
SELECT 'free' AS bucket, COUNT(*) AS rows_updated FROM updated;

-- ─── 2. Card bookings (completed network_payment with this booking_id) ──────
WITH updated AS (
  UPDATE bookings b
     SET payment_method = 'card',
         updated_at     = NOW()
    FROM network_payments np
   WHERE b.payment_method IS NULL
     AND b.id        = np.booking_id
     AND b.tenant_id = np.tenant_id
     AND np.status   = 'completed'
   RETURNING b.id
)
SELECT 'card' AS bucket, COUNT(*) AS rows_updated FROM updated;

-- ─── 3. Membership bookings (debit row in membership_ledger) ─────────────────
-- A 'debit' row with non-null booking_id is the canonical signal that this
-- booking was paid for by deducting from a customer's membership balance.
WITH updated AS (
  UPDATE bookings b
     SET payment_method = 'membership',
         updated_at     = NOW()
   WHERE b.payment_method IS NULL
     AND EXISTS (
       SELECT 1 FROM membership_ledger ml
        WHERE ml.tenant_id  = b.tenant_id
          AND ml.booking_id = b.id
          AND ml.type       = 'debit'
     )
   RETURNING b.id
)
SELECT 'membership' AS bucket, COUNT(*) AS rows_updated FROM updated;

-- ─── 4. Package bookings (row in prepaid_redemptions) ───────────────────────
WITH updated AS (
  UPDATE bookings b
     SET payment_method = 'package',
         updated_at     = NOW()
   WHERE b.payment_method IS NULL
     AND EXISTS (
       SELECT 1 FROM prepaid_redemptions pr
        WHERE pr.tenant_id  = b.tenant_id
          AND pr.booking_id = b.id
     )
   RETURNING b.id
)
SELECT 'package' AS bucket, COUNT(*) AS rows_updated FROM updated;

-- ── Post-fix counts (for the migration log) ──────────────────────────────────
DO $post$
DECLARE
  v_null_total  INTEGER;
  v_grand_total INTEGER;
  v_pct         NUMERIC;
BEGIN
  SELECT COUNT(*) INTO v_null_total FROM bookings WHERE payment_method IS NULL;
  SELECT COUNT(*) INTO v_grand_total FROM bookings;
  v_pct := ROUND(100.0 * v_null_total / NULLIF(v_grand_total, 0), 1);
  RAISE NOTICE '[063] Post-backfill: % of % bookings still NULL (%%)',
               v_null_total, v_grand_total, v_pct;
  RAISE NOTICE '[063] Remaining NULLs are unrecoverable: no completed payment, no membership debit, no package redemption.';
  RAISE NOTICE '[063] To investigate residuals: run booking-backend/tools/payment_method_audit.sql';
END $post$;

COMMIT;
