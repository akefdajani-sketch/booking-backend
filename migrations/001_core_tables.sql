-- migrations/001_core_tables.sql
-- PR-5: Migration System + DB Integrity
--
-- Baseline schema for core booking platform tables.
-- These tables may already exist in production — all statements use
-- CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS so this is
-- fully idempotent and safe to run against an existing database.

-- ─── tenants ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  admin_email   TEXT,
  branding      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenants_slug ON tenants (slug);

-- ─── users ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT,
  google_sub    TEXT UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── services ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS services (
  id                        SERIAL PRIMARY KEY,
  tenant_id                 INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                      TEXT NOT NULL,
  duration_minutes          INTEGER NOT NULL DEFAULT 60,
  slot_interval_minutes     INTEGER,
  max_consecutive_slots     INTEGER,
  price                     NUMERIC,
  currency_code             TEXT DEFAULT 'USD',
  is_active                 BOOLEAN NOT NULL DEFAULT true,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_services_tenant ON services (tenant_id);

-- ─── staff ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS staff (
  id          SERIAL PRIMARY KEY,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  email       TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staff_tenant ON staff (tenant_id);

-- ─── resources ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS resources (
  id          SERIAL PRIMARY KEY,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  capacity    INTEGER NOT NULL DEFAULT 1,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_resources_tenant ON resources (tenant_id);

-- ─── customers ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customers (
  id          SERIAL PRIMARY KEY,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  email       TEXT,
  phone       TEXT,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customers_tenant ON customers (tenant_id);

-- ─── bookings ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bookings (
  id                SERIAL PRIMARY KEY,
  tenant_id         INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id       INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  service_id        INTEGER REFERENCES services(id) ON DELETE SET NULL,
  staff_id          INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  resource_id       INTEGER REFERENCES resources(id) ON DELETE SET NULL,
  start_time        TIMESTAMPTZ NOT NULL,
  end_time          TIMESTAMPTZ NOT NULL,
  duration_minutes  INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bookings_end_after_start CHECK (end_time > start_time)
);

CREATE INDEX IF NOT EXISTS idx_bookings_tenant        ON bookings (tenant_id);
CREATE INDEX IF NOT EXISTS idx_bookings_tenant_time   ON bookings (tenant_id, start_time);
CREATE INDEX IF NOT EXISTS idx_bookings_customer      ON bookings (customer_id);
CREATE INDEX IF NOT EXISTS idx_bookings_service       ON bookings (service_id);
CREATE INDEX IF NOT EXISTS idx_bookings_staff         ON bookings (staff_id);
CREATE INDEX IF NOT EXISTS idx_bookings_resource      ON bookings (resource_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status        ON bookings (tenant_id, status);
