'use strict';

// Phase 5.3 — find which landing templateKey each live tenant actually uses,
// because that determines which renderer (BirdieDestinationTemplate vs
// WellnessEditorialTemplate vs ModularLandingRenderer vs HomeWelcomeCard) is
// on the live render path.
//
// Looks at branding_published first (the published snapshot the public route
// returns), then falls back to branding (the live draft).

require('dotenv').config();
const { Pool } = require('pg');

const isProd = process.env.NODE_ENV === 'production';
const useSSL = process.env.DATABASE_SSL != null
  ? String(process.env.DATABASE_SSL).toLowerCase() === 'true'
  : isProd;

function pickTemplateKey(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const land =
    obj.homeLanding ||
    obj.home_landing ||
    obj.home ||
    null;
  if (!land || typeof land !== 'object') return null;
  const k = land.templateKey;
  if (typeof k === 'string' && k.trim()) return k.trim().toLowerCase();
  return null;
}

(async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: useSSL ? { rejectUnauthorized: false } : false,
    max: 1,
    connectionTimeoutMillis: 10000,
  });

  try {
    const r = await pool.query(
      `SELECT id, slug, theme_key, publish_status, branding_published, branding FROM tenants ORDER BY id`
    );
    const rows = r.rows.map((row) => {
      const pubKey = pickTemplateKey(row.branding_published);
      const draftKey = pickTemplateKey(row.branding);
      return {
        id: row.id,
        slug: row.slug,
        theme_key: row.theme_key,
        publish_status: row.publish_status,
        published_templateKey: pubKey,
        draft_templateKey: draftKey,
        effective_templateKey: pubKey || draftKey || '(default/none)',
      };
    });
    console.log('---ROWS---');
    console.log(JSON.stringify(rows, null, 2));

    const dist = {};
    for (const row of rows) {
      const k = row.effective_templateKey;
      dist[k] = (dist[k] || 0) + 1;
    }
    console.log('---EFFECTIVE_TEMPLATEKEY_DIST---');
    console.log(JSON.stringify(dist, null, 2));
  } finally {
    await pool.end();
  }
})().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
