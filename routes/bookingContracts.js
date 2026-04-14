'use strict';

// routes/bookingContracts.js
// PR-CONTRACT-1: Attach, retrieve, and delete contract files for bookings.
//
// Mount in app.js:
//   app.use('/api/booking-contracts', require('./routes/bookingContracts'));
//
// Endpoints:
//   POST   /api/booking-contracts/:bookingId/upload  — upload a PDF/doc (multipart)
//   GET    /api/booking-contracts/:bookingId          — get contract URL for a booking
//   DELETE /api/booking-contracts/:bookingId          — remove contract attachment
//
// All endpoints require tenant auth + staff role.
// The booking must belong to the requesting tenant (isolation enforced).

const express = require('express');
const router  = express.Router();
const path    = require('path');

const db     = require('../db');
const logger = require('../utils/logger');

const { upload, uploadErrorHandler } = require('../middleware/upload');
const { uploadFileToR2, safeName, deleteFromR2 } = require('../utils/r2');
const requireAppAuth           = require('../middleware/requireAppAuth');
const { requireTenant }        = require('../middleware/requireTenant');
const requireAdminOrTenantRole = require('../middleware/requireAdminOrTenantRole');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALLOWED_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/png',
]);

const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

async function getBookingForTenant(bookingId, tenantId) {
  const r = await db.query(
    `SELECT id, tenant_id, contract_url, contract_key, contract_name, booking_code
     FROM bookings
     WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    [bookingId, tenantId]
  );
  return r.rows?.[0] || null;
}

// ---------------------------------------------------------------------------
// POST /api/booking-contracts/:bookingId/upload
// ---------------------------------------------------------------------------
router.post(
  '/:bookingId/upload',
  requireAppAuth,
  requireTenant,
  requireAdminOrTenantRole('staff'),
  upload.single('file'),
  uploadErrorHandler,
  async (req, res) => {
    try {
      const tenantId  = Number(req.tenantId);
      const bookingId = Number(req.params.bookingId);

      if (!tenantId || !Number.isFinite(bookingId)) {
        return res.status(400).json({ error: 'Invalid request.' });
      }

      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded.' });
      }

      // Validate MIME type
      if (!ALLOWED_MIME.has(req.file.mimetype)) {
        return res.status(400).json({ error: 'File type not allowed. Use PDF, Word, JPEG, or PNG.' });
      }

      // Validate size
      if (req.file.size > MAX_SIZE_BYTES) {
        return res.status(400).json({ error: 'File too large. Maximum 10 MB.' });
      }

      // Verify booking belongs to tenant
      const booking = await getBookingForTenant(bookingId, tenantId);
      if (!booking) {
        return res.status(404).json({ error: 'Booking not found.' });
      }

      // Delete old contract file if one exists
      if (booking.contract_key) {
        try { await deleteFromR2(booking.contract_key); } catch (_) {}
      }

      // Build storage key
      const ext = path.extname(req.file.originalname || req.file.filename).toLowerCase() || '.pdf';
      const key = `tenants/${tenantId}/contracts/${bookingId}/${safeName('contract' + ext)}`;

      const { url } = await uploadFileToR2({
        filePath:    req.file.path,
        contentType: req.file.mimetype,
        key,
      });

      const originalName = String(req.file.originalname || '').trim().slice(0, 200) || `contract${ext}`;

      await db.query(
        `UPDATE bookings
         SET contract_url=$1, contract_key=$2, contract_name=$3
         WHERE id=$4`,
        [url, key, originalName, bookingId]
      );

      logger.info({ tenantId, bookingId, key }, 'PR-CONTRACT-1: contract uploaded');
      return res.json({ ok: true, url, name: originalName });
    } catch (err) {
      logger.error({ err }, 'POST /booking-contracts/:id/upload error');
      return res.status(500).json({ error: 'Upload failed.' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/booking-contracts/:bookingId
// ---------------------------------------------------------------------------
router.get(
  '/:bookingId',
  requireAppAuth,
  requireTenant,
  requireAdminOrTenantRole('staff'),
  async (req, res) => {
    try {
      const tenantId  = Number(req.tenantId);
      const bookingId = Number(req.params.bookingId);

      const booking = await getBookingForTenant(bookingId, tenantId);
      if (!booking) return res.status(404).json({ error: 'Booking not found.' });

      return res.json({
        bookingId,
        contractUrl:  booking.contract_url  || null,
        contractKey:  booking.contract_key  || null,
        contractName: booking.contract_name || null,
      });
    } catch (err) {
      logger.error({ err }, 'GET /booking-contracts/:id error');
      return res.status(500).json({ error: 'Failed to get contract.' });
    }
  }
);

// ---------------------------------------------------------------------------
// DELETE /api/booking-contracts/:bookingId
// ---------------------------------------------------------------------------
router.delete(
  '/:bookingId',
  requireAppAuth,
  requireTenant,
  requireAdminOrTenantRole('staff'),
  async (req, res) => {
    try {
      const tenantId  = Number(req.tenantId);
      const bookingId = Number(req.params.bookingId);

      const booking = await getBookingForTenant(bookingId, tenantId);
      if (!booking) return res.status(404).json({ error: 'Booking not found.' });

      if (!booking.contract_key) return res.json({ ok: true, deleted: false, message: 'No contract attached.' });

      // Delete from R2
      try { await deleteFromR2(booking.contract_key); } catch (_) {}

      await db.query(
        `UPDATE bookings SET contract_url=NULL, contract_key=NULL, contract_name=NULL WHERE id=$1`,
        [bookingId]
      );

      logger.info({ tenantId, bookingId }, 'PR-CONTRACT-1: contract deleted');
      return res.json({ ok: true, deleted: true });
    } catch (err) {
      logger.error({ err }, 'DELETE /booking-contracts/:id error');
      return res.status(500).json({ error: 'Failed to delete contract.' });
    }
  }
);

module.exports = router;
