const express = require("express");
const router = express.Router();
const db = require("../db");
const requireAdmin = require("../middleware/requireAdmin");
const { sanitizeThemeTokens } = require("../theme/validateTokens");

// List
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
  const { key, name, tokens } = req.body || {};
  if (!key || !name) return res.status(400).json({ error: "key and name required" });

  const safeTokens = sanitizeThemeTokens(tokens);

  const { rows } = await db.query(
    "INSERT INTO platform_themes (key, name, tokens_json, is_published) VALUES ($1, $2, $3::jsonb, FALSE) RETURNING key, name, version, is_published",
    [key, name, JSON.stringify(safeTokens)]
  );
  res.status(201).json({ theme: rows[0] });
});

// Update (draft)
router.put("/:key", requireAdmin, async (req, res) => {
  const { key } = req.params;
  const { name, tokens } = req.body || {};
  const safeTokens = sanitizeThemeTokens(tokens);

  const { rows } = await db.query(
    "UPDATE platform_themes SET name = COALESCE($2, name), tokens_json = $3::jsonb, version = version + 1 WHERE key = $1 RETURNING key, name, version, is_published",
    [key, name ?? null, JSON.stringify(safeTokens)]
  );
  if (!rows[0]) return res.status(404).json({ error: "Theme not found" });
  res.json({ theme: rows[0] });
});

// Publish
router.post("/:key/publish", requireAdmin, async (req, res) => {
  const { key } = req.params;
  const { rows } = await db.query(
    "UPDATE platform_themes SET is_published = TRUE WHERE key = $1 RETURNING key, name, version, is_published",
    [key]
  );
  if (!rows[0]) return res.status(404).json({ error: "Theme not found" });
  res.json({ theme: rows[0] });
});

module.exports = router;
