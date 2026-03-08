-- migrations/002_rbac_links_memberships.sql
-- PR-5: Migration System + DB Integrity
--
-- RBAC tables (tenant_users, tenant_invites),
-- relationship link tables (staff_service, resource_service, staff_resource),
-- and membership tables.
-- All idempotent.

-- ─── RBAC ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_users (
  id          SERIAL PRIMARY KEY,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'viewer',
  is_primary  BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_users_tenant  ON tenant_users (tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_users_user    ON tenant_users (user_id);

CREATE TABLE IF NOT EXISTS tenant_invites (
  id                  SERIAL PRIMARY KEY,
  tenant_id           INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email               TEXT NOT NULL,
  role                TEXT NOT NULL DEFAULT 'viewer',
  token_hash          TEXT NOT NULL,
  expires_at          TIMESTAMPTZ NOT NULL,
  accepted_at         TIMESTAMPTZ,
  invited_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, email, token_hash)
);

CREATE INDEX IF NOT EXISTS idx_tenant_invites_tenant      ON tenant_invites (tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_invites_token_hash  ON tenant_invites (token_hash);

-- ─── Link tables ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS staff_service_links (
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  staff_id    INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  service_id  INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (staff_id, service_id)
);

CREATE INDEX IF NOT EXISTS idx_staff_service_links_tenant_service
  ON staff_service_links (tenant_id, service_id);
CREATE INDEX IF NOT EXISTS idx_staff_service_links_tenant_staff
  ON staff_service_links (tenant_id, staff_id);

CREATE TABLE IF NOT EXISTS resource_service_links (
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  service_id  INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (resource_id, service_id)
);

CREATE INDEX IF NOT EXISTS idx_resource_service_links_tenant_service
  ON resource_service_links (tenant_id, service_id);
CREATE INDEX IF NOT EXISTS idx_resource_service_links_tenant_resource
  ON resource_service_links (tenant_id, resource_id);

CREATE TABLE IF NOT EXISTS staff_resource_links (
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  staff_id    INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (staff_id, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_staff_resource_links_tenant_staff
  ON staff_resource_links (tenant_id, staff_id);
CREATE INDEX IF NOT EXISTS idx_staff_resource_links_tenant_resource
  ON staff_resource_links (tenant_id, resource_id);

-- ─── Memberships ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS membership_plans (
  id            SERIAL PRIMARY KEY,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT,
  price         NUMERIC,
  currency_code TEXT DEFAULT 'USD',
  credits       INTEGER,
  duration_days INTEGER,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_membership_plans_tenant ON membership_plans (tenant_id);

CREATE TABLE IF NOT EXISTS customer_memberships (
  id            SERIAL PRIMARY KEY,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id   INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  plan_id       INTEGER NOT NULL REFERENCES membership_plans(id) ON DELETE RESTRICT,
  status        TEXT NOT NULL DEFAULT 'active',
  credits_remaining INTEGER,
  starts_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_memberships_tenant    ON customer_memberships (tenant_id);
CREATE INDEX IF NOT EXISTS idx_customer_memberships_customer  ON customer_memberships (customer_id);
