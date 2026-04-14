// routes/tenantTax.js
// PR-TAX-1: Tenant tax & service charge configuration endpoints.
//
// Mounted at /api/tenant by app.js:
//   GET  /api/tenant/:slug/tax-config   → returns current tax config
//   PUT  /api/tenant/:slug/tax-config   → saves tax config (patch semantics)
//   GET  /api/public/:slug/tax-info     → public-safe summary (labels + rates only)
//
// The public endpoint is intentionally mounted here too (exported separately)
// so the same file owns all tax-config logic.

'use strict';

const express = require('express');
const router  = express.Router();

const { requireTenant }         = require('../middleware/requireTenant');
const { requireTenantRole }     = require('../middleware/requireTenantRole');
const requireAppAuth            = require('../middleware/requireAppAuth');
const logger                    = require('../utils/logger');

const {
  loadTenantTaxConfig,
  saveTenantTaxConfig,
  DEFAULT_TAX_CONFIG,
} = require('../utils/taxEngine');

// ─── Helper ────────────────────────────────────────────────────────────────────

function injectTenantSlug(req, _res, next) {
  req.query = req.query || {};
  req.query.tenantSlug = req.params.slug;
  next();
}

// ─── GET /api/tenant/:slug/tax-config ─────────────────────────────────────────
// Returns the full tax config for the owner dashboard.
// Requires: tenant role (owner / admin / manager).

router.get('/:slug/tax-config', injectTenantSlug, requireAppAuth, requireTenant, requireTenantRole(['owner', 'admin', 'manager']), async (req, res) => {
  try {
    const tenantId = Number(req.tenantId);
    if (!tenantId) return res.status(400).json({ error: 'Missing tenant context.' });

    const config = await loadTenantTaxConfig(tenantId);

    return res.json({ tax_config: config });
  } catch (err) {
    logger.error({ err }, 'GET tax-config error');
    return res.status(500).json({ error: 'Failed to load tax config.' });
  }
});

// ─── PUT /api/tenant/:slug/tax-config ─────────────────────────────────────────
// Saves (patch-merges) the tax config.
// Body shape mirrors DEFAULT_TAX_CONFIG — only send what you want to change.
// Requires: owner or admin role.

router.put('/:slug/tax-config', injectTenantSlug, requireAppAuth, requireTenant, requireTenantRole(['owner', 'admin']), async (req, res) => {
  try {
    const tenantId = Number(req.tenantId);
    if (!tenantId) return res.status(400).json({ error: 'Missing tenant context.' });

    const updates = req.body || {};

    // saveTenantTaxConfig validates + merges internally
    const saved = await saveTenantTaxConfig(tenantId, updates);

    logger.info({ tenantId, saved }, 'tax-config updated');
    return res.json({ tax_config: saved, message: 'Tax configuration saved.' });
  } catch (err) {
    logger.error({ err }, 'PUT tax-config error');
    if (err.message?.includes('migration 030')) {
      return res.status(503).json({ error: 'Tax feature not available yet. Database migration required.' });
    }
    return res.status(500).json({ error: 'Failed to save tax config.' });
  }
});

module.exports = router;


// ─── Public tax info router (mounted separately at /api/public) ───────────────
// Exposes only the labels and rates — no internal config details.
// Used by the booking UI to display tax line items to customers.

const publicRouter = express.Router();

function injectPublicSlug(req, _res, next) {
  req.query = req.query || {};
  req.query.tenantSlug = req.params.slug;
  next();
}

publicRouter.get('/:slug/tax-info', injectPublicSlug, requireTenant, async (req, res) => {
  try {
    const tenantId = Number(req.tenantId);
    if (!tenantId) return res.status(400).json({ error: 'Missing tenant context.' });

    const config = await loadTenantTaxConfig(tenantId);

    // Return only what the public booking UI needs — never expose registration numbers etc.
    return res.json({
      vat_rate:               config.vat_rate,
      vat_label:              config.vat_label,
      service_charge_rate:    config.service_charge_rate,
      service_charge_label:   config.service_charge_label,
      tax_inclusive:          config.tax_inclusive,
      show_tax_breakdown:     config.show_tax_breakdown,
      has_tax:                config.vat_rate > 0 || config.service_charge_rate > 0,
    });
  } catch (err) {
    logger.error({ err }, 'GET public tax-info error');
    // Fail gracefully: return zero-rate defaults so the UI keeps working
    return res.json({
      vat_rate:             DEFAULT_TAX_CONFIG.vat_rate,
      vat_label:            DEFAULT_TAX_CONFIG.vat_label,
      service_charge_rate:  DEFAULT_TAX_CONFIG.service_charge_rate,
      service_charge_label: DEFAULT_TAX_CONFIG.service_charge_label,
      tax_inclusive:        DEFAULT_TAX_CONFIG.tax_inclusive,
      show_tax_breakdown:   false,
      has_tax:              false,
    });
  }
});

module.exports.publicTaxRouter = publicRouter;
