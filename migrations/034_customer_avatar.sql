-- 034_customer_avatar.sql
-- ---------------------------------------------------------------------------
-- PR 130 / backend companion to Patch 104 (A1.4 Avatar + ImageUpload)
--
-- Adds optional `avatar_url` column to the customers table. Customers can
-- upload an avatar via POST /customers/me/avatar — see routes/customers/meAvatar.js.
-- The URL is a Cloudflare R2 public URL managed by utils/r2.uploadFileToR2().
--
-- Nullable by design; all existing rows get NULL and behave as before.
--
-- History: This migration was originally drafted as patch 121 (URL-only 2-step
-- flow). Patch 130 supersedes patch 121 with a single-endpoint multipart
-- upload path, but the column shape is identical — installing 130 is an
-- idempotent drop-in for 121's schema change.
-- ---------------------------------------------------------------------------

BEGIN;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS avatar_url TEXT;

-- Helpful index for any future admin search on "has an avatar"
CREATE INDEX IF NOT EXISTS idx_customers_has_avatar
  ON customers (tenant_id)
  WHERE avatar_url IS NOT NULL;

COMMIT;
