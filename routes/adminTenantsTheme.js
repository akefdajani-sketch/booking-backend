const express = require("express");
const router = express.Router();
const db = require("../db");
const requireAdmin = require("../middleware/requireAdmin");

// PUT /api/admin/tenants/:tenantId/theme  { theme_key }
router.put("/:tenantId/theme", requireAdmin, async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const { theme_key } = req.body || {};
  if (!tenantId || !theme_key) {
    return res.status(400).json({ error: "tenantId and theme_key required" });
  }

  const theme = await db.query(
    "SELECT key FROM platform_themes WHERE key = $1 AND is_published = TRUE",
    [theme_key]
  );
  if (!theme.rows[0]) return res.status(400).json({ error: "Theme not found or not published" });

  const { rows } = await db.query(
    "UPDATE tenants SET theme_key = $2 WHERE id = $1 RETURNING id, slug, theme_key",
    [tenantId, theme_key]
  );

  res.json({ tenant: rows[0] });
});

module.exports = router;
