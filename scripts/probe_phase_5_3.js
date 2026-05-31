'use strict';

// Phase 5.3 scope audit — DB reality probe.
// Read-only: counts/slugs/distribution of shell_key, layout_key_v2, theme_key
// and computes the distinct (shell_key, layout_key_v2, theme_key) combination
// count across live tenants.

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
    const total = await pool.query('SELECT COUNT(*)::int AS n FROM tenants');
    console.log('---TOTAL_TENANTS---');
    console.log(JSON.stringify(total.rows[0], null, 2));

    const slugs = await pool.query(
      'SELECT id, slug, name, theme_key, shell_key, layout_key_v2 FROM tenants ORDER BY id'
    );
    console.log('---ROWS---');
    console.log(JSON.stringify(slugs.rows, null, 2));

    const themeDist = await pool.query(
      `SELECT theme_key, COUNT(*)::int AS n FROM tenants GROUP BY theme_key ORDER BY n DESC, theme_key`
    );
    console.log('---THEME_KEY_DIST---');
    console.log(JSON.stringify(themeDist.rows, null, 2));

    const shellDist = await pool.query(
      `SELECT shell_key, COUNT(*)::int AS n FROM tenants GROUP BY shell_key ORDER BY n DESC NULLS LAST, shell_key`
    );
    console.log('---SHELL_KEY_DIST---');
    console.log(JSON.stringify(shellDist.rows, null, 2));

    const layoutDist = await pool.query(
      `SELECT layout_key_v2, COUNT(*)::int AS n FROM tenants GROUP BY layout_key_v2 ORDER BY n DESC NULLS LAST, layout_key_v2`
    );
    console.log('---LAYOUT_KEY_V2_DIST---');
    console.log(JSON.stringify(layoutDist.rows, null, 2));

    // Distinct combos using the SAME derivation routes/publicTenantTheme.js
    // applies on read. shell_key NULL -> derived from theme_key; layout_key_v2
    // NULL -> legacy_default. This gives the *effective* matrix size that
    // SectionRenderer must verify against, not the literal stored values.
    const distinctCombo = await pool.query(
      `WITH derived AS (
        SELECT
          CASE
            WHEN shell_key IS NOT NULL AND length(trim(shell_key)) > 0
              THEN trim(lower(shell_key))
            WHEN lower(trim(coalesce(theme_key, ''))) IN
              ('premium-hospitality','premium','premium_v1','premium_v2','premium_light','boutique-beauty')
              THEN 'premium'
            WHEN lower(trim(coalesce(theme_key, ''))) = 'minimal'
              THEN 'minimal'
            ELSE 'classic'
          END AS effective_shell,
          CASE
            WHEN layout_key_v2 IS NOT NULL AND length(trim(layout_key_v2)) > 0
              THEN trim(lower(layout_key_v2))
            ELSE 'legacy_default'
          END AS effective_layout,
          lower(trim(coalesce(theme_key, 'default_v1'))) AS effective_theme
        FROM tenants
      )
      SELECT effective_shell, effective_layout, effective_theme, COUNT(*)::int AS n
      FROM derived
      GROUP BY effective_shell, effective_layout, effective_theme
      ORDER BY n DESC, effective_theme`
    );
    console.log('---DISTINCT_COMBOS_EFFECTIVE---');
    console.log(JSON.stringify(distinctCombo.rows, null, 2));
    console.log('---DISTINCT_COMBOS_COUNT---');
    console.log(JSON.stringify({ n: distinctCombo.rows.length }, null, 2));

    const platforms = await pool.query(
      `SELECT key, name, is_published, version FROM platform_shells ORDER BY key`
    );
    console.log('---PLATFORM_SHELLS---');
    console.log(JSON.stringify(platforms.rows, null, 2));

    const layouts = await pool.query(
      `SELECT key, name, is_published, version, jsonb_array_length(sections_json) AS section_count, supported_section_types_json
       FROM platform_layouts ORDER BY key`
    );
    console.log('---PLATFORM_LAYOUTS---');
    console.log(JSON.stringify(layouts.rows, null, 2));
  } finally {
    await pool.end();
  }
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
