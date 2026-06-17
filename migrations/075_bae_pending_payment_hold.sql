-- 075: BAE pending-payment hold support.
-- Option B: reuse status='pending' (slot-hold already works); add expiry timestamp.
-- A BAE hold = status='pending' + payment_status='pending' + payment_reference=<MRC>
--   + payment_method='card' + payment_hold_expires_at set. (All other cols exist since 064.)
-- NO BEGIN/COMMIT here — migrate runner wraps each file in its own transaction.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS payment_hold_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_bookings_payment_hold_expiry
  ON bookings (payment_hold_expires_at)
  WHERE payment_hold_expires_at IS NOT NULL AND status = 'pending';
