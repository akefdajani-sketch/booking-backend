const express = require('express');
const multer = require('multer');
const router = express.Router();

const db = require('../db'); // adapt to your repo
const {
  createMediaAsset,
  listMediaAssets,
  getMediaAssetById,
  updateMediaAsset,
  deleteMediaAsset,
  upsertMediaAssignment,
  removeMediaAssignment,
  listMediaAssignments,
  syncLegacyFieldForAssignment,
} = require('../utils/mediaLibrary');
const {
  inferMediaKindFromMime,
  isAllowedMediaMime,
  buildTenantMediaKey,
  uploadBufferToR2,
} = require('../utils/r2');

// TODO: replace with your real auth middleware.
// const { requireTenantEditor } = require('../middleware/auth');

const upload = multer({ storage: multer.memoryStorage() });

function parseTenantId(req) {
  const n = Number(req.params.tenantId);
  if (!Number.isFinite(n)) throw new Error('Invalid tenantId');
  return n;
}

function parseEntityId(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

router.post('/:tenantId/assets', upload.single('file'), async (req, res, next) => {
  try {
    const tenantId = parseTenantId(req);
    const file = req.file;
    if (!file) return res.status(400).json({ ok: false, error: 'Missing file' });
    if (!isAllowedMediaMime(file.mimetype)) {
      return res.status(400).json({ ok: false, error: 'Unsupported media type' });
    }

    const kind = req.body.kind || inferMediaKindFromMime(file.mimetype);
    const usageType = req.body.usageType || 'general';
    const storageKey = buildTenantMediaKey({
      tenantId,
      kind,
      usageType,
      filename: file.originalname,
    });

    const uploaded = await uploadBufferToR2({
      key: storageKey,
      buffer: file.buffer,
      contentType: file.mimetype,
    });

    const asset = await createMediaAsset(db, {
      tenantId,
      kind,
      usageType,
      title: req.body.title || null,
      altText: req.body.altText || null,
      caption: req.body.caption || null,
      storageKey,
      publicUrl: uploaded.publicUrl,
      mimeType: file.mimetype,
      fileSize: file.size || null,
      width: null,
      height: null,
      durationSeconds: null,
      createdBy: req.user?.id || null,
    });

    res.json({ ok: true, asset });
  } catch (err) {
    next(err);
  }
});

router.get('/:tenantId/assets', async (req, res, next) => {
  try {
    const tenantId = parseTenantId(req);
    const limit = req.query.limit ? Number(req.query.limit) : 24;
    const offset = req.query.offset ? Number(req.query.offset) : 0;
    const items = await listMediaAssets(db, {
      tenantId,
      kind: req.query.kind,
      usageType: req.query.usageType,
      q: req.query.q,
      isActive: req.query.isActive === undefined ? true : req.query.isActive === 'true',
      limit,
      offset,
    });

    res.json({ ok: true, items, pagination: { limit, offset, count: items.length } });
  } catch (err) {
    next(err);
  }
});

router.patch('/:tenantId/assets/:assetId', async (req, res, next) => {
  try {
    const tenantId = parseTenantId(req);
    const assetId = Number(req.params.assetId);
    const asset = await updateMediaAsset(db, {
      tenantId,
      assetId,
      title: req.body.title,
      altText: req.body.altText,
      caption: req.body.caption,
      usageType: req.body.usageType,
      isActive: req.body.isActive,
    });
    res.json({ ok: true, asset });
  } catch (err) {
    next(err);
  }
});

router.delete('/:tenantId/assets/:assetId', async (req, res, next) => {
  try {
    const tenantId = parseTenantId(req);
    const assetId = Number(req.params.assetId);
    await deleteMediaAsset(db, { tenantId, assetId });
    res.json({ ok: true, deleted: true, mode: 'soft' });
  } catch (err) {
    next(err);
  }
});

router.put('/:tenantId/assign', async (req, res, next) => {
  try {
    const tenantId = parseTenantId(req);
    const mediaAssetId = Number(req.body.mediaAssetId);
    const entityType = req.body.entityType;
    const entityId = parseEntityId(req.body.entityId);
    const slot = req.body.slot;
    const metadata = req.body.metadata || {};

    const asset = await getMediaAssetById(db, { tenantId, assetId: mediaAssetId });
    if (!asset) return res.status(404).json({ ok: false, error: 'Asset not found' });

    const assignment = await upsertMediaAssignment(db, {
      tenantId,
      mediaAssetId,
      entityType,
      entityId,
      slot,
      metadata,
    });

    const legacySync = await syncLegacyFieldForAssignment(db, {
      tenantId,
      entityType,
      entityId,
      slot,
      asset,
    });

    res.json({ ok: true, assignment, asset, legacySync });
  } catch (err) {
    next(err);
  }
});

router.delete('/:tenantId/assign', async (req, res, next) => {
  try {
    const tenantId = parseTenantId(req);
    const entityType = req.body.entityType || req.query.entityType;
    const entityId = parseEntityId(req.body.entityId ?? req.query.entityId);
    const slot = req.body.slot || req.query.slot;
    await removeMediaAssignment(db, { tenantId, entityType, entityId, slot });
    res.json({ ok: true, removed: true });
  } catch (err) {
    next(err);
  }
});

router.get('/:tenantId/assignments', async (req, res, next) => {
  try {
    const tenantId = parseTenantId(req);
    const items = await listMediaAssignments(db, {
      tenantId,
      entityType: req.query.entityType,
      entityId: parseEntityId(req.query.entityId),
      slot: req.query.slot,
    });
    res.json({ ok: true, items });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
