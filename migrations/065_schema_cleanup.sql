-- Migration 065: Schema cleanup — duplicate indexes, duplicate FKs, missing tenant FKs
--
-- ─── CONTEXT ─────────────────────────────────────────────────────────────────
--
-- The DB audit (May 3-4, 2026) found three categories of schema noise:
--
--   1. 29 sets of duplicate indexes — same table, same column ordering,
--      same predicate, multiple names. Worst case: 4 indexes on
--      bookings(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL.
--      Wastes disk and write amplification on every booking insert.
--
--   2. 1 duplicate FK on tenant_domains pointing to tenants(id). One of two
--      identical FKs is redundant.
--
--   3. 4 tables have a tenant_id column but no FK enforcing referential
--      integrity to tenants(id). This is a real isolation gap — orphaned
--      rows could exist if a tenant were ever deleted (no cascade), and
--      writes with a fictitious tenant_id wouldn't be caught at the DB
--      layer. Affected tables (subset present on each DB):
--        - customer_memberships
--        - membership_ledger
--        - prepaid_sales            (only if prepaid feature deployed)
--        - tenant_theme_schema_changelog  (only if theme studio deployed)
--      (_twilio_creds_backup_2026 is an audit-trail backup table; expected.)
--
-- ─── STRATEGY ────────────────────────────────────────────────────────────────
--
--   - Section A: drop duplicate indexes by structural fingerprint (indkey +
--     indpred + indisunique). For each dup group, keep the alphabetically-
--     first index, drop the rest. Skips primary keys and system catalogs.
--
--   - Section B: drop duplicate FKs the same way (group by referenced
--     columns + target). Keep first by name.
--
--   - Section C: add missing tenant FKs. Each table is checked for:
--       i.   existence (skip if absent on this DB)
--       ii.  orphan rows pointing to non-existent tenants — if found, log
--            the count + abort with a clear message. Operator must triage
--            manually before re-running.
--       iii. existing FK — skip if already present.
--     Only when (i) is true, (ii) is empty, and (iii) is absent does the
--     migration add the FK. ON DELETE CASCADE on all four (an orphaned
--     membership/ledger/sale/changelog row with a deleted tenant has no
--     business value).
--
-- All sections wrapped in BEGIN/COMMIT for atomicity. Migration is idempotent;
-- safe to re-run.

BEGIN;

-- ─── A. Duplicate index cleanup ─────────────────────────────────────────────

DO $dup_idx$
DECLARE
  rec RECORD;
  i   INTEGER;
  total_dropped INTEGER := 0;
BEGIN
  FOR rec IN
    -- Group indexes by structural fingerprint. Two indexes with the same
    -- (table, columns-in-order, predicate, uniqueness) are functionally
    -- identical — Postgres has to maintain both on every write.
    --
    -- Filters:
    --   - skip primary keys (indisprimary)
    --   - skip system catalogs
    --   - skip indexes that back a constraint (UNIQUE, EXCLUDE) — dropping
    --     those would silently break the constraint. Identified via
    --     pg_constraint.conindid which points to the supporting index.
    SELECT
      i.indrelid::regclass         AS on_table,
      array_agg(
        i.indexrelid::regclass::text ORDER BY i.indexrelid::regclass::text
      )                            AS index_names
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indisprimary = false
      AND i.indrelid::regclass::text !~ '^(pg_|sql_|information_schema)'
      AND i.indexrelid NOT IN (
        SELECT conindid FROM pg_constraint WHERE conindid <> 0
      )
    GROUP BY
      i.indrelid,
      i.indkey::text,
      pg_get_expr(i.indpred, i.indrelid),
      i.indisunique,
      c.relam                      -- access method: btree/hash/gist/gin/brin
    HAVING COUNT(*) > 1
  LOOP
    -- Keep first by name; drop the rest.
    FOR i IN 2 .. array_length(rec.index_names, 1) LOOP
      EXECUTE format('DROP INDEX IF EXISTS %s', rec.index_names[i]);
      RAISE NOTICE '[065:A] Dropped duplicate index % on % (kept: %)',
                   rec.index_names[i], rec.on_table, rec.index_names[1];
      total_dropped := total_dropped + 1;
    END LOOP;
  END LOOP;
  RAISE NOTICE '[065:A] Duplicate indexes dropped: %', total_dropped;
END $dup_idx$;

-- ─── B. Duplicate FK cleanup ────────────────────────────────────────────────

DO $dup_fk$
DECLARE
  rec RECORD;
  i   INTEGER;
  total_dropped INTEGER := 0;
BEGIN
  FOR rec IN
    -- Group FKs by (table, source columns, target table, target columns,
    -- update behavior, delete behavior). Identical fingerprint = redundant.
    SELECT
      conrelid::regclass         AS on_table,
      array_agg(conname ORDER BY conname) AS constraint_names
    FROM pg_constraint
    WHERE contype = 'f'
      AND conrelid::regclass::text !~ '^(pg_|sql_|information_schema)'
    GROUP BY
      conrelid,
      conkey::text,
      confrelid,
      confkey::text,
      confupdtype,
      confdeltype
    HAVING COUNT(*) > 1
  LOOP
    FOR i IN 2 .. array_length(rec.constraint_names, 1) LOOP
      EXECUTE format(
        'ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I',
        rec.on_table, rec.constraint_names[i]
      );
      RAISE NOTICE '[065:B] Dropped duplicate FK %.% (kept: %)',
                   rec.on_table, rec.constraint_names[i], rec.constraint_names[1];
      total_dropped := total_dropped + 1;
    END LOOP;
  END LOOP;
  RAISE NOTICE '[065:B] Duplicate FKs dropped: %', total_dropped;
END $dup_fk$;

-- ─── C. Add missing tenant FKs ──────────────────────────────────────────────

DO $missing_fk$
DECLARE
  target_tables TEXT[] := ARRAY[
    'customer_memberships',
    'membership_ledger',
    'prepaid_sales',
    'tenant_theme_schema_changelog'
  ];
  tbl TEXT;
  fk_name TEXT;
  orphan_count INTEGER;
  has_table BOOLEAN;
  has_tenant_id BOOLEAN;
  has_fk BOOLEAN;
  total_added INTEGER := 0;
  total_skipped INTEGER := 0;
BEGIN
  FOREACH tbl IN ARRAY target_tables LOOP
    fk_name := tbl || '_tenant_id_fkey';

    -- (i) Does the table exist?
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema='public' AND table_name = tbl
    ) INTO has_table;
    IF NOT has_table THEN
      RAISE NOTICE '[065:C] Skip % — table not present on this DB', tbl;
      total_skipped := total_skipped + 1;
      CONTINUE;
    END IF;

    -- Defense-in-depth: confirm the table actually has a tenant_id column.
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name = tbl
         AND column_name = 'tenant_id'
    ) INTO has_tenant_id;
    IF NOT has_tenant_id THEN
      RAISE NOTICE '[065:C] Skip % — no tenant_id column', tbl;
      total_skipped := total_skipped + 1;
      CONTINUE;
    END IF;

    -- (iii) Already has the FK?
    SELECT EXISTS (
      SELECT 1
        FROM pg_constraint c
        JOIN pg_attribute  a ON a.attrelid = c.conrelid
                            AND a.attnum   = ANY(c.conkey)
       WHERE c.conrelid = tbl::regclass
         AND c.contype  = 'f'
         AND a.attname  = 'tenant_id'
         AND c.confrelid = 'tenants'::regclass
    ) INTO has_fk;
    IF has_fk THEN
      RAISE NOTICE '[065:C] Skip % — tenant_id FK already present', tbl;
      total_skipped := total_skipped + 1;
      CONTINUE;
    END IF;

    -- (ii) Orphan check — count rows whose tenant_id doesn't match a tenant.
    EXECUTE format(
      'SELECT COUNT(*)::int FROM %I t LEFT JOIN tenants te ON te.id = t.tenant_id WHERE te.id IS NULL',
      tbl
    ) INTO orphan_count;
    IF orphan_count > 0 THEN
      RAISE EXCEPTION '[065:C] ABORT — % has % orphan row(s) (tenant_id pointing to no tenant). Triage manually then re-run migration. Suggested triage: SELECT t.id, t.tenant_id FROM % t LEFT JOIN tenants te ON te.id = t.tenant_id WHERE te.id IS NULL;',
        tbl, orphan_count, tbl
        USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- All clear — add the FK.
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE',
      tbl, fk_name
    );
    RAISE NOTICE '[065:C] Added FK %.% → tenants(id) ON DELETE CASCADE', tbl, fk_name;
    total_added := total_added + 1;
  END LOOP;
  RAISE NOTICE '[065:C] Missing FKs added: %, skipped: %', total_added, total_skipped;
END $missing_fk$;

-- ─── D. Post-cleanup summary ────────────────────────────────────────────────

DO $summary$
DECLARE
  v_idx_count INTEGER;
  v_fk_count  INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_idx_count
    FROM pg_index
   WHERE indrelid::regclass::text !~ '^(pg_|sql_|information_schema)';
  SELECT COUNT(*) INTO v_fk_count
    FROM pg_constraint
   WHERE contype = 'f'
     AND conrelid::regclass::text !~ '^(pg_|sql_|information_schema)';
  RAISE NOTICE '[065] Schema state after cleanup: % indexes, % foreign keys',
               v_idx_count, v_fk_count;
END $summary$;

COMMIT;
