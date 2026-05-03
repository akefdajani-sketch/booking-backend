-- booking-backend/tools/payment_method_audit.sql
--
-- Diagnostic queries for bookings.payment_method coverage. Run before and
-- after migration 063 to verify backfill landed as expected, and on a recurring
-- cadence to spot regression in the forward-write path.
--
-- Usage:
--   psql $DATABASE_URL -f booking-backend/tools/payment_method_audit.sql
--
-- All queries are read-only.

-- ─── Section 1: Distribution today ───────────────────────────────────────────
\echo '=== 1. payment_method distribution across all bookings ==='
SELECT
  COALESCE(payment_method, 'NULL') AS payment_method,
  COUNT(*)                          AS count,
  ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS pct
  FROM bookings
 GROUP BY payment_method
 ORDER BY count DESC;

-- ─── Section 2: For every NULL row, classify the most likely true method ────
-- This is the same logic as migration 063. Running it BEFORE the migration
-- shows what's about to be backfilled; running it AFTER shows residuals
-- (bookings 063 couldn't infer).
\echo ''
\echo '=== 2. NULL bookings broken down by inference bucket ==='
WITH null_bookings AS (
  SELECT id, tenant_id, price_amount, created_at
    FROM bookings
   WHERE payment_method IS NULL
)
SELECT
  CASE
    WHEN COALESCE(b.price_amount, 0) = 0
      THEN '1_free_zero_price'
    WHEN EXISTS (SELECT 1 FROM network_payments np
                  WHERE np.booking_id = b.id AND np.status = 'completed')
      THEN '2_card_completed_payment'
    WHEN EXISTS (SELECT 1 FROM membership_ledger ml
                  WHERE ml.booking_id = b.id AND ml.type = 'debit')
      THEN '3_membership_has_debit'
    WHEN EXISTS (SELECT 1 FROM prepaid_redemptions pr
                  WHERE pr.booking_id = b.id)
      THEN '4_package_has_redemption'
    ELSE '5_unknown_no_inference_possible'
  END  AS inference_bucket,
  COUNT(*) AS count
  FROM null_bookings b
 GROUP BY 1
 ORDER BY 1;

-- ─── Section 3: Trend of unrecoverable NULLs over time ──────────────────────
-- "Unrecoverable" = price > 0, no card payment record, no membership debit,
-- no package redemption. Either CliQ (manual bank transfer, no auto signal),
-- abandoned card payment, or pre-PAY-INTENT-1 cash without method tagging.
--
-- After PAY-INTENT-1 lands, this number should stop growing for new months.
\echo ''
\echo '=== 3. Unrecoverable NULLs by month (forward-fix verification) ==='
SELECT
  DATE_TRUNC('month', created_at)::date AS month,
  COUNT(*)                                AS unrecoverable_nulls
  FROM bookings b
 WHERE payment_method IS NULL
   AND COALESCE(price_amount, 0) > 0
   AND NOT EXISTS (SELECT 1 FROM network_payments  np WHERE np.booking_id = b.id AND np.status = 'completed')
   AND NOT EXISTS (SELECT 1 FROM membership_ledger ml WHERE ml.booking_id = b.id AND ml.type   = 'debit')
   AND NOT EXISTS (SELECT 1 FROM prepaid_redemptions pr WHERE pr.booking_id = b.id)
 GROUP BY 1
 ORDER BY 1 DESC
 LIMIT 24;

-- ─── Section 4: Per-tenant breakdown ─────────────────────────────────────────
-- Useful for spotting one tenant with a broken integration vs platform-wide.
\echo ''
\echo '=== 4. Top 10 tenants by NULL count ==='
SELECT
  t.slug                                            AS tenant_slug,
  COUNT(*) FILTER (WHERE b.payment_method IS NULL)  AS null_count,
  COUNT(*)                                          AS total_bookings,
  ROUND(100.0 * COUNT(*) FILTER (WHERE b.payment_method IS NULL) / COUNT(*), 1) AS null_pct
  FROM bookings b
  JOIN tenants  t ON t.id = b.tenant_id
 GROUP BY t.slug
HAVING COUNT(*) > 5    -- skip tiny tenants where ratios are noise
 ORDER BY null_count DESC
 LIMIT 10;

-- ─── Section 5: Check constraint health ──────────────────────────────────────
-- Ensures migration 062 landed and is doing its job.
\echo ''
\echo '=== 5. CHECK constraint status (migration 062) ==='
SELECT conname, pg_get_constraintdef(oid) AS definition
  FROM pg_constraint
 WHERE conrelid = 'bookings'::regclass
   AND conname  = 'bookings_payment_method_check';

-- ─── Section 6: Network payment linkage health ──────────────────────────────
-- A completed network_payment with a NULL booking_id means the customer
-- paid but we never closed the loop linking it to the booking. Should be 0.
\echo ''
\echo '=== 6. Orphaned completed payments (should be 0) ==='
SELECT COUNT(*) AS orphan_completed_payments
  FROM network_payments
 WHERE status     = 'completed'
   AND booking_id IS NULL;
