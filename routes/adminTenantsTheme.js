import express from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import db from "../db.js";

const router = express.Router();

router.put("/:tenantId/theme", requireAdmin, async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const { theme_key } = req.body || {};
  if (!tenantId || !theme_key) return res.status(400).json({ error: "tenantId + theme_key required" });

  // ensure theme exists + published
  const theme = await db.query(
    `SELECT key FROM platform_themes WHERE key = $1 AND is_published = TRUE`,
    [theme_key]
  );
  if (!theme.rows[0]) return res.status(400).json({ error: "Theme not found or not published" });

  const { rows } = await db.query(
    `UPDATE tenants SET theme_key = $2 WHERE id = $1 RETURNING id, slug, theme_key`,
    [tenantId, theme_key]
  );
  res.json({ tenant: rows[0] });
});

export default router;
