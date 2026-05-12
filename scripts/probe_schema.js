'use strict';

// Read-only schema probe for tenants/tenant_users/users + tenant_users
// primary-key/unique info. Used to reconcile prod schema drift before
// writing the provisioning script.

require('dotenv').config();
const { Pool } = require('pg');

const isProd = process.env.NODE_ENV === 'production';
const useSSL = process.env.DATABASE_SSL != null
  ? String(process.env.DATABASE_SSL).toLowerCase() === 'true'
  : isProd;

(async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: useSSL ? { rejectUnauthorized: false } : false,
    max: 1,
    connectionTimeoutMillis: 10000,
  });

  try {
    const cols = await pool.query(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('tenants','tenant_users','users')
        ORDER BY table_name, ordinal_position`
    );
    console.log('---COLUMNS---');
    console.log(JSON.stringify(cols.rows, null, 2));

    const pks = await pool.query(
      `SELECT tc.table_name,
              tc.constraint_name,
              tc.constraint_type,
              string_agg(kcu.column_name, ',' ORDER BY kcu.ordinal_position) AS columns
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name
          AND kcu.table_schema    = tc.table_schema
        WHERE tc.table_schema = 'public'
          AND tc.table_name IN ('tenants','tenant_users','users')
          AND tc.constraint_type IN ('PRIMARY KEY','UNIQUE')
        GROUP BY tc.table_name, tc.constraint_name, tc.constraint_type
        ORDER BY tc.table_name, tc.constraint_type DESC, tc.constraint_name`
    );
    console.log('---CONSTRAINTS---');
    console.log(JSON.stringify(pks.rows, null, 2));
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
})();
