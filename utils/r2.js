// utils/r2.js
// Cloudflare R2 (S3-compatible) helper.
//
// Key points:
// - Uses AWS SDK S3 client pointed at R2_ENDPOINT
// - Builds PUBLIC URLs using R2_PUBLIC_BASE_URL (recommended) or falls back to R2_ENDPOINT
// - Avoids encoding '/' into '%2F' by encoding path segments only
// - Provides safeName() used by upload routes
// - Best-effort cleanup of temp uploads

const fs = require("fs/promises");
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");

function mustEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing env var: ${name}`);
  return String(v).trim();
}

function sanitizeEndpoint(raw) {
  // People sometimes paste placeholder endpoint like: https://<accountid>.r2.cloudflarestorage.com
  // Angle brackets break URL parsing.
  const cleaned = String(raw || "").replace(/[<>]/g, "").trim();
  if (!cleaned) throw new Error("Missing env var: R2_ENDPOINT");
  if (!/^https?:\/\//i.test(cleaned)) return `https://${cleaned}`;
  return cleaned;
}

function safeName(name) {
  const base = String(name || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .replace(/-+/g, "-");
  return base || "file";
}

function getS3Client() {
  const endpoint = sanitizeEndpoint(mustEnv("R2_ENDPOINT"));
  const region = process.env.R2_REGION ? String(process.env.R2_REGION).trim() : "auto";

  return new S3Client({
    region,
    endpoint,
    credentials: {
      accessKeyId: mustEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: mustEnv("R2_SECRET_ACCESS_KEY"),
    },
  });
}

function encodeKeyPath(key) {
  // IMPORTANT: encode each segment (not the slashes)
  return String(key)
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

function publicUrlForKey(key) {
  const safePath = encodeKeyPath(key);

  const base = process.env.R2_PUBLIC_BASE_URL
    ? String(process.env.R2_PUBLIC_BASE_URL).replace(/\/+$/g, "").trim()
    : null;

  if (base) return `${base}/${safePath}`;

  const endpoint = sanitizeEndpoint(mustEnv("R2_ENDPOINT")).replace(/\/+$/g, "");
  return `${endpoint}/${safePath}`;
}

async function uploadFileToR2({ filePath, key, contentType }) {
  if (!filePath) throw new Error("uploadFileToR2: filePath is required");
  if (!key) throw new Error("uploadFileToR2: key is required");

  try {
    await fs.access(filePath);
  } catch {
    throw new Error(`uploadFileToR2: temp file does not exist at ${filePath}`);
  }

  const Bucket = mustEnv("R2_BUCKET");
  const client = getS3Client();
  const Body = await fs.readFile(filePath);

  try {
    await client.send(
      new PutObjectCommand({
        Bucket,
        Key: key,
        Body,
        ContentType: contentType || "application/octet-stream",
        CacheControl: "public, max-age=31536000, immutable",
      })
    );
  } finally {
    // Best-effort cleanup of temp file
    await fs.unlink(filePath).catch(() => {});
  }

  return { key, url: publicUrlForKey(key) };
}

async function deleteFromR2(key) {
  if (!key) return;
  const Bucket = mustEnv("R2_BUCKET");
  const client = getS3Client();
  await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
}

module.exports = {
  uploadFileToR2,
  deleteFromR2,
  publicUrlForKey,
  sanitizeEndpoint,
  safeName,
};
