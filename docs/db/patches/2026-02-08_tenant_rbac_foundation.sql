-- 2026-02-08_tenant_rbac_foundation.sql
-- Flexrz / BookFlow: Tenant RBAC foundation
--
-- Creates:
--   - users (global identity)
--   - tenant_users (membership + role per tenant)
--   - tenant_invites (invite-by-email workflow)
-- Adds:
--   - tenants.owner_user_id (FK to users)
--
-- Notes:
--   - Idempotent (safe to run repeatedly)
--   - Uses simple role strings: owner / manager / staff / viewer

BEGIN;

-- -----------------------------------------------------------------------------
-- users (global identity)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id              BIGSERIAL PRIMARY KEY,
  email           TEXT NOT NULL,
  full_name       TEXT,
  image_url       TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at   TIMESTAMPTZ
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'users_email_unique'
  ) THEN
    CREATE UNIQUE INDEX users_email_unique ON users (lower(email));
  END IF;
END$$;

-- -----------------------------------------------------------------------------
-- tenant_users (join table)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_users (
  tenant_id   BIGINT NOT NULL,
  user_id     BIGINT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'viewer',
  is_primary  BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'tenant_users_tenant_role_idx'
  ) THEN
    CREATE INDEX tenant_users_tenant_role_idx ON tenant_users (tenant_id, role);
  END IF;
END$$;

-- Foreign keys (added defensively)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenant_users_tenant_fk'
  ) THEN
    ALTER TABLE tenant_users
      ADD CONSTRAINT tenant_users_tenant_fk
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenant_users_user_fk'
  ) THEN
    ALTER TABLE tenant_users
      ADD CONSTRAINT tenant_users_user_fk
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END$$;

-- -----------------------------------------------------------------------------
-- tenant_invites (invite-by-email)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_invites (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    BIGINT NOT NULL,
  email        TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'viewer',
  token_hash   TEXT NOT NULL,
  created_by   BIGINT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  accepted_at  TIMESTAMPTZ,
  accepted_by  BIGINT
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'tenant_invites_tenant_email_idx'
  ) THEN
    CREATE INDEX tenant_invites_tenant_email_idx ON tenant_invites (tenant_id, lower(email));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'tenant_invites_token_hash_unique'
  ) THEN
    CREATE UNIQUE INDEX tenant_invites_token_hash_unique ON tenant_invites (token_hash);
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenant_invites_tenant_fk'
  ) THEN
    ALTER TABLE tenant_invites
      ADD CONSTRAINT tenant_invites_tenant_fk
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenant_invites_created_by_fk'
  ) THEN
    ALTER TABLE tenant_invites
      ADD CONSTRAINT tenant_invites_created_by_fk
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenant_invites_accepted_by_fk'
  ) THEN
    ALTER TABLE tenant_invites
      ADD CONSTRAINT tenant_invites_accepted_by_fk
      FOREIGN KEY (accepted_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END$$;

-- -----------------------------------------------------------------------------
-- tenants.owner_user_id (explicit owner FK)
-- -----------------------------------------------------------------------------
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS owner_user_id BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenants_owner_user_fk'
  ) THEN
    ALTER TABLE tenants
      ADD CONSTRAINT tenants_owner_user_fk
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END$$;

COMMIT;
