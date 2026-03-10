-- 008_service_hours.sql
-- PR-SH1: Per-service time windows
-- Restricts a service to a subset of the tenant's business hours.
-- No rows for a service = no restriction (full business hours apply).

CREATE TABLE IF NOT EXISTS service_hours (
  id           SERIAL       PRIMARY KEY,
  service_id   INTEGER      NOT NULL REFERENCES services(id)  ON DELETE CASCADE,
  tenant_id    INTEGER      NOT NULL REFERENCES tenants(id)   ON DELETE CASCADE,
  day_of_week  INTEGER      NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  open_time    TIME         NOT NULL,
  close_time   TIME         NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_service_hours_nonzero CHECK (close_time <> open_time)
);

CREATE INDEX IF NOT EXISTS idx_service_hours_service_day
  ON service_hours (service_id, day_of_week);

CREATE INDEX IF NOT EXISTS idx_service_hours_tenant
  ON service_hours (tenant_id);
