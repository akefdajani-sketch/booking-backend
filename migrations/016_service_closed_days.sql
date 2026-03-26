CREATE TABLE IF NOT EXISTS service_closed_days (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  service_id BIGINT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (service_id, tenant_id, day_of_week)
);

CREATE INDEX IF NOT EXISTS idx_service_closed_days_lookup
  ON service_closed_days (tenant_id, service_id, day_of_week);
