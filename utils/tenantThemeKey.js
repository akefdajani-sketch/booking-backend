// Keep built-in theme keys usable even if platform_themes isn't seeded yet.
const BUILTIN_THEME_KEYS = new Set(["default_v1", "classic", "premium", "premium_light"]);

async function validateThemeKey(db, themeKey) {
  if (BUILTIN_THEME_KEYS.has(themeKey)) return;
  const th = await db.query(
    "SELECT key FROM platform_themes WHERE key = $1 AND is_published = TRUE LIMIT 1",
    [themeKey]
  );
  if (!th.rows[0]) {
    const err = new Error("Theme is not published or does not exist");
    err.status = 400;
    throw err;
  }
}

async function updateTenantThemeKey(db, tenantId, themeKey) {
  await validateThemeKey(db, themeKey);

  const result = await db.query(
    "UPDATE tenants SET theme_key = $2 WHERE id = $1 RETURNING id, slug, theme_key",
    [tenantId, themeKey]
  );
  if (!result.rows.length) {
    const err = new Error("Tenant not found");
    err.status = 404;
    throw err;
  }
  return result.rows[0];
}

module.exports = {
  BUILTIN_THEME_KEYS,
  validateThemeKey,
  updateTenantThemeKey,
};
