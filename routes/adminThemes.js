const express = require("express");
const router = express.Router();
const db = require("../db");
const { requireAdmin } = require("../middleware/requireAdmin");
const { sanitizeThemeTokens } = require("../theme/validateTokens");

router.get("/", requireAdmin, async (req, res) => {
  const { rows } = await db.query("SELECT key, name, version, is_published FROM platform_themes");
  res.json({ themes: rows });
});

router.post("/", requireAdmin, async (req, res) => {
  const { key, name, tokens } = req.body;
  const safe = sanitizeThemeTokens(tokens);
  const { rows } = await db.query(
    "INSERT INTO platform_themes (key, name, tokens_json) VALUES ($1,$2,$3::jsonb) RETURNING *",
    [key, name, JSON.stringify(safe)]
  );
  res.json({ theme: rows[0] });
});

module.exports = router;
