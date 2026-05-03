// routes/membershipPlans.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const db = pool;

const { requireTenant } = require("../middleware/requireTenant");
const requireAdminOrTenantRole = require("../middleware/requireAdminOrTenantRole");
// VOICE-PERF-1: Bust AI context on plan writes.
const aiContextCache = require("../utils/aiContextCache");


function toNullableText(value) {
  if (value === undefined) return undefined;
  const text = String(value || "").trim();
  return text ? text : null;
}

function toNullableNumber(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function coerceBoolean(value, fallback) {
  if (value === undefined) return fallback;
  return value === true || value === "true" || value === 1 || value === "1";
}

function normalizePlanPayload(body) {
  const source = body && typeof body === "object" && body.plan && typeof body.plan === "object" ? body.plan : body || {};
  return {
    name: String(source.name || "").trim(),
    description: toNullableText(source.description),
    billing_type: toNullableText(source.billing_type) || "manual",
    price: toNullableNumber(source.price) ?? 0,
    currency: toNullableText(source.currency) || null,
    included_minutes: toNullableNumber(source.included_minutes) ?? null,
    included_uses: toNullableNumber(source.included_uses) ?? null,
    validity_days: toNullableNumber(source.validity_days) ?? null,
    is_active: coerceBoolean(source.is_active, true),
  };
}

async function selectPlans(tenantId, planId) {
  const params = [tenantId];
  let where = `tenant_id = $1`;
  if (planId) {
    params.push(planId);
    where += ` AND id = $2`;
  }
  const result = await db.query(
    `
    SELECT
      id,
      tenant_id,
      name,
      description,
      billing_type,
      price,
      currency,
      included_minutes,
      included_uses,
      validity_days,
      is_active,
      created_at,
      updated_at
    FROM membership_plans
    WHERE ${where}
    ORDER BY created_at DESC, id DESC
    `,
    params
  );
  return result.rows;
}

// GET /api/membership-plans?tenantSlug|tenantId=
router.get("/", requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const plans = await selectPlans(tenantId);
    return res.json({ plans });
  } catch (err) {
    console.error("GET /api/membership-plans error:", err);
    return res.status(500).json({ error: "Failed to load membership plans." });
  }
});

// POST /api/membership-plans?tenantSlug=...
router.post("/", requireTenant, requireAdminOrTenantRole("staff"), async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const plan = normalizePlanPayload(req.body || {});
    if (!plan.name) {
      return res.status(400).json({ error: "Plan name is required." });
    }

    const inserted = await db.query(
      `
      INSERT INTO membership_plans (
        tenant_id,
        name,
        description,
        billing_type,
        price,
        currency,
        included_minutes,
        included_uses,
        validity_days,
        is_active
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING
        id,
        tenant_id,
        name,
        description,
        billing_type,
        price,
        currency,
        included_minutes,
        included_uses,
        validity_days,
        is_active,
        created_at,
        updated_at
      `,
      [
        tenantId,
        plan.name,
        plan.description,
        plan.billing_type,
        plan.price,
        plan.currency,
        plan.included_minutes,
        plan.included_uses,
        plan.validity_days,
        plan.is_active,
      ]
    );

    aiContextCache.bustBusiness(tenantId);
    return res.status(201).json({ plan: inserted.rows[0] || null });
  } catch (err) {
    console.error("POST /api/membership-plans error:", err);
    return res.status(500).json({ error: "Failed to create membership plan." });
  }
});

// PATCH /api/membership-plans/:id?tenantSlug=...
router.patch("/:id", requireTenant, requireAdminOrTenantRole("staff"), async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid membership plan id." });
    }

    const currentRows = await selectPlans(tenantId, id);
    if (!currentRows.length) {
      return res.status(404).json({ error: "Membership plan not found." });
    }

    const current = currentRows[0];
    const incoming = normalizePlanPayload(req.body || {});
    const next = {
      name: incoming.name || current.name,
      description: incoming.description !== undefined ? incoming.description : current.description,
      billing_type: incoming.billing_type || current.billing_type || "manual",
      price: incoming.price !== undefined ? incoming.price : current.price,
      currency: incoming.currency !== undefined ? incoming.currency : current.currency,
      included_minutes: incoming.included_minutes !== undefined ? incoming.included_minutes : current.included_minutes,
      included_uses: incoming.included_uses !== undefined ? incoming.included_uses : current.included_uses,
      validity_days: incoming.validity_days !== undefined ? incoming.validity_days : current.validity_days,
      is_active: req.body && Object.prototype.hasOwnProperty.call(req.body, "is_active")
        ? incoming.is_active
        : current.is_active,
    };

    if (!next.name) {
      return res.status(400).json({ error: "Plan name is required." });
    }

    const updated = await db.query(
      `
      UPDATE membership_plans
      SET
        name = $3,
        description = $4,
        billing_type = $5,
        price = $6,
        currency = $7,
        included_minutes = $8,
        included_uses = $9,
        validity_days = $10,
        is_active = $11,
        updated_at = NOW()
      WHERE tenant_id = $1 AND id = $2
      RETURNING
        id,
        tenant_id,
        name,
        description,
        billing_type,
        price,
        currency,
        included_minutes,
        included_uses,
        validity_days,
        is_active,
        created_at,
        updated_at
      `,
      [
        tenantId,
        id,
        next.name,
        next.description,
        next.billing_type,
        next.price,
        next.currency,
        next.included_minutes,
        next.included_uses,
        next.validity_days,
        next.is_active,
      ]
    );

    aiContextCache.bustBusiness(tenantId);
    return res.json({ plan: updated.rows[0] || null });
  } catch (err) {
    console.error("PATCH /api/membership-plans/:id error:", err);
    return res.status(500).json({ error: "Failed to update membership plan." });
  }
});

module.exports = router;
