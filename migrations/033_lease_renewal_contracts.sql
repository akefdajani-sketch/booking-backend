-- migrations/033_lease_renewal_contracts.sql
-- PR-LEASE-1 + PR-CONTRACT-1
--
-- Two independent additions in one idempotent migration:
--
--   1. lease_renewal_reminders  — dedup table so each WhatsApp renewal
--      reminder fires at most once per (resource, type, lease_end).
--
--   2. bookings.contract_url / contract_key — stores a signed PDF or
--      uploaded contract file against a booking.
--
-- Fully idempotent. Safe to run against production.

-- ─── 1. Lease renewal reminders dedup table ───────────────────────────────────
--
-- Reminder schedule (checked by reminderEngine.js on every hourly job run):
--   renewal_30d — 30 days before lease_end
--   renewal_14d — 14 days before lease_end
--   renewal_7d  — 7 days before lease_end
--   renewal_1d  — 1 day  before lease_end

CREATE TABLE IF NOT EXISTS lease_renewal_reminders (
  id              BIGSERIAL    PRIMARY KEY,
  resource_id     BIGINT       NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  tenant_id       BIGINT       NOT NULL REFERENCES tenants(id)   ON DELETE CASCADE,
  reminder_type   TEXT         NOT NULL
                    CHECK (reminder_type IN ('renewal_30d','renewal_14d','renewal_7d','renewal_1d')),
  -- Snapshot of the lease_end this reminder was fired for.
  -- If the owner updates lease_end, old reminders don't block the new schedule.
  lease_end_date  DATE         NOT NULL,
  sent_to         TEXT,            -- phone number used
  whatsapp_msg_id TEXT,
  ok              BOOLEAN      NOT NULL DEFAULT FALSE,
  error_reason    TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- One send per (resource, type, lease_end snapshot)
  CONSTRAINT uq_lease_reminder UNIQUE (resource_id, reminder_type, lease_end_date)
);

CREATE INDEX IF NOT EXISTS idx_lease_reminders_tenant
  ON lease_renewal_reminders (tenant_id, created_at DESC);

-- ─── 2. Booking contract attachment ──────────────────────────────────────────
--
-- contract_url  — public URL of the uploaded file (R2 / CDN)
-- contract_key  — storage key (for deletion / presigned URL generation)
-- contract_name — original filename shown in the UI

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS contract_url   TEXT,
  ADD COLUMN IF NOT EXISTS contract_key   TEXT,
  ADD COLUMN IF NOT EXISTS contract_name  TEXT;

COMMENT ON COLUMN bookings.contract_url  IS 'Public URL of the uploaded contract PDF. PR-CONTRACT-1.';
COMMENT ON COLUMN bookings.contract_key  IS 'R2 storage key for the contract file. PR-CONTRACT-1.';
COMMENT ON COLUMN bookings.contract_name IS 'Original filename shown to the property manager. PR-CONTRACT-1.';

-- Lightweight index to find bookings that have a contract attached
CREATE INDEX IF NOT EXISTS idx_bookings_contract
  ON bookings (tenant_id)
  WHERE contract_url IS NOT NULL;
