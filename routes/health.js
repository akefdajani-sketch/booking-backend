const express = require("express");
const router = express.Router();
const { pool } = require("../db");

router.get("/db", async (req, res) => {
  try {
    const r = await pool.query("select now() as now, current_database() as db");
    res.json({ ok: true, ...r.rows[0] });
  } catch (err) {
    res.status(500).json({
      ok: false,
      message: err?.message,
      code: err?.code,
      detail: err?.detail,
      hint: err?.hint,
    });
  }
});

module.exports = router;
