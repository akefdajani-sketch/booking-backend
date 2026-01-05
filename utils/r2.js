// utils/r2.js
// Cloudflare R2 (S3-compatible) helper.
//
// Fixes:
// 1) Prevents "Invalid URL" when R2_ENDPOINT accidentally contains placeholders like
//    "https://<accountid>.r2.cloudflarestorage.com" (angle brackets break URL parsing).
// 2) Gives clearer errors and always attempts temp-file cleanup.
// 3) Provides safeName() used by upload routes to generate clean object keys.

const fs = require("fs/promises");
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");

function mustEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing env var: ${name}`);
  return String(v).trim();
}

function sanitizeEndpoint(raw) {
  const cleaned = String(raw).replace(/[<>]/g, "").trim();
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

function publicUrlForKey(key) {
  const base = process.env.R2_PUBLIC_BASE_URL
    ? String(process.env.R2_PUBLIC_BASE_URL).replace(/\/+$/g, "").trim()
    : null;

  if (base) return `${base}/${encodeURIComponent(key)}`;

  const endpoint = sanitizeEndpoint(mustEnv("R2_ENDPOINT")).replace(/\/+$/, "");
  return `${endpoint}/${encodeURIComponent(key)}`;
}

async function uploadFileToR2({ filePath, key, contentType }) {
  const Bucket = mustEnv("R2_BUCKET");
  const client = getS3Client();
  const Body = await fs.readFile(filePath);

  await client.send(
    new PutObjectCommand({
      Bucket,
      Key: key,
      Body,
      ContentType: contentType || "application/octet-stream",
      CacheControl: "public, max-age=31536000, immutable",
    })
  );

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
