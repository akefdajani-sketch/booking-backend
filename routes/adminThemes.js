const express = require("express");
const router = express.Router();
const db = require("../db");
const requireAdmin = require("../middleware/requireAdmin");
const { sanitizeThemeTokens } = require("../theme/validateTokens");

// Sensible defaults for premium layouts. Without these, Premium cards can end up
// looking "flat" because the fallback UI (hex-only pickers) can't express opacity.
// These defaults keep the "glass" effect intact while still allowing owners to
// override tokens later.
const DEFAULT_THEME_TOKENS_BY_LAYOUT = {
  premium: {
    "--bf-card-bg": "rgba(2, 6, 23, 0.38)",
    "--bf-card-border": "rgba(255, 255, 255, 0.12)",
    "--bf-card-shadow": "0 18px 70px rgba(0,0,0,0.55)",
    "--bf-pill-bg": "rgba(255,255,255,0.06)",
    "--bf-pill-border": "rgba(255,255,255,0.14)",
    "--bf-res-cancelled-bg": "color-mix(in srgb, #b91c1c 6%, transparent)",
  },
  premium_light: {
    "--bf-card-bg": "rgba(255, 255, 255, 0.72)",
    "--bf-card-border": "rgba(15, 23, 42, 0.12)",
    "--bf-card-shadow": "0 18px 70px rgba(2,6,23,0.18)",
    "--bf-pill-bg": "rgba(15,23,42,0.04)",
    "--bf-pill-border": "rgba(15,23,42,0.14)",
    "--bf-res-cancelled-bg": "color-mix(in srgb, #b91c1c 6%, transparent)",
  },
};

function withDefaultTokens(layoutKey, tokens) {
  const lk = String(layoutKey || "").trim();
  const defaults = DEFAULT_THEME_TOKENS_BY_LAYOUT[lk];
  if (!defaults) return tokens;
  if (tokens && Object.keys(tokens).length > 0) return tokens;
  return defaults;
}

function normalizeKey(k) {
  return String(k || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_\-]/g, "");
}

// List (includes drafts + published)
router.get("/", requireAdmin, async (req, res) => {
  const { rows } = await db.query(
    "SELECT key, name, version, is_published, layout_key, updated_at FROM platform_themes ORDER BY updated_at DESC"
  );
  res.json({ themes: rows });
});

// Get one
router.get("/:key", requireAdmin, async (req, res) => {
  const { key } = req.params;
  const { rows } = await db.query(
    "SELECT key, name, version, is_published, layout_key, tokens_json FROM platform_themes WHERE key = $1",
    [key]
  );
  if (!rows[0]) return res.status(404).json({ error: "Theme not found" });
  res.json({ theme: rows[0] });
});

// Create (draft)
router.post("/", requireAdmin, async (req, res) => {
  const { key, name, tokens, layout_key } = req.body || {};
  const safeKey = normalizeKey(key);
  if (!safeKey || !name) return res.status(400).json({ error: "key and name required" });

  const lk = layout_key ? String(layout_key).trim() : null;
  const safeTokens = withDefaultTokens(lk, sanitizeThemeTokens(tokens));

  try {
    const { rows } = await db.query(
      "INSERT INTO platform_themes (key, name, tokens_json, is_published, layout_key) VALUES ($1, $2, $3::jsonb, FALSE, $4) RETURNING key, name, version, is_published, layout_key",
      [safeKey, name, JSON.stringify(safeTokens), lk]
    );
    res.status(201).json({ theme: rows[0] });
  } catch (err) {
    if (err && err.code === "23505") {
      return res.status(409).json({ error: "Theme key already exists" });
    }
    console.error("Create theme error:", err);
    res.status(500).json({ error: "Failed to create theme" });
  }
});

// Update (draft)
router.put("/:key", requireAdmin, async (req, res) => {
  const { key } = req.params;
  const { name, tokens, layout_key } = req.body || {};
  const lk = layout_key ? String(layout_key).trim() : null;
  const safeTokens = withDefaultTokens(lk, sanitizeThemeTokens(tokens));

  const { rows } = await db.query(
    "UPDATE platform_themes SET name = COALESCE($2, name), tokens_json = $3::jsonb, layout_key = COALESCE($4, layout_key), version = version + 1 WHERE key = $1 RETURNING key, name, version, is_published, layout_key",
    [key, name ?? null, JSON.stringify(safeTokens), lk]
  );
  if (!rows[0]) return res.status(404).json({ error: "Theme not found" });
  res.json({ theme: rows[0] });
});

// Publish
router.post("/:key/publish", requireAdmin, async (req, res) => {
  const { key } = req.params;
  // If the theme is premium-ish and has empty tokens_json, populate defaults on publish.
  const existing = await db.query("SELECT layout_key, tokens_json FROM platform_themes WHERE key = $1", [key]);
  if (!existing.rows[0]) return res.status(404).json({ error: "Theme not found" });

  const lk = existing.rows[0].layout_key;
  const curTokens = existing.rows[0].tokens_json || {};
  const patchedTokens = withDefaultTokens(lk, curTokens);

  const { rows } = await db.query(
    "UPDATE platform_themes SET is_published = TRUE, tokens_json = $2::jsonb WHERE key = $1 RETURNING key, name, version, is_published, layout_key",
    [key, JSON.stringify(patchedTokens)]
  );
  if (!rows[0]) return res.status(404).json({ error: "Theme not found" });
  res.json({ theme: rows[0] });
});

// Unpublish
router.post("/:key/unpublish", requireAdmin, async (req, res) => {
  const { key } = req.params;

  // Prevent unpublishing default_v1 (safety)
  if (key === "default_v1") {
    return res.status(400).json({ error: "default_v1 cannot be unpublished" });
  }

  const { rows } = await db.query(
    "UPDATE platform_themes SET is_published = FALSE WHERE key = $1 RETURNING key, name, version, is_published, layout_key",
    [key]
  );
  if (!rows[0]) return res.status(404).json({ error: "Theme not found" });
  res.json({ theme: rows[0] });
});

// Duplicate (creates draft copy)
router.post("/:key/duplicate", requireAdmin, async (req, res) => {
  const { key } = req.params;
  const { newKey, newName } = req.body || {};
  const nk = normalizeKey(newKey);
  if (!nk) return res.status(400).json({ error: "newKey is required" });

  const base = await db.query(
    "SELECT key, name, tokens_json, layout_key FROM platform_themes WHERE key = $1",
    [key]
  );
  if (!base.rows[0]) return res.status(404).json({ error: "Theme not found" });

  const src = base.rows[0];
  const name = String(newName || `${src.name} Copy`).trim();

  try {
    const { rows } = await db.query(
      "INSERT INTO platform_themes (key, name, tokens_json, is_published, layout_key) VALUES ($1, $2, $3::jsonb, FALSE, $4) RETURNING key, name, version, is_published, layout_key",
      [nk, name, JSON.stringify(src.tokens_json || {}), src.layout_key || null]
    );
    res.status(201).json({ theme: rows[0] });
  } catch (err) {
    if (err && err.code === "23505") {
      return res.status(409).json({ error: "Theme key already exists" });
    }
    console.error("Duplicate theme error:", err);
    res.status(500).json({ error: "Failed to duplicate theme" });
  }
});

module.exports = router;
