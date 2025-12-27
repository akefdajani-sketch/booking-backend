// src/middleware/upload.js

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");

// Hardened file uploads
const uploadDir = path.join(__dirname, "..", "uploads");

// Ensure uploads directory exists
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Only allow image uploads (no SVG by default for safety)
const ALLOWED_MIME = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

function safeUploadFilename(file) {
  const ext = ALLOWED_MIME.get(file.mimetype);
  const rand = crypto.randomBytes(8).toString("hex");
  const ts = Date.now();
  // No user-provided filename is used (prevents weird chars/path tricks)
  return `img-${ts}-${rand}.${ext}`;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, safeUploadFilename(file)),
});

const upload = multer({
  storage,
  limits: {
    fileSize: 2 * 1024 * 1024, // 2MB
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(
        new Error("Invalid file type. Only JPG, PNG, or WEBP are allowed.")
      );
    }
    cb(null, true);
  },
});

// Friendly multer error handler for upload endpoints
function uploadErrorHandler(err, req, res, next) {
  if (!err) return next();

  // Multer limit errors
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "File too large (max 2MB)." });
  }

  return res.status(400).json({ error: err.message || "Upload failed." });
}

module.exports = {
  uploadDir,
  upload,
  uploadErrorHandler,
};
