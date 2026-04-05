// routes/resources/gallery.js
// ---------------------------------------------------------------------------
// Resource Gallery — multi-image management
//
// Mounted by routes/resources.js:
//   require('./resources/gallery')(router);
//
// Endpoints:
//   GET    /:id/gallery           list all gallery images (sorted)
//   POST   /:id/gallery           upload + attach a new image
//   PATCH  /:id/gallery/reorder   update sort_order for all images
//   DELETE /:id/gallery/:imgId    remove one gallery image
// ---------------------------------------------------------------------------

const { pool } = require('../../db');
const db = pool;
const requireAdminOrTenantRole = require('../../middleware/requireAdminOrTenantRole');
const { upload, uploadErrorHandler }   = require('../../middleware/upload');
const { uploadFileToR2, safeName, deleteFileFromR2 } = require('../../utils/r2');
const fs = require('fs/promises');

// Re-use the same tenant-from-resource resolver that resources.js uses
async function resolveTenantFromResourceId(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0)
      return res.status(400).json({ error: 'Invalid resource id' });

    const { rows } = await db.query(
      'SELECT tenant_id FROM resources WHERE id = $1',
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Resource not found' });

    req.tenantId = Number(rows[0].tenant_id);
    req.body = req.body || {};
    req.body.tenantId = req.tenantId;
    return next();
  } catch (e) {
    console.error('resolveTenantFromResourceId error:', e);
    return res.status(500).json({ error: 'Failed to resolve tenant.' });
  }
}

// ---------------------------------------------------------------------------
// GET /:id/gallery
// Returns all active gallery images for a resource, ordered by sort_order ASC
// ---------------------------------------------------------------------------
async function listGallery(req, res) {
  try {
    const resourceId = Number(req.params.id);
    if (!Number.isFinite(resourceId) || resourceId <= 0)
      return res.status(400).json({ error: 'Invalid resource id' });

    const { rows } = await db.query(
      `SELECT id, resource_id, public_url, storage_key, alt_text, caption,
              mime_type, width, height, file_size, sort_order, created_at
       FROM resource_gallery
       WHERE resource_id = $1 AND is_active = TRUE
       ORDER BY sort_order ASC, created_at ASC`,
      [resourceId]
    );

    return res.json({ images: rows });
  } catch (err) {
    console.error('listGallery error:', err);
    return res.status(500).json({ error: 'Failed to list gallery images.' });
  }
}

// ---------------------------------------------------------------------------
// POST /:id/gallery
// Upload a new image and attach it to the resource gallery.
// Multipart: field name = "file"
// Optional body fields: alt_text, caption
// ---------------------------------------------------------------------------
async function uploadGalleryImage(req, res) {
  let filePath = null;
  try {
    const resourceId = Number(req.params.id);
    if (!Number.isFinite(resourceId) || resourceId <= 0)
      return res.status(400).json({ error: 'Invalid resource id' });

    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    filePath = req.file.path;

    // Verify resource belongs to this tenant
    const { rows: rRows } = await db.query(
      'SELECT id, tenant_id FROM resources WHERE id = $1',
      [resourceId]
    );
    if (!rRows.length) return res.status(404).json({ error: 'Resource not found' });
    const tenantId = Number(rRows[0].tenant_id);

    // Build next sort_order
    const { rows: orderRows } = await db.query(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM resource_gallery WHERE resource_id = $1 AND is_active = TRUE',
      [resourceId]
    );
    const sortOrder = Number(orderRows[0]?.next_order ?? 0);

    // Upload to R2
    const key = `resources/${resourceId}/gallery/${Date.now()}-${safeName(req.file.originalname)}`;
    const { url } = await uploadFileToR2({
      filePath,
      contentType: req.file.mimetype,
      key,
    });

    // Parse optional metadata
    const altText  = req.body?.alt_text  || null;
    const caption  = req.body?.caption   || null;
    const width    = req.body?.width    ? Number(req.body.width)    : null;
    const height   = req.body?.height   ? Number(req.body.height)   : null;
    const fileSize = req.file?.size     || null;

    const { rows: inserted } = await db.query(
      `INSERT INTO resource_gallery
         (tenant_id, resource_id, storage_key, public_url, alt_text, caption,
          mime_type, width, height, file_size, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [tenantId, resourceId, key, url, altText, caption,
       req.file.mimetype, width, height, fileSize, sortOrder]
    );

    // If this is the first gallery image, also set it as the resource cover
    if (sortOrder === 0) {
      await db.query(
        'UPDATE resources SET image_url = $1 WHERE id = $2',
        [url, resourceId]
      );
    }

    return res.status(201).json({ image: inserted[0] });
  } catch (err) {
    console.error('uploadGalleryImage error:', err);
    return res.status(500).json({ error: 'Gallery upload failed.' });
  } finally {
    if (filePath) {
      fs.unlink(filePath).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// PATCH /:id/gallery/reorder
// Body: { order: [{ id: number, sort_order: number }, ...] }
// ---------------------------------------------------------------------------
async function reorderGallery(req, res) {
  try {
    const resourceId = Number(req.params.id);
    if (!Number.isFinite(resourceId) || resourceId <= 0)
      return res.status(400).json({ error: 'Invalid resource id' });

    const order = req.body?.order;
    if (!Array.isArray(order) || order.length === 0)
      return res.status(400).json({ error: 'order array is required' });

    // Validate entries
    for (const entry of order) {
      if (!Number.isFinite(Number(entry.id)) || !Number.isFinite(Number(entry.sort_order))) {
        return res.status(400).json({ error: 'Each entry needs id and sort_order as numbers' });
      }
    }

    // Update each entry — use a transaction for atomicity
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      for (const entry of order) {
        await client.query(
          'UPDATE resource_gallery SET sort_order = $1 WHERE id = $2 AND resource_id = $3',
          [Number(entry.sort_order), Number(entry.id), resourceId]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    // Return updated list
    const { rows } = await db.query(
      `SELECT id, resource_id, public_url, storage_key, alt_text, caption,
              sort_order, created_at
       FROM resource_gallery
       WHERE resource_id = $1 AND is_active = TRUE
       ORDER BY sort_order ASC`,
      [resourceId]
    );

    // Ensure cover image matches first gallery item
    if (rows.length > 0) {
      await db.query(
        'UPDATE resources SET image_url = $1 WHERE id = $2',
        [rows[0].public_url, resourceId]
      );
    }

    return res.json({ images: rows });
  } catch (err) {
    console.error('reorderGallery error:', err);
    return res.status(500).json({ error: 'Reorder failed.' });
  }
}

// ---------------------------------------------------------------------------
// DELETE /:id/gallery/:imgId
// Soft-deletes (is_active = FALSE) and best-effort deletes from R2
// ---------------------------------------------------------------------------
async function deleteGalleryImage(req, res) {
  try {
    const resourceId = Number(req.params.id);
    const imgId      = Number(req.params.imgId);
    if (!Number.isFinite(resourceId) || !Number.isFinite(imgId))
      return res.status(400).json({ error: 'Invalid ids' });

    const { rows } = await db.query(
      `UPDATE resource_gallery
       SET is_active = FALSE, updated_at = now()
       WHERE id = $1 AND resource_id = $2
       RETURNING storage_key, sort_order`,
      [imgId, resourceId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Image not found' });

    const { storage_key, sort_order } = rows[0];

    // Best-effort R2 cleanup
    if (storage_key && typeof deleteFileFromR2 === 'function') {
      deleteFileFromR2(storage_key).catch((e) =>
        console.warn('R2 delete failed (non-fatal):', e?.message)
      );
    }

    // If the deleted image was the cover (sort_order 0), update to next image
    if (sort_order === 0) {
      const { rows: nextRows } = await db.query(
        `SELECT public_url FROM resource_gallery
         WHERE resource_id = $1 AND is_active = TRUE
         ORDER BY sort_order ASC LIMIT 1`,
        [resourceId]
      );
      const nextUrl = nextRows[0]?.public_url ?? null;
      await db.query('UPDATE resources SET image_url = $1 WHERE id = $2', [nextUrl, resourceId]);
    }

    return res.json({ success: true, deletedId: imgId });
  } catch (err) {
    console.error('deleteGalleryImage error:', err);
    return res.status(500).json({ error: 'Delete failed.' });
  }
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------
module.exports = function mountGallery(router) {
  router.get(
    '/:id/gallery',
    listGallery
  );

  router.post(
    '/:id/gallery',
    resolveTenantFromResourceId,
    requireAdminOrTenantRole('manager'),
    upload.single('file'),
    uploadErrorHandler,
    uploadGalleryImage
  );

  router.patch(
    '/:id/gallery/reorder',
    resolveTenantFromResourceId,
    requireAdminOrTenantRole('manager'),
    reorderGallery
  );

  router.delete(
    '/:id/gallery/:imgId',
    resolveTenantFromResourceId,
    requireAdminOrTenantRole('manager'),
    deleteGalleryImage
  );
};
