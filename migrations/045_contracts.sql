-- migrations/045_contracts.sql
-- G2a-1: Long-term contracts — main contracts table.
--
-- Status machine:
--   draft → pending_signature → signed → active
--                                 ↓
--                           completed | terminated | expired | cancelled
--
-- Monetary amounts: NUMERIC(12,3) to match bookings.total_amount,
-- resources.monthly_rate, rental_payment_links.amount_requested.
-- (tenant_invoices uses INTEGER cents for SaaS billing — different axis.)
--
-- Currency: currency_code TEXT len=3 to match bookings/tenants/rental_*.
--
-- PDF fields:
--   generated_pdf_*  = Flexrz-generated unsigned contract PDF (R2-hosted).
--   signed_pdf_*     = customer-signed scan, uploaded by tenant after
--                      wet-sign. Distinct from bookings.contract_url
--                      (which is a per-booking uploaded attachment).
--
-- Exclusion constraint prevents overlapping signed/active contracts on
-- the same resource. Draft/pending_signature/completed/cancelled rows
-- do not participate.
--
-- Fully idempotent.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS contracts (
  id                            BIGSERIAL    PRIMARY KEY,
  tenant_id                     INTEGER      NOT NULL REFERENCES tenants(id)   ON DELETE CASCADE,
  contract_number               TEXT         NOT NULL,

  customer_id                   INTEGER      NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  resource_id                   INTEGER      NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
  booking_id                    INTEGER      REFERENCES bookings(id)           ON DELETE SET NULL,

  start_date                    DATE         NOT NULL,
  end_date                      DATE         NOT NULL,

  monthly_rate                  NUMERIC(12,3) NOT NULL,
  total_value                   NUMERIC(12,3) NOT NULL,
  security_deposit              NUMERIC(12,3) NOT NULL DEFAULT 0,
  currency_code                 TEXT          NOT NULL,

  payment_schedule_template_id  BIGINT        REFERENCES payment_schedule_templates(id) ON DELETE SET NULL,
  payment_schedule_snapshot     JSONB,

  status                        TEXT          NOT NULL DEFAULT 'draft',
  terminated_reason             TEXT,
  terminated_at                 TIMESTAMPTZ,

  signed_at                     TIMESTAMPTZ,
  signed_by_name                TEXT,
  signature_method              TEXT,  -- 'manual' | 'dropbox_sign' | 'docusign'

  -- Flexrz-generated unsigned PDF (served from R2)
  generated_pdf_url             TEXT,
  generated_pdf_key             TEXT,
  generated_pdf_hash            TEXT,  -- SHA-256 hex of the PDF bytes

  -- Customer-signed upload (wet-sign scan)
  signed_pdf_url                TEXT,
  signed_pdf_key                TEXT,

  auto_release_on_expiry        BOOLEAN       NOT NULL DEFAULT FALSE,

  notes                         TEXT,
  terms                         TEXT,

  created_by                    INTEGER       REFERENCES staff(id) ON DELETE SET NULL,
  created_at                    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_contracts_number
    UNIQUE (contract_number),
  CONSTRAINT chk_contracts_status
    CHECK (status IN ('draft','pending_signature','signed','active',
                      'completed','terminated','expired','cancelled')),
  CONSTRAINT chk_contracts_date_order
    CHECK (end_date > start_date),
  CONSTRAINT chk_contracts_currency_len
    CHECK (length(currency_code) = 3),
  CONSTRAINT chk_contracts_money_nonneg
    CHECK (monthly_rate >= 0 AND total_value >= 0 AND security_deposit >= 0),
  CONSTRAINT chk_contracts_terminated_has_timestamp
    CHECK ((status <> 'terminated') OR (terminated_at IS NOT NULL)),
  CONSTRAINT chk_contracts_signed_has_timestamp
    CHECK ((status NOT IN ('signed','active','completed','terminated'))
           OR (signed_at IS NOT NULL)),
  CONSTRAINT chk_contracts_signature_method
    CHECK (signature_method IS NULL
           OR signature_method IN ('manual','dropbox_sign','docusign')),
  CONSTRAINT chk_contracts_generated_pdf_hash_len
    CHECK (generated_pdf_hash IS NULL OR length(generated_pdf_hash) = 64)
);

CREATE INDEX IF NOT EXISTS idx_contracts_tenant_status
  ON contracts (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_contracts_tenant_customer
  ON contracts (tenant_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_contracts_tenant_resource
  ON contracts (tenant_id, resource_id);
CREATE INDEX IF NOT EXISTS idx_contracts_tenant_active_window
  ON contracts (tenant_id, start_date, end_date)
  WHERE status IN ('signed', 'active');
CREATE INDEX IF NOT EXISTS idx_contracts_booking_id
  ON contracts (booking_id)
  WHERE booking_id IS NOT NULL;

-- Prevents two active/signed contracts overlapping on the same resource.
-- Drop-and-add so re-runs against a populated table still idempotent.
ALTER TABLE contracts
  DROP CONSTRAINT IF EXISTS excl_contracts_no_overlap;
ALTER TABLE contracts
  ADD CONSTRAINT excl_contracts_no_overlap
  EXCLUDE USING gist (
    resource_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  )
  WHERE (status IN ('signed', 'active'));

COMMENT ON TABLE contracts IS
  'G2a: Long-term rental contracts. Supplements resources.lease_* fields; kept in sync via utils/contracts.js.';
COMMENT ON COLUMN contracts.contract_number IS
  'Human ID: {tenant.contract_number_prefix}-CON-{YYYY}-{SEQ:04d}. Unique globally. Generated in utils/contracts.js.';
COMMENT ON COLUMN contracts.payment_schedule_snapshot IS
  'Immutable JSONB of exploded milestones (concrete amounts + due_dates). Frozen at sign; template edits do not propagate.';
COMMENT ON COLUMN contracts.generated_pdf_url IS
  'Flexrz-generated unsigned contract PDF. R2-hosted. Different from bookings.contract_url (which is an uploaded attachment per booking).';
COMMENT ON COLUMN contracts.generated_pdf_hash IS
  'SHA-256 hex of generated PDF bytes. Proves integrity of the stored file.';
COMMENT ON COLUMN contracts.signed_pdf_url IS
  'Customer-signed wet-sign scan uploaded by tenant. R2-hosted.';
COMMENT ON COLUMN contracts.security_deposit IS
  'Refundable deposit. Held separately; NOT in total_value or payment schedule.';
COMMENT ON CONSTRAINT excl_contracts_no_overlap ON contracts IS
  'A single resource cannot have two active/signed contracts with overlapping date ranges.';
