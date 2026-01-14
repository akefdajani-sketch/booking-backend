const express = require("express");
const router = express.Router();
const db = require("../db");

router.get("/:slug", async (req, res) => {
  const { slug } = req.params;
  const t = await db.query("SELECT * FROM tenants WHERE slug=$1", [slug]);
  if (!t.rows[0]) return res.status(404).json({ error: "Tenant not found" });

  const tenant = t.rows[0];
  const themeKey = tenant.theme_key || "default_v1";
  const th = await db.query("SELECT tokens_json FROM platform_themes WHERE key=$1", [themeKey]);

  res.json({
    tenant,
    theme: { key: themeKey, tokens: th.rows[0]?.tokens_json || {} }
  });
});

module.exports = router;
