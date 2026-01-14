const express = require("express");
const router = express.Router();
const db = require("../db");
const { requireAdmin } = require("../middleware/requireAdmin");
const { sanitizeThemeTokens } = require("../theme/validateTokens");

router.get("/", requireAdmin, async (req, res) => {
  const { rows } = await db.query(
    "SELECT key, name, version, is_published, updated_at FROM platform_themes ORDER BY updated_at DESC"
  );
  res.json({ themes: rows });
});

router.get("/:key", requireAdmin, async (req, res) => {
  const { key } = req.params;
  const { rows } = await db.query(
    "SELECT key, name, version, is_published, tokens_json FROM platform_themes WHERE key = $1",
    [key]
  );
  if (!rows[0]) return res.status(404).json({ error: "Theme not found" });
  res.json({ theme: rows[0] });
});

router.post("/", requireAdmin, async (req, res) => {
  const { key, name, tokens } = req.body || {};
  if (!key || !name) return res.status(400).json({ error: "key and name required" });

  const safeTokens = sanitizeThemeTokens(tokens);

  const { rows } = await db.query(
    "INSERT INTO platform_themes (key, name, tokens_json) VALUES ($1, $2, $3::jsonb) RETURNING key, name, version, is_published",
    [key, name, JSON.stringify(safeTokens)]
  );
  res.status(201).json({ theme: rows[0] });
});

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
