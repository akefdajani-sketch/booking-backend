// routes/customerMemberships/topup.js
// GET /:id/ledger, POST /:id/top-up (customer), POST /:id/top-up-admin
// Mounted by routes/customerMemberships.js

const { pool } = require("../../db");
const db = pool;
const requireAdminOrTenantRole = require("../../middleware/requireAdminOrTenantRole");
const requireAppAuth = require("../../middleware/requireAppAuth");
const { requireTenant } = require("../../middleware/requireTenant");
const { getExistingColumns, firstExisting, pickCol, safeIntExpr } = require("../../utils/customerQueryHelpers");
const { loadMembershipCheckoutPolicy, roundUpMinutes, applyMembershipTopUp } = require("../../utils/membershipTopUpHelpers");


module.exports = function mount(router) {
router.get("/:id/ledger", requireTenant, requireAdminOrTenantRole("staff"), async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const membershipId = Number(req.params.id);

    if (!Number.isFinite(membershipId) || membershipId <= 0) {
      return res.status(400).json({ error: "Invalid membership id." });
    }

    // Membership must belong to tenant
    const m = await db.query(
      `SELECT id FROM customer_memberships WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
      [membershipId, tenantId]
    );
    if (!m.rows.length) return res.status(404).json({ error: "Membership not found for tenant." });

    const r = await db.query(
      `
      SELECT
        id,
        created_at,
        booking_id,
        type,
        minutes_delta,
        uses_delta,
        note
      FROM membership_ledger
      WHERE tenant_id = $1
        AND customer_membership_id = $2
      ORDER BY created_at DESC
      LIMIT 200
      `,
      [tenantId, membershipId]
    );

    return res.json({ ledger: r.rows });
  } catch (err) {
    console.error("GET /api/customer-memberships/:id/ledger error:", err);
    return res.status(500).json({ error: "Failed to load ledger." });
  }
});

router.post("/:id/top-up", requireAppAuth, requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const membershipId = Number(req.params.id);

    const googleEmail = String(req.auth?.email || req.googleUser?.email || "").toLowerCase().trim();
    if (!googleEmail) return res.status(401).json({ error: "Unauthorized" });

    const policy = await loadMembershipCheckoutPolicy(db, tenantId);
    if (!policy?.topUp?.enabled) {
      return res.status(409).json({ error: "top_up_disabled" });
    }
    if (!policy?.topUp?.allowSelfServe) {
      return res.status(403).json({ error: "top_up_not_allowed" });
    }

    // Parse + normalize minutes
    let minutesToAdd = Number(req.body?.minutesToAdd || 0);
    const usesToAdd = Number(req.body?.usesToAdd || 0);

    const roundTo = Number(policy?.topUp?.roundToMinutes || 1);
    const minBuy = Number(policy?.topUp?.minPurchaseMinutes || 0);
    if (minutesToAdd > 0) {
      minutesToAdd = roundUpMinutes(minutesToAdd, roundTo);
      if (minBuy > 0) minutesToAdd = Math.max(minutesToAdd, minBuy);
    }

    // Validate membership belongs to signed-in customer (by email)
    const c = await db.query(
      `SELECT id FROM customers WHERE tenant_id=$1 AND lower(email)=lower($2) LIMIT 1`,
      [tenantId, googleEmail]
    );
    const customerId = c.rows?.[0]?.id ? Number(c.rows[0].id) : null;
    if (!customerId) return res.status(403).json({ error: "customer_not_found" });

    const owns = await db.query(
      `SELECT id FROM customer_memberships WHERE tenant_id=$1 AND id=$2 AND customer_id=$3 LIMIT 1`,
      [tenantId, membershipId, customerId]
    );
    if (!owns.rows.length) return res.status(403).json({ error: "forbidden" });

    const result = await applyMembershipTopUp({
      client: db,
      tenantId,
      membershipId,
      minutesToAdd,
      usesToAdd,
      note: req.body?.note,
      actorType: "customer",
    });

    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.json({ membership: result.membership });
  } catch (err) {
    console.error("customer top-up error", err);
    return res.status(500).json({ error: "Failed to top up." });
  }
});

// ADMIN: POST /api/customer-memberships/:id/top-up-admin?tenantSlug=...
// Body: { minutesToAdd?: number, usesToAdd?: number, note?: string }

router.post("/:id/top-up-admin", requireTenant, requireAdminOrTenantRole("manager"), async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const membershipId = Number(req.params.id);

    const policy = await loadMembershipCheckoutPolicy(db, tenantId);
    if (!policy?.topUp?.enabled) {
      return res.status(409).json({ error: "top_up_disabled" });
    }

    let minutesToAdd = Number(req.body?.minutesToAdd || 0);
    const usesToAdd = Number(req.body?.usesToAdd || 0);

    const roundTo = Number(policy?.topUp?.roundToMinutes || 1);
    const minBuy = Number(policy?.topUp?.minPurchaseMinutes || 0);
    if (minutesToAdd > 0) {
      minutesToAdd = roundUpMinutes(minutesToAdd, roundTo);
      if (minBuy > 0) minutesToAdd = Math.max(minutesToAdd, minBuy);
    }

    const result = await applyMembershipTopUp({
      client: db,
      tenantId,
      membershipId,
      minutesToAdd,
      usesToAdd,
      note: req.body?.note,
      actorType: "admin",
    });

    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.json({ membership: result.membership });
  } catch (err) {
    console.error("admin top-up error", err);
    return res.status(500).json({ error: "Failed to top up." });
  }
})
};
