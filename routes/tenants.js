// src/routes/tenants.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");

// paste your old handlers here, but change:
// app.get("/api/tenants", ...)  -> router.get("/", ...)
// app.get("/api/tenants/:id", ...) -> router.get("/:id", ...)

router.get("/", async (req, res) => {
  // paste logic
});

module.exports = router;
