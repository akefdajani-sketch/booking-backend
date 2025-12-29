// src/utils/r2.js
const fs = require("fs");
const path = require("path");
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

const R2 = {
  bucket: () => required("R2_BUCKET"),
  publicBaseUrl: () => required("R2_PUBLIC_BASE_URL").replace(/\/$/, ""),
};

const s3 = new S3Client({
  region: process.env.R2_REGION || "auto",
  endpoint: required("R2_ENDPOINT"),
  credentials: {
    accessKeyId: required("R2_ACCESS_KEY_ID"),
    secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
  },
});

function safeName(name) {
  return String(name || "file")
    .toLowerCase()
    .replace(/[^a-z0-9.\-_]/g, "-")
    .replace(/-+/g, "-");
}

async function uploadFileToR2({ filePath, contentType, key }) {
  const body = await fs.promises.readFile(filePath);

  await s3.send(
    new PutObjectCommand({
      Bucket: R2.bucket(),
      Key: key,
      Body: body,
      ContentType: contentType || "application/octet-stream",
    })
  );

  // Remove temp file after upload
  await fs.promises.unlink(filePath).catch(() => {});

  const url = `${R2.publicBaseUrl()}/${key}`;
  return { key, url };
}

async function deleteFromR2(key) {
  if (!key) return;
  await s3.send(
    new DeleteObjectCommand({
      Bucket: R2.bucket(),
      Key: key,
    })
  );
}

module.exports = {
  uploadFileToR2,
  deleteFromR2,
  safeName,
};
