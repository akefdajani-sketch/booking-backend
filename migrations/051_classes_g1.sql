-- migrations/051_classes_g1.sql
-- G1: Group / class bookings.
-- v2 master plan §2.3 — time-slot-with-capacity bookings.
--
-- Adds:
--   1. services.is_class                   — flag
--   2. services.default_capacity           — default seats per session (NULL for non-class)
--   3. services.waitlist_enabled           — per-service waitlist toggle
--   4. instructors                         — first-class entity, separate from staff
--   5. class_sessions                      — concrete instance of a class at a datetime
--   6. class_session_seats                 — one row per customer reservation
--   7. class_session_waitlist              — waitlist with auto-promote on cancel
--   8. tenants.class_bookings_enabled      — feature toggle, gates UI
--
-- Idempotent via IF NOT EXISTS / DO blocks. Safe to re-run.

BEGIN;

-- ─── 1. tenants flag ──────────────────────────────────────────────────────────

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS class_bookings_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN tenants.class_bookings_enabled
  IS 'G1: enables group/class booking features for this tenant. UI gating axis.';

-- ─── 2. services capacity columns ─────────────────────────────────────────────

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS is_class BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS default_capacity INTEGER;

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS waitlist_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN services.is_class
  IS 'G1: when true, this service is bookable as group sessions with multiple seats per slot.';
COMMENT ON COLUMN services.default_capacity
  IS 'G1: default seat count when creating a new class session for this service. NULL for non-class services.';
COMMENT ON COLUMN services.waitlist_enabled
  IS 'G1: when true, full sessions accept waitlist signups that auto-promote on cancellation.';

-- Sanity: default_capacity must be positive when set
ALTER TABLE services
  ADD CONSTRAINT services_default_capacity_positive
  CHECK (default_capacity IS NULL OR default_capacity > 0)
  NOT VALID;
DO $$
BEGIN
  EXECUTE 'ALTER TABLE services VALIDATE CONSTRAINT services_default_capacity_positive';
EXCEPTION WHEN OTHERS THEN
  -- already validated or another path
  NULL;
END $$;

-- ─── 3. instructors ───────────────────────────────────────────────────────────
-- Separate from staff because instructors can:
--   - have public bios and photos
--   - exist without a dashboard login
--   - have multiple specialties
-- A staff member CAN be an instructor (link via instructor_id below). Or an
-- instructor can exist standalone (e.g. visiting yoga teacher).

CREATE TABLE IF NOT EXISTS instructors (
  id           SERIAL PRIMARY KEY,
  tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  bio          TEXT,
  photo_url    TEXT,
  email        TEXT,
  phone        TEXT,
  specialties  TEXT[],   -- e.g. ['yoga','pilates','spin']
  staff_id     INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_instructors_tenant
  ON instructors (tenant_id) WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_instructors_staff_link
  ON instructors (staff_id) WHERE staff_id IS NOT NULL;

COMMENT ON TABLE instructors IS
  'G1: first-class instructor entity. Public-facing (bio, photo). A staff record may link to an instructor via staff_id.';

-- ─── 4. class_sessions ────────────────────────────────────────────────────────
-- A concrete instance of a class at a specific datetime. Holds the capacity
-- and instructor; seats reference the session.

CREATE TABLE IF NOT EXISTS class_sessions (
  id              SERIAL PRIMARY KEY,
  tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  service_id      INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  instructor_id   INTEGER REFERENCES instructors(id) ON DELETE SET NULL,
  resource_id     INTEGER REFERENCES resources(id) ON DELETE SET NULL,
  start_time      TIMESTAMPTZ NOT NULL,
  end_time        TIMESTAMPTZ NOT NULL,
  capacity        INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'scheduled',
                  -- scheduled | cancelled | completed
  cancellation_reason TEXT,
  cancelled_at    TIMESTAMPTZ,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT class_sessions_end_after_start CHECK (end_time > start_time),
  CONSTRAINT class_sessions_capacity_positive CHECK (capacity > 0),
  CONSTRAINT class_sessions_status_valid
    CHECK (status IN ('scheduled','cancelled','completed'))
);

CREATE INDEX IF NOT EXISTS idx_class_sessions_tenant_time
  ON class_sessions (tenant_id, start_time);
CREATE INDEX IF NOT EXISTS idx_class_sessions_service
  ON class_sessions (service_id, start_time);
CREATE INDEX IF NOT EXISTS idx_class_sessions_instructor
  ON class_sessions (instructor_id, start_time)
  WHERE instructor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_class_sessions_active
  ON class_sessions (tenant_id, start_time)
  WHERE status = 'scheduled';

COMMENT ON TABLE class_sessions IS
  'G1: a concrete instance of a class service at a specific datetime, with capacity and instructor.';

-- ─── 5. class_session_seats ───────────────────────────────────────────────────
-- One row per booked seat. Replaces the bookings.id model for classes —
-- still has a parent booking row for billing, but the seat is the source
-- of truth for who's in the class.

CREATE TABLE IF NOT EXISTS class_session_seats (
  id                SERIAL PRIMARY KEY,
  tenant_id         INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id        INTEGER NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
  customer_id       INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  -- Optional pointer back to the bookings table for billing reuse.
  -- A booking row may represent payment for one seat or many (a parent
  -- buying seats for kids). For most seats this is set 1:1.
  booking_id        INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'confirmed',
                    -- confirmed | cancelled | no_show | checked_in
  amount_paid       NUMERIC(12,3) DEFAULT 0,
  currency_code     TEXT,
  -- Cancellation context
  cancelled_at      TIMESTAMPTZ,
  cancelled_by      TEXT,         -- 'customer' | 'staff' | 'system_auto'
  -- Check-in context
  checked_in_at     TIMESTAMPTZ,
  checked_in_by     INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  -- Membership credit reversal flag for class-pass logic
  credit_returned   BOOLEAN NOT NULL DEFAULT FALSE,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT class_session_seats_status_valid
    CHECK (status IN ('confirmed','cancelled','no_show','checked_in'))
);

-- One customer per session — prevents the same customer from booking
-- multiple seats in the same session (which is almost always a UI bug,
-- not intentional). If a tenant ever wants this, drop this index.
-- Partial: cancelled rows can coexist so a customer can rebook after cancelling.
CREATE UNIQUE INDEX IF NOT EXISTS idx_class_session_seats_one_per_customer
  ON class_session_seats (session_id, customer_id)
  WHERE status IN ('confirmed','checked_in');

CREATE INDEX IF NOT EXISTS idx_class_session_seats_session
  ON class_session_seats (session_id) WHERE status IN ('confirmed','checked_in');

CREATE INDEX IF NOT EXISTS idx_class_session_seats_customer
  ON class_session_seats (tenant_id, customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_class_session_seats_booking
  ON class_session_seats (booking_id) WHERE booking_id IS NOT NULL;

COMMENT ON TABLE class_session_seats IS
  'G1: a customer''s reservation of one seat in one class session.';

-- ─── 6. class_session_waitlist ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS class_session_waitlist (
  id            SERIAL PRIMARY KEY,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id    INTEGER NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
  customer_id   INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  -- Lifecycle:
  status        TEXT NOT NULL DEFAULT 'waiting',
                -- waiting | promoted | expired | cancelled
  promoted_at   TIMESTAMPTZ,
  promoted_seat_id INTEGER REFERENCES class_session_seats(id) ON DELETE SET NULL,
  cancelled_at  TIMESTAMPTZ,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT class_session_waitlist_status_valid
    CHECK (status IN ('waiting','promoted','expired','cancelled')),
  CONSTRAINT class_session_waitlist_position_positive
    CHECK (position > 0)
);

-- One customer per waitlist (active rows only — cancelled rows can coexist)
CREATE UNIQUE INDEX IF NOT EXISTS idx_class_session_waitlist_one_per_customer
  ON class_session_waitlist (session_id, customer_id)
  WHERE status = 'waiting';

CREATE INDEX IF NOT EXISTS idx_class_session_waitlist_session_pos
  ON class_session_waitlist (session_id, position)
  WHERE status = 'waiting';

CREATE INDEX IF NOT EXISTS idx_class_session_waitlist_customer
  ON class_session_waitlist (tenant_id, customer_id, created_at DESC);

COMMENT ON TABLE class_session_waitlist IS
  'G1: customers waiting on a full class session. Auto-promoted when a seat opens.';

-- ─── 7. trigger to keep updated_at fresh ──────────────────────────────────────
-- Reuse the existing trigger function from previous migrations if available.
-- We try, and fall back to NOTHING if not present.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at'
  ) THEN
    -- Attach to all four new tables
    EXECUTE 'CREATE TRIGGER set_instructors_updated_at
             BEFORE UPDATE ON instructors
             FOR EACH ROW EXECUTE FUNCTION set_updated_at()';
    EXECUTE 'CREATE TRIGGER set_class_sessions_updated_at
             BEFORE UPDATE ON class_sessions
             FOR EACH ROW EXECUTE FUNCTION set_updated_at()';
    EXECUTE 'CREATE TRIGGER set_class_session_seats_updated_at
             BEFORE UPDATE ON class_session_seats
             FOR EACH ROW EXECUTE FUNCTION set_updated_at()';
    EXECUTE 'CREATE TRIGGER set_class_session_waitlist_updated_at
             BEFORE UPDATE ON class_session_waitlist
             FOR EACH ROW EXECUTE FUNCTION set_updated_at()';
  END IF;
EXCEPTION WHEN duplicate_object THEN
  -- Triggers already exist from a prior partial run
  NULL;
END $$;

-- ─── 8. record migration ──────────────────────────────────────────────────────

INSERT INTO schema_migrations (filename, applied_at)
VALUES ('051_classes_g1.sql', NOW())
ON CONFLICT (filename) DO NOTHING;

COMMIT;
