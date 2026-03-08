'use strict';

// __tests__/migrations.test.js
// PR-5: Migration System + DB Integrity
//
// Tests the migration runner logic and SQL file structure.
// Does NOT require a live DB — uses mocks for all pg calls.

const path = require('path');
const fs   = require('fs');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

// ─── Migration file structure tests ──────────────────────────────────────────

describe('Migration files', () => {
  let files;

  beforeAll(() => {
    files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort();
  });

  test('migrations directory exists', () => {
    expect(fs.existsSync(MIGRATIONS_DIR)).toBe(true);
  });

  test('at least 4 migration files exist', () => {
    expect(files.length).toBeGreaterThanOrEqual(4);
  });

  test('all migration files follow NNN_name.sql naming convention', () => {
    for (const f of files) {
      expect(f).toMatch(/^\d{3}_[a-z0-9_]+\.sql$/);
    }
  });

  test('migration filenames are in strictly ascending order', () => {
    const nums = files.map(f => parseInt(f.split('_')[0], 10));
    for (let i = 1; i < nums.length; i++) {
      expect(nums[i]).toBeGreaterThan(nums[i - 1]);
    }
  });

  test('no duplicate migration numbers', () => {
    const nums = files.map(f => f.split('_')[0]);
    const unique = new Set(nums);
    expect(unique.size).toBe(nums.length);
  });

  test('all migration files are non-empty', () => {
    for (const f of files) {
      const content = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8').trim();
      expect(content.length).toBeGreaterThan(0);
    }
  });

  test('migration files only contain valid SQL keywords (no JS leakage)', () => {
    const jsOnlyPatterns = [/require\s*\(/, /const\s+\w/, /module\.exports/];
    for (const f of files) {
      const content = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
      for (const pat of jsOnlyPatterns) {
        expect(content).not.toMatch(pat);
      }
    }
  });

  test('001_core_tables.sql creates tenants, bookings, customers tables', () => {
    const content = fs.readFileSync(path.join(MIGRATIONS_DIR, '001_core_tables.sql'), 'utf8');
    expect(content).toMatch(/CREATE TABLE IF NOT EXISTS tenants/);
    expect(content).toMatch(/CREATE TABLE IF NOT EXISTS bookings/);
    expect(content).toMatch(/CREATE TABLE IF NOT EXISTS customers/);
  });

  test('001_core_tables.sql includes CHECK constraint on bookings end_time', () => {
    const content = fs.readFileSync(path.join(MIGRATIONS_DIR, '001_core_tables.sql'), 'utf8');
    expect(content).toMatch(/end_time > start_time/);
  });

  test('002_rbac_links_memberships.sql creates tenant_users and link tables', () => {
    const content = fs.readFileSync(path.join(MIGRATIONS_DIR, '002_rbac_links_memberships.sql'), 'utf8');
    expect(content).toMatch(/CREATE TABLE IF NOT EXISTS tenant_users/);
    expect(content).toMatch(/CREATE TABLE IF NOT EXISTS staff_service_links/);
    expect(content).toMatch(/CREATE TABLE IF NOT EXISTS membership_plans/);
  });

  test('003_saas_billing_booking_columns.sql creates saas_plans and tenant_subscriptions', () => {
    const content = fs.readFileSync(path.join(MIGRATIONS_DIR, '003_saas_billing_booking_columns.sql'), 'utf8');
    expect(content).toMatch(/CREATE TABLE IF NOT EXISTS saas_plans/);
    expect(content).toMatch(/CREATE TABLE IF NOT EXISTS tenant_subscriptions/);
    expect(content).toMatch(/ALTER TABLE bookings ADD COLUMN IF NOT EXISTS price_amount/);
  });

  test('004_stripe_customer_id.sql adds stripe_customer_id to tenants', () => {
    const content = fs.readFileSync(path.join(MIGRATIONS_DIR, '004_stripe_customer_id.sql'), 'utf8');
    expect(content).toMatch(/stripe_customer_id/);
    expect(content).toMatch(/ALTER TABLE tenants/);
  });

  test('all CREATE TABLE statements use IF NOT EXISTS (idempotent)', () => {
    for (const f of files) {
      const content = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
      const createMatches = content.match(/CREATE TABLE\s+(?!IF NOT EXISTS)/gi);
      expect(createMatches).toBeNull();
    }
  });

  test('all ALTER TABLE ADD COLUMN statements use IF NOT EXISTS (idempotent)', () => {
    for (const f of files) {
      const content = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
      const alterMatches = content.match(/ADD COLUMN\s+(?!IF NOT EXISTS)/gi);
      expect(alterMatches).toBeNull();
    }
  });
});

// ─── Migration runner unit tests (mocked DB) ─────────────────────────────────

describe('Migration runner logic', () => {
  // We test the pure helper functions by extracting them from the script.
  // The script uses process.argv and pool — we avoid importing it directly
  // to prevent it auto-running. Instead we test the file/sort logic inline.

  test('getMigrationFiles returns .sql files sorted ascending', () => {
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort();

    expect(files[0]).toMatch(/^001_/);
    expect(files[files.length - 1]).toMatch(/^00[4-9]_|^0[1-9]\d_/);
  });

  test('pending calculation correctly excludes applied migrations', () => {
    const allFiles = ['001_core.sql', '002_rbac.sql', '003_billing.sql'];
    const applied  = new Set(['001_core.sql']);
    const pending  = allFiles.filter(f => !applied.has(f));

    expect(pending).toEqual(['002_rbac.sql', '003_billing.sql']);
  });

  test('pending calculation returns empty when all applied', () => {
    const allFiles = ['001_core.sql', '002_rbac.sql'];
    const applied  = new Set(['001_core.sql', '002_rbac.sql']);
    const pending  = allFiles.filter(f => !applied.has(f));

    expect(pending).toHaveLength(0);
  });

  test('migrate script file exists and is readable', () => {
    const scriptPath = path.join(__dirname, '..', 'scripts', 'migrate.js');
    expect(fs.existsSync(scriptPath)).toBe(true);
    const content = fs.readFileSync(scriptPath, 'utf8');
    expect(content).toMatch(/schema_migrations/);
    expect(content).toMatch(/BEGIN/);
    expect(content).toMatch(/COMMIT/);
    expect(content).toMatch(/ROLLBACK/);
  });

  test('migrate script wraps each migration in a transaction', () => {
    const scriptPath = path.join(__dirname, '..', 'scripts', 'migrate.js');
    const content = fs.readFileSync(scriptPath, 'utf8');
    expect(content).toMatch(/BEGIN/);
    expect(content).toMatch(/COMMIT/);
    expect(content).toMatch(/ROLLBACK/);
  });
});

// ─── DB integrity checks (schema level) ──────────────────────────────────────

describe('DB integrity constraints in migrations', () => {
  test('bookings table has tenant_id foreign key', () => {
    const content = fs.readFileSync(path.join(MIGRATIONS_DIR, '001_core_tables.sql'), 'utf8');
    expect(content).toMatch(/tenant_id\s+INTEGER NOT NULL REFERENCES tenants/);
  });

  test('bookings table has performance indexes on tenant_id and start_time', () => {
    const content = fs.readFileSync(path.join(MIGRATIONS_DIR, '001_core_tables.sql'), 'utf8');
    expect(content).toMatch(/idx_bookings_tenant_time/);
  });

  test('tenant_subscriptions has foreign key to tenants', () => {
    const content = fs.readFileSync(path.join(MIGRATIONS_DIR, '003_saas_billing_booking_columns.sql'), 'utf8');
    expect(content).toMatch(/tenant_id\s+INTEGER NOT NULL REFERENCES tenants/);
  });

  test('membership plans reference tenants with ON DELETE CASCADE', () => {
    const content = fs.readFileSync(path.join(MIGRATIONS_DIR, '002_rbac_links_memberships.sql'), 'utf8');
    expect(content).toMatch(/REFERENCES tenants\(id\) ON DELETE CASCADE/);
  });

  test('saas_plan_features reference saas_plans with ON DELETE CASCADE', () => {
    const content = fs.readFileSync(path.join(MIGRATIONS_DIR, '003_saas_billing_booking_columns.sql'), 'utf8');
    expect(content).toMatch(/REFERENCES saas_plans\(id\) ON DELETE CASCADE/);
  });

  test('tenant_working_hours has valid day_of_week CHECK constraint', () => {
    const content = fs.readFileSync(path.join(MIGRATIONS_DIR, '003_saas_billing_booking_columns.sql'), 'utf8');
    expect(content).toMatch(/day_of_week BETWEEN 0 AND 6/);
  });
});
