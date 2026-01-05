// routes/uploads.js
const express = require("express");
const { upload, uploadErrorHandler } = require("../middleware/upload");
const { uploadFileToR2, safeName } = require("../utils/r2");
const path = require("path");
const db = require("../db");

const router = express.Router();

router.post(
  "/tenant-logo",
  upload.single("file"),
  uploadErrorHandler,
  async (req, res) => {
    try {
      const { tenantId } = req.body;
      if (!tenantId) return res.status(400).json({ error: "Missing tenantId" });
      if (!req.file) return res.status(400).json({ error: "Missing file" });

      const ext = path.extname(req.file.filename); // already safe
      const key = `tenants/${tenantId}/logo/${safeName("logo" + ext)}`;

      const { url } = await uploadFileToR2({
        filePath: req.file.path,
        contentType: req.file.mimetype,
        key,
      });

      await db.query(
        `UPDATE tenants SET logo_url=$1, logo_key=$2 WHERE id=$3`,
        [url, key, tenantId]
      );

      return res.json({ url, key });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Upload failed" });
    }
  }
);

module.exports = router;
