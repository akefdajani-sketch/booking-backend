-- migrations/032_maintenance_tickets.sql
-- PR-MAINT-1: Maintenance ticket system for rental properties.
--
-- Tenants (property managers) can log maintenance issues against resources
-- (units/rooms). Each ticket has a status lifecycle, optional assignment,
-- and a full audit trail via updated_at.
--
-- Design decisions:
--   - resource_id is NULLABLE so non-rental tenants can also log general
--     maintenance items not tied to a specific unit.
--   - booking_id is NULLABLE — tickets can arise from a guest stay or
--     independently (e.g. routine inspection).
--   - priority: low | medium | high | urgent
--   - status:   open | in_progress | resolved | closed
--   - Fully idempotent (IF NOT EXISTS / DO NOTHING guards).
--   - Soft-delete via is_active flag (consistent with rest of codebase).

-- ─── Core table ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS maintenance_tickets (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         BIGINT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  resource_id       BIGINT        REFERENCES resources(id) ON DELETE SET NULL,
  booking_id        BIGINT        REFERENCES bookings(id)  ON DELETE SET NULL,

  -- Content
  title             TEXT          NOT NULL,
  description       TEXT,
  priority          TEXT          NOT NULL DEFAULT 'medium'
                      CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  status            TEXT          NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),

  -- Assignment
  assigned_to_name  TEXT,           -- free-text (staff name or external contractor)
  assigned_to_email TEXT,

  -- Reporter (staff member who logged the ticket)
  reported_by_name  TEXT,
  reported_by_email TEXT,

  -- Resolution
  resolution_notes  TEXT,
  resolved_at       TIMESTAMPTZ,

  -- Soft delete
  is_active         BOOLEAN       NOT NULL DEFAULT TRUE,

  -- Timestamps
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────

-- Primary lookup: list all open tickets for a tenant
CREATE INDEX IF NOT EXISTS idx_maint_tenant_active
  ON maintenance_tickets (tenant_id, is_active, created_at DESC);

-- Filter by resource (unit/room)
CREATE INDEX IF NOT EXISTS idx_maint_resource
  ON maintenance_tickets (resource_id)
  WHERE resource_id IS NOT NULL AND is_active = TRUE;

-- Filter by status
CREATE INDEX IF NOT EXISTS idx_maint_status
  ON maintenance_tickets (tenant_id, status)
  WHERE is_active = TRUE;

-- Filter by priority
CREATE INDEX IF NOT EXISTS idx_maint_priority
  ON maintenance_tickets (tenant_id, priority)
  WHERE is_active = TRUE;

-- ─── updated_at trigger ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_maintenance_tickets_updated_at'
  ) THEN
    CREATE TRIGGER trg_maintenance_tickets_updated_at
      BEFORE UPDATE ON maintenance_tickets
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END;
$$;

-- ─── Comments ─────────────────────────────────────────────────────────────────

COMMENT ON TABLE maintenance_tickets IS
  'Maintenance issues logged by tenant staff against resources (units/rooms). PR-MAINT-1.';
COMMENT ON COLUMN maintenance_tickets.resource_id IS
  'Nullable — tickets can be general (not tied to a unit).';
COMMENT ON COLUMN maintenance_tickets.booking_id IS
  'Nullable — links ticket to the guest stay that surfaced the issue.';
COMMENT ON COLUMN maintenance_tickets.is_active IS
  'Soft delete — consistent with rest of codebase.';
