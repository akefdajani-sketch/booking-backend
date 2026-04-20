// meAvatar.js
// ---------------------------------------------------------------------------
// PR 130 — customer self-service avatar upload/delete.
//
// Mounted by routes/customers.js alongside the other me* route files.
// Frontend caller: components/booking/ui/ImageUpload.tsx (Patch 104) via
// PublicBookingContent.tsx's onUploadAvatar / onRemoveAvatar handlers.
//
// Endpoints:
//   POST   /customers/me/avatar    — multipart upload (field name: "file"),
//                                    tenantSlug in form field OR query string.
//   DELETE /customers/me/avatar    — clears avatar_url.
//
// Design choice (vs. patch 121's URL-only 2-step flow):
// We do the upload and the DB write in one round-trip. The frontend sends
// multipart FormData to POST /me/avatar; we use multer disk storage to
// stage the file, then utils/r2.uploadFileToR2() streams it to Cloudflare
// R2 (reusing the same R2 infra already in place for tenant media). Multer's
// disk file is cleaned up by uploadFileToR2() on both success and failure.
//
// The existing media-library route (routes/mediaLibrary.js) uses a buffer-
// based helper that doesn't currently exist in utils/r2 — we deliberately
// avoid that code path and stick to the path-based helper that works today.
// ---------------------------------------------------------------------------

const express = require("express");
const multer = require("multer");
const os = require("os");
const path = require("path");
const fs = require("fs");

const { pool } = require("../../db");
const requireAppAuth = require("../../middleware/requireAppAuth");
const { uploadFileToR2 } = require("../../utils/r2");

const db = pool;

// ─── Multer config ──────────────────────────────────────────────────────────
// Disk storage (temp dir) so we can hand the path to uploadFileToR2, which
// streams via fs.createReadStream. Multer auto-cleans on failure when we call
// unlink; uploadFileToR2 also unlinks on success path.

const UPLOAD_TMP_DIR = path.join(os.tmpdir(), "bf-customer-avatar-uploads");
try {
  fs.mkdirSync(UPLOAD_TMP_DIR, { recursive: true });
} catch (_) {
  // Ignore — the mkdirSync on a pre-existing dir is a no-op; surface real
  // permission errors later when multer actually tries to write.
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_TMP_DIR),
    filename: (_req, file, cb) => {
      const ts = Date.now();
      const rand = Math.random().toString(36).slice(2, 10);
      const extFromName = path.extname(String(file.originalname || ""));
      const safeExt = /^\.[a-z0-9]{1,8}$/i.test(extFromName) ? extFromName.toLowerCase() : "";
      cb(null, `${ts}-${rand}${safeExt}`);
    },
  }),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB cap — avatars should be small
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    const mime = String(file.mimetype || "").toLowerCase();
    if (/^image\/(png|jpe?g|webp|gif)$/.test(mime)) return cb(null, true);
    // Reject without crashing — multer surfaces this as req.fileValidationError
    // OR as an Error when we throw. Use Error so we catch it in the handler.
    return cb(new Error("Only image uploads are allowed (png, jpg, webp, gif)."));
  },
});

// Small helper to unlink a file without throwing (best-effort cleanup)
function safeUnlink(p) {
  if (!p) return;
  fs.promises.unlink(p).catch(() => {});
}

// Multer errors come through as an error middleware; wrap upload.single so
// we can convert them into JSON 400 responses instead of bubbling to the
// Express default handler (which renders HTML).
function uploadSingleOr400(fieldName) {
  return function (req, res, next) {
    upload.single(fieldName)(req, res, (err) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        // e.g. LIMIT_FILE_SIZE → 400 with readable message
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({ error: "Image is too large. Max 5 MB." });
        }
        return res.status(400).json({ error: err.message || "Upload rejected." });
      }
      // Custom fileFilter errors land here
      return res.status(400).json({ error: err.message || "Upload rejected." });
    });
  };
}

module.exports = function mount(router) {
  // POST — upload + store avatar for the signed-in customer
  router.post(
    "/me/avatar",
    requireAppAuth,
    uploadSingleOr400("file"),
    async (req, res) => {
      const tmpPath = req.file?.path || null;
      try {
        // tenantSlug arrives either as a multipart form field OR as a query
        // parameter. The frontend proxy currently only auto-injects tenantSlug
        // into JSON / urlencoded bodies, NOT multipart — so supporting the
        // query param is important for that path.
        const tenantSlug = String(
          (req.body && req.body.tenantSlug) ||
            (req.query && req.query.tenantSlug) ||
            ""
        ).trim();

        if (!tenantSlug) {
          safeUnlink(tmpPath);
          return res.status(400).json({ error: "Missing tenantSlug." });
        }
        if (!req.file) {
          return res.status(400).json({ error: "Missing file." });
        }

        // Resolve tenant
        const tRes = await db.query(
          `SELECT id FROM tenants WHERE slug = $1 LIMIT 1`,
          [tenantSlug]
        );
        const tenantId = tRes.rows?.[0]?.id;
        if (!tenantId) {
          safeUnlink(tmpPath);
          return res.status(400).json({ error: "Unknown tenant." });
        }

        const googleEmail = req.googleUser?.email || null;
        if (!googleEmail) {
          safeUnlink(tmpPath);
          return res.status(401).json({ error: "Missing Google email." });
        }

        // Resolve customer row BEFORE uploading to R2 — so we fail fast if
        // the signed-in user has no customer record for this tenant, avoiding
        // an orphaned R2 object.
        const cust = await db.query(
          `SELECT id FROM customers
             WHERE tenant_id = $1
               AND LOWER(email) = LOWER($2)
             LIMIT 1`,
          [tenantId, googleEmail]
        );
        if (cust.rowCount === 0) {
          safeUnlink(tmpPath);
          return res
            .status(404)
            .json({ error: "Customer not found for this tenant." });
        }
        const customerId = cust.rows[0].id;

        // Build a tenant + customer scoped R2 key. Random suffix prevents
        // cache issues when a customer re-uploads (R2 public URL is cached
        // aggressively by our CDN settings in uploadFileToR2).
        const originalExt = path
          .extname(String(req.file.originalname || ""))
          .replace(/[^a-zA-Z0-9.]/g, "")
          .toLowerCase();
        const ext = originalExt || ".bin";
        const rand = Math.random().toString(36).slice(2, 12);
        const key = `customer-avatars/${tenantId}/${customerId}/${Date.now()}-${rand}${ext}`;

        // Upload — this also unlinks the temp file via its finally{}
        const uploaded = await uploadFileToR2({
          filePath: tmpPath,
          key,
          contentType: req.file.mimetype || "application/octet-stream",
        });

        const publicUrl = String(uploaded?.url || "").trim();
        if (!publicUrl) {
          return res.status(500).json({ error: "Upload succeeded but URL is empty." });
        }

        // Persist URL against the customer row
        const upd = await db.query(
          `UPDATE customers
              SET avatar_url = $1
            WHERE id = $2
              AND tenant_id = $3
            RETURNING avatar_url`,
          [publicUrl, customerId, tenantId]
        );

        if (upd.rowCount === 0) {
          // Very unlikely race — customer was deleted between our SELECT and
          // the UPDATE. Return the URL anyway; the caller can decide.
          return res.status(409).json({ error: "Customer row disappeared during upload." });
        }

        return res.json({ ok: true, avatar_url: upd.rows[0].avatar_url });
      } catch (err) {
        console.error("[customers/me/avatar POST] error:", err?.message);
        safeUnlink(tmpPath);
        // Surface R2 config errors clearly to speed up ops debugging, without
        // leaking internals to end users.
        const raw = String(err?.message || "");
        if (/Missing env var: R2_/i.test(raw)) {
          return res.status(500).json({ error: "Avatar storage is not configured on this server." });
        }
        return res.status(500).json({ error: "Failed to upload avatar." });
      }
    }
  );

  // DELETE — clear the avatar URL.
  // Note: we intentionally do NOT delete the R2 object. Keeping historical
  // avatars (orphaned) is cheap and allows hypothetical recovery. A future
  // sweep job can garbage-collect by joining against the live column.
  router.delete("/me/avatar", requireAppAuth, async (req, res) => {
    try {
      const tenantSlug = String(
        (req.body && req.body.tenantSlug) ||
          (req.query && req.query.tenantSlug) ||
          ""
      ).trim();

      if (!tenantSlug) return res.status(400).json({ error: "Missing tenantSlug." });

      const tRes = await db.query(
        `SELECT id FROM tenants WHERE slug = $1 LIMIT 1`,
        [tenantSlug]
      );
      const tenantId = tRes.rows?.[0]?.id;
      if (!tenantId) return res.status(400).json({ error: "Unknown tenant." });

      const googleEmail = req.googleUser?.email || null;
      if (!googleEmail) return res.status(401).json({ error: "Missing Google email." });

      const upd = await db.query(
        `UPDATE customers
            SET avatar_url = NULL
          WHERE tenant_id = $1
            AND LOWER(email) = LOWER($2)
          RETURNING id`,
        [tenantId, googleEmail]
      );

      if (upd.rowCount === 0) {
        return res.status(404).json({ error: "Customer not found for this tenant." });
      }

      return res.json({ ok: true });
    } catch (err) {
      console.error("[customers/me/avatar DELETE] error:", err?.message);
      return res.status(500).json({ error: "Failed to clear avatar." });
    }
  });
};
