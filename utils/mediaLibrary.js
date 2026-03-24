// PR-MEDIA-1 media library domain service
// Adapt db import usage and home-landing helper imports to your actual repo.

async function createMediaAsset(db, {
  tenantId,
  kind,
  usageType = 'general',
  title = null,
  altText = null,
  caption = null,
  storageKey,
  publicUrl,
  mimeType = null,
  fileSize = null,
  width = null,
  height = null,
  durationSeconds = null,
  createdBy = null,
}) {
  const sql = `
    INSERT INTO media_assets (
      tenant_id, kind, usage_type, title, alt_text, caption,
      storage_key, public_url, mime_type, file_size,
      width, height, duration_seconds, created_by
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    RETURNING *
  `;
  const params = [
    tenantId, kind, usageType, title, altText, caption,
    storageKey, publicUrl, mimeType, fileSize,
    width, height, durationSeconds, createdBy,
  ];
  const { rows } = await db.query(sql, params);
  return rows[0];
}

async function listMediaAssets(db, { tenantId, kind, usageType, q, isActive = true, limit = 24, offset = 0 }) {
  const where = ['tenant_id = $1'];
  const params = [tenantId];
  let idx = 2;

  if (typeof isActive === 'boolean') {
    where.push(`is_active = $${idx++}`);
    params.push(isActive);
  }
  if (kind) {
    where.push(`kind = $${idx++}`);
    params.push(kind);
  }
  if (usageType) {
    where.push(`usage_type = $${idx++}`);
    params.push(usageType);
  }
  if (q) {
    where.push(`(
      COALESCE(title, '') ILIKE $${idx}
      OR COALESCE(alt_text, '') ILIKE $${idx}
      OR COALESCE(caption, '') ILIKE $${idx}
    )`);
    params.push(`%${q}%`);
    idx += 1;
  }

  params.push(limit, offset);
  const sql = `
    SELECT *
    FROM media_assets
    WHERE ${where.join(' AND ')}
    ORDER BY created_at DESC
    LIMIT $${idx++}
    OFFSET $${idx++}
  `;
  const { rows } = await db.query(sql, params);
  return rows;
}

async function getMediaAssetById(db, { tenantId, assetId }) {
  const { rows } = await db.query(
    'SELECT * FROM media_assets WHERE tenant_id = $1 AND id = $2 LIMIT 1',
    [tenantId, assetId]
  );
  return rows[0] || null;
}

async function updateMediaAsset(db, { tenantId, assetId, title, altText, caption, usageType, isActive }) {
  const fields = [];
  const params = [tenantId, assetId];
  let idx = 3;

  if (title !== undefined) { fields.push(`title = $${idx++}`); params.push(title); }
  if (altText !== undefined) { fields.push(`alt_text = $${idx++}`); params.push(altText); }
  if (caption !== undefined) { fields.push(`caption = $${idx++}`); params.push(caption); }
  if (usageType !== undefined) { fields.push(`usage_type = $${idx++}`); params.push(usageType); }
  if (isActive !== undefined) { fields.push(`is_active = $${idx++}`); params.push(isActive); }

  if (!fields.length) return getMediaAssetById(db, { tenantId, assetId });

  const { rows } = await db.query(
    `UPDATE media_assets SET ${fields.join(', ')} WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    params
  );
  return rows[0] || null;
}

async function deleteMediaAsset(db, { tenantId, assetId }) {
  const { rows } = await db.query(
    'UPDATE media_assets SET is_active = false WHERE tenant_id = $1 AND id = $2 RETURNING *',
    [tenantId, assetId]
  );
  return rows[0] || null;
}

async function upsertMediaAssignment(db, { tenantId, mediaAssetId, entityType, entityId = null, slot, metadata = {} }) {
  const sql = `
    INSERT INTO media_asset_links (tenant_id, media_asset_id, entity_type, entity_id, slot, metadata)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb)
    ON CONFLICT (tenant_id, entity_type, COALESCE(entity_id, 0), slot)
    DO UPDATE SET
      media_asset_id = EXCLUDED.media_asset_id,
      metadata = EXCLUDED.metadata,
      updated_at = now()
    RETURNING *
  `;
  const { rows } = await db.query(sql, [tenantId, mediaAssetId, entityType, entityId, slot, JSON.stringify(metadata || {})]);
  return rows[0];
}

async function removeMediaAssignment(db, { tenantId, entityType, entityId = null, slot }) {
  const { rows } = await db.query(
    `DELETE FROM media_asset_links
     WHERE tenant_id = $1
       AND entity_type = $2
       AND COALESCE(entity_id, 0) = COALESCE($3, 0)
       AND slot = $4
     RETURNING *`,
    [tenantId, entityType, entityId, slot]
  );
  return rows[0] || null;
}

async function listMediaAssignments(db, { tenantId, entityType, entityId = null, slot }) {
  const where = ['l.tenant_id = $1', 'l.entity_type = $2'];
  const params = [tenantId, entityType];
  let idx = 3;

  if (entityId !== undefined) {
    where.push(`COALESCE(l.entity_id, 0) = COALESCE($${idx++}, 0)`);
    params.push(entityId);
  }
  if (slot) {
    where.push(`l.slot = $${idx++}`);
    params.push(slot);
  }

  const sql = `
    SELECT l.*, row_to_json(a.*) AS asset
    FROM media_asset_links l
    JOIN media_assets a ON a.id = l.media_asset_id
    WHERE ${where.join(' AND ')}
    ORDER BY l.updated_at DESC
  `;
  const { rows } = await db.query(sql, params);
  return rows;
}

async function syncTenantLegacyFields(db, { tenantId, slot, asset }) {
  const map = {
    logo_primary: ['logo_url', 'logo_key'],
    logo_light: ['logo_light_url', 'logo_light_key'],
    logo_dark: ['logo_dark_url', 'logo_dark_key'],
    banner_home: ['banner_home_url', 'banner_home_key'],
    banner_book: ['banner_book_url', 'banner_book_key'],
    banner_reservations: ['banner_reservations_url', 'banner_reservations_key'],
    banner_memberships: ['banner_memberships_url', 'banner_memberships_key'],
    banner_packages: ['banner_packages_url', 'banner_packages_key'],
    banner_account: ['banner_account_url', 'banner_account_key'],
    memberships_image: ['memberships_image_url', 'memberships_image_key'],
    packages_image: ['packages_image_url', 'packages_image_key'],
  };
  const target = map[slot];
  if (!target) return null;
  const [urlCol, keyCol] = target;
  await db.query(`UPDATE tenants SET ${urlCol} = $2, ${keyCol} = $3 WHERE id = $1`, [tenantId, asset.public_url, asset.storage_key]);
  return { target: `tenants.${urlCol}`, value: asset.public_url };
}

async function getTenantHomeLandingConfig(db, tenantId) {
  // TODO: replace with your actual home-landing reader.
  const { rows } = await db.query('SELECT home_landing_config FROM tenants WHERE id = $1 LIMIT 1', [tenantId]);
  return rows[0]?.home_landing_config || {};
}

async function saveTenantHomeLandingConfig(db, tenantId, config) {
  // TODO: replace with your actual home-landing writer.
  await db.query('UPDATE tenants SET home_landing_config = $2 WHERE id = $1', [tenantId, JSON.stringify(config)]);
}

async function syncHomeLandingLegacyFields(db, { tenantId, slot, asset }) {
  const current = await getTenantHomeLandingConfig(db, tenantId);
  const next = JSON.parse(JSON.stringify(current || {}));
  next.homeLanding ??= {};
  next.homeLanding.birdie ??= {};

  if (slot === 'home_signature') {
    next.homeLanding.birdie.signatureSection ??= {};
    next.homeLanding.birdie.signatureSection.imageUrl = asset.public_url;
    await saveTenantHomeLandingConfig(db, tenantId, next);
    return { target: 'homeLanding.birdie.signatureSection.imageUrl', value: asset.public_url };
  }
  if (slot === 'home_visit_map') {
    next.homeLanding.birdie.visit ??= {};
    next.homeLanding.birdie.visit.mapImageUrl = asset.public_url;
    await saveTenantHomeLandingConfig(db, tenantId, next);
    return { target: 'homeLanding.birdie.visit.mapImageUrl', value: asset.public_url };
  }
  if (slot === 'home_hero') {
    next.homeLanding.birdie.hero ??= {};
    next.homeLanding.birdie.hero.heroImageUrl = asset.public_url;
    await saveTenantHomeLandingConfig(db, tenantId, next);
    return { target: 'homeLanding.birdie.hero.heroImageUrl', value: asset.public_url };
  }
  return null;
}

async function syncServiceLegacyFields(db, { entityId, slot, asset }) {
  if (!['thumbnail', 'card_image'].includes(slot)) return null;
  await db.query('UPDATE services SET image_url = $2 WHERE id = $1', [entityId, asset.public_url]);
  return { target: 'services.image_url', value: asset.public_url };
}

async function syncStaffLegacyFields(db, { entityId, slot, asset }) {
  if (!['thumbnail', 'card_image'].includes(slot)) return null;
  await db.query('UPDATE staff SET photo_url = $2, image_url = COALESCE(image_url, $2) WHERE id = $1', [entityId, asset.public_url]);
  return { target: 'staff.photo_url', value: asset.public_url };
}

async function syncResourceLegacyFields(db, { entityId, slot, asset }) {
  if (!['thumbnail', 'card_image'].includes(slot)) return null;
  await db.query('UPDATE resources SET image_url = $2 WHERE id = $1', [entityId, asset.public_url]);
  return { target: 'resources.image_url', value: asset.public_url };
}

async function syncMembershipPlanLegacyFields(db, { entityId, slot, asset }) {
  if (!['thumbnail', 'card_image'].includes(slot)) return null;
  await db.query('UPDATE membership_plans SET image_url = $2, image_key = $3 WHERE id = $1', [entityId, asset.public_url, asset.storage_key]);
  return { target: 'membership_plans.image_url', value: asset.public_url };
}

async function syncPrepaidProductLegacyFields(db, { entityId, slot, asset }) {
  if (!['thumbnail', 'card_image'].includes(slot)) return null;
  await db.query('UPDATE prepaid_products SET image_url = $2, image_key = $3 WHERE id = $1', [entityId, asset.public_url, asset.storage_key]);
  return { target: 'prepaid_products.image_url', value: asset.public_url };
}

async function syncLegacyFieldForAssignment(db, { tenantId, entityType, entityId, slot, asset }) {
  if (entityType === 'tenant') return syncTenantLegacyFields(db, { tenantId, slot, asset });
  if (entityType === 'home_landing') return syncHomeLandingLegacyFields(db, { tenantId, slot, asset });
  if (entityType === 'service') return syncServiceLegacyFields(db, { entityId, slot, asset });
  if (entityType === 'staff') return syncStaffLegacyFields(db, { entityId, slot, asset });
  if (entityType === 'resource') return syncResourceLegacyFields(db, { entityId, slot, asset });
  if (entityType === 'membership_plan') return syncMembershipPlanLegacyFields(db, { entityId, slot, asset });
  if (entityType === 'prepaid_product') return syncPrepaidProductLegacyFields(db, { entityId, slot, asset });
  return null;
}

module.exports = {
  createMediaAsset,
  listMediaAssets,
  getMediaAssetById,
  updateMediaAsset,
  deleteMediaAsset,
  upsertMediaAssignment,
  removeMediaAssignment,
  listMediaAssignments,
  syncLegacyFieldForAssignment,
  getTenantHomeLandingConfig,
  saveTenantHomeLandingConfig,
};
