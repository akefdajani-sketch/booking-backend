-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 054: Email log (transactional email audit trail)
--
-- PR G (Transactional email foundation).
--
-- Append-only log of every email send attempt. Lets ak answer:
--   - "Did the trial-warning email actually go to abz?"
--   - "Why didn't the invite to alex@example.com arrive — did we even send it?"
--   - "How many payment-failed alerts went out last week?"
--
-- The provider's own dashboard (Resend) shows delivery telemetry, but that's
-- one click away and tied to API access. Having the local log means support
-- questions don't require a Resend login.
--
-- The provider message_id is stored when available so we can cross-reference
-- with Resend's logs for delivery debugging.
--
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS email_log (
  id              SERIAL PRIMARY KEY,
  tenant_id       INTEGER REFERENCES tenants(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL,
  recipient       TEXT NOT NULL,
  subject         TEXT,
  status          TEXT NOT NULL DEFAULT 'queued',
  provider_message_id TEXT,
  error_message   TEXT,
  meta            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  email_log              IS 'Append-only audit log of every transactional email attempted by the platform. Source of truth for "did we send it?" questions.';
COMMENT ON COLUMN email_log.kind         IS 'Template key: invite | trial_warning | payment_failed | welcome | trial_converted | (more added later)';
COMMENT ON COLUMN email_log.status       IS 'sent | failed | skipped (skipped = RESEND_API_KEY missing or kill-switch active)';
COMMENT ON COLUMN email_log.provider_message_id IS 'Resend "id" field returned on successful send. Cross-reference for delivery debugging in Resend dashboard.';
COMMENT ON COLUMN email_log.meta         IS 'Free-form context — varies per kind. Examples: { invite_id, role } | { trial_ends_at, plan_code } | { invoice_id, amount_cents }';

CREATE INDEX IF NOT EXISTS idx_email_log_tenant_kind
  ON email_log (tenant_id, kind, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_log_recipient
  ON email_log (recipient, created_at DESC);

COMMIT;

-- Verification:
--   SELECT to_regclass('email_log');           -- should return 'email_log'
--   SELECT count(*) FROM email_log;            -- should return 0 (fresh table)
