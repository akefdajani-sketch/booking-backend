-- migrations/037_dashboard_performance_indexes.sql
-- PR 146: Composite indexes targeting the dashboard-summary query shape
--
-- Background:
--   /api/tenant/:slug/dashboard-summary executes ~60 queries against the
--   bookings table, most of them shaped like:
--     SELECT ... FROM bookings b
--     WHERE b.tenant_id = $1
--       AND b.start_time >= $2
--       AND b.deleted_at IS NULL
--       AND b.status = '...'   -- or IN (...)
--
--   Existing indexes:
--     idx_bookings_tenant_time   (tenant_id, start_time)                — m001
--     idx_bookings_active        (tenant_id, start_time) PARTIAL        — m007
--     idx_bookings_active_customer (tenant_id, customer_id) PARTIAL    — m007
--     idx_bookings_status        (tenant_id, status)                    — m001
--
--   The existing indexes cover tenant+time and tenant+status separately,
--   but not the combined (tenant, status, time) that the dashboard
--   frequently uses for "confirmed bookings in window" counts + sums.
--
-- What this migration adds:
--   1. idx_bookings_tenant_status_time — composite for the most common
--      dashboard query shape: tenant + status + start_time range, restricted
--      to non-deleted rows via a partial index.
--   2. idx_bookings_tenant_staff_time — composite for the staff-scoped path
--      (staff-role users seeing only their own counts). Partial on deleted_at.
--
-- Expected impact:
--   On birdie-golf with ~500 bookings, baseline 1.6–1.8s per dashboard
--   summary call. With these indexes, target is <500ms. Actual gain depends
--   on planner choices — verify with EXPLAIN ANALYZE (see README).
--
-- Fully idempotent. Safe to run against production multiple times.

-- Drop any stale versions to force a clean plan (safe: IF EXISTS).
-- Skipping drops here — the CREATE IF NOT EXISTS covers idempotency.

-- ─── 1. Composite: (tenant_id, status, start_time) for active bookings ───────
CREATE INDEX IF NOT EXISTS idx_bookings_tenant_status_time_active
  ON bookings (tenant_id, status, start_time)
  WHERE deleted_at IS NULL;

COMMENT ON INDEX idx_bookings_tenant_status_time_active IS
  'PR 146: covers dashboard-summary queries filtering by tenant + status + time window. Partial on deleted_at.';

-- ─── 2. Composite: (tenant_id, staff_id, start_time) for staff-scoped views ──
CREATE INDEX IF NOT EXISTS idx_bookings_tenant_staff_time_active
  ON bookings (tenant_id, staff_id, start_time)
  WHERE deleted_at IS NULL AND staff_id IS NOT NULL;

COMMENT ON INDEX idx_bookings_tenant_staff_time_active IS
  'PR 146: covers staff-scoped dashboard queries where req.isStaffScoped = true. Partial on deleted_at + non-null staff_id.';

-- ─── 3. Composite: (tenant_id, resource_id, start_time) for resource-scoped ──
-- Also feeds the patch 122 "top resources" / breakdown queries.
CREATE INDEX IF NOT EXISTS idx_bookings_tenant_resource_time_active
  ON bookings (tenant_id, resource_id, start_time)
  WHERE deleted_at IS NULL AND resource_id IS NOT NULL;

COMMENT ON INDEX idx_bookings_tenant_resource_time_active IS
  'PR 146: covers resource-utilization breakdown queries in dashboard-summary + /bookings/stats (PR 122). Partial on deleted_at + non-null resource_id.';

-- ─── 4. ANALYZE bookings so planner picks up new indexes immediately ─────────
-- Not wrapped in a transaction because ANALYZE in PG ≥ 12 doesn't require one.
ANALYZE bookings;
