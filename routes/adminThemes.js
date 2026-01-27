const express = require("express");
const router = express.Router();
const db = require("../db");
const requireAdmin = require("../middleware/requireAdmin");
const { sanitizeThemeTokens } = require("../theme/validateTokens");

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

  const safeTokens = sanitizeThemeTokens(tokens);
  const lk = layout_key ? String(layout_key).trim() : null;

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
  const safeTokens = sanitizeThemeTokens(tokens);
  const lk = layout_key ? String(layout_key).trim() : null;

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
  const { rows } = await db.query(
    "UPDATE platform_themes SET is_published = TRUE WHERE key = $1 RETURNING key, name, version, is_published, layout_key",
    [key]
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
