const express = require("express");
const router = express.Router();
const db = require("../db");
const { requireAdmin } = require("../middleware/requireAdmin");

router.put("/:tenantId/theme", requireAdmin, async (req, res) => {
  const { tenantId } = req.params;
  const { theme_key } = req.body;
  const { rows } = await db.query(
    "UPDATE tenants SET theme_key=$2 WHERE id=$1 RETURNING id, slug, theme_key",
    [tenantId, theme_key]
  );
  res.json({ tenant: rows[0] });
});

module.exports = router;
