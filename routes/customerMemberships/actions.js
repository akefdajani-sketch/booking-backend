// routes/customerMemberships/actions.js
// PATCH archive, PATCH status, POST subscribe, POST consume-next
// Mounted by routes/customerMemberships.js

const { pool } = require("../../db");
const db = pool;
const requireAdminOrTenantRole = require("../../middleware/requireAdminOrTenantRole");
const requireAppAuth = require("../../middleware/requireAppAuth");
const { requireTenant } = require("../../middleware/requireTenant");
const { requireFeature } = require("../../utils/entitlements"); // D4.6: plan-gated features
const { getExistingColumns, firstExisting, pickCol, safeIntExpr } = require("../../utils/customerQueryHelpers");


module.exports = function mount(router) {
router.patch("/:id/archive", requireTenant, requireAdminOrTenantRole("staff"), async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "invalid membership id" });
    }

    const result = await db.query(
      `
      UPDATE customer_memberships
      SET status = 'archived'
      WHERE tenant_id = $1 AND id = $2
      RETURNING id, tenant_id, customer_id, status, start_at, end_at, minutes_remaining, uses_remaining, plan_id
      `,
      [tenantId, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "membership not found" });
    }

    return res.json({ membership: result.rows[0] });
  } catch (err) {
    console.error("archive membership error", err);
    return res.status(500).json({ error: "internal error" });
  }
});


// PATCH /api/customer-memberships/:id/status?tenantSlug=...
// Body: { status: 'active' | 'archived' }

router.patch("/:id/status", requireTenant, requireAdminOrTenantRole("staff"), async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const id = Number(req.params.id);
    const nextStatus = String(req.body?.status || "").trim().toLowerCase();
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "invalid membership id" });
    }
    if (!["active", "archived"].includes(nextStatus)) {
      return res.status(400).json({ error: "invalid status" });
    }

    const result = await db.query(
      `
      UPDATE customer_memberships
      SET status = $3,
          updated_at = NOW()
      WHERE tenant_id = $1 AND id = $2
      RETURNING id, tenant_id, customer_id, status, start_at, end_at, minutes_remaining, uses_remaining, plan_id, updated_at
      `,
      [tenantId, id, nextStatus]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "membership not found" });
    }

    return res.json({ membership: result.rows[0] });
  } catch (err) {
    console.error("membership status update error", err);
    return res.status(500).json({ error: "internal error" });
  }
});

// POST /api/customer-memberships/subscribe?tenantSlug=...
// Body: { customerId, membershipPlanId } or { customerId, planId }
// D4.6: gated by 'memberships' feature — Starter-tier tenants get 403.

router.post("/subscribe", requireTenant, requireFeature("memberships"), requireAdminOrTenantRole("staff"), async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const customerId = Number(req.body?.customerId);
    const membershipPlanId = Number(req.body?.membershipPlanId || req.body?.planId);

    if (!Number.isFinite(customerId) || customerId <= 0) {
      return res.status(400).json({ error: "Invalid customerId." });
    }
    if (!Number.isFinite(membershipPlanId) || membershipPlanId <= 0) {
      return res.status(400).json({ error: "Invalid membershipPlanId." });
    }

    // Customer must belong to tenant
    const c = await db.query(
      `SELECT id FROM customers WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
      [customerId, tenantId]
    );
    if (!c.rows.length) {
      return res.status(400).json({ error: "Unknown customer for tenant." });
    }

    // Plan must belong to tenant and be active
    const p = await db.query(
      `
      SELECT id, name, included_minutes, included_uses, validity_days, is_active
      FROM membership_plans
      WHERE id=$1 AND tenant_id=$2
      LIMIT 1
      `,
      [membershipPlanId, tenantId]
    );
    if (!p.rows.length) return res.status(404).json({ error: "Plan not found for tenant." });

    const plan = p.rows[0];
    if (!plan.is_active) return res.status(400).json({ error: "Plan is not active." });
    
    // ✅ Idempotency / duplicate-active guard (no schema changes)
    const idemKey = req.get("Idempotency-Key") || null;
    
    const existing = await db.query(
      `
      SELECT *
      FROM customer_memberships
      WHERE tenant_id = $1
        AND customer_id = $2
        AND plan_id = $3
        AND status = 'active'
        AND end_at > NOW()
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [tenantId, customerId, membershipPlanId]
    );
    
    if (existing.rows.length) {
      return res.json({
        membership: existing.rows[0],
        alreadyActive: true,
        idempotencyKey: idemKey,
        customerId,
        membershipPlanId,
      });
    }
    
    const minutesRemaining = Number(plan.included_minutes || 0);
    const usesRemaining = Number(plan.included_uses || 0);
    const validityDays = Number(plan.validity_days || 30);
    
    const startAt = new Date();
    const endAt = new Date(startAt);
    endAt.setDate(endAt.getDate() + validityDays);
    
    // Insert membership (NOTE: plan_id + minutes_remaining + uses_remaining)
    const ins = await db.query(
      `
      INSERT INTO customer_memberships
        (tenant_id, customer_id, plan_id, status, start_at, end_at, minutes_remaining, uses_remaining)
      VALUES
        ($1, $2, $3, 'active', $4, $5, $6, $7)
      RETURNING *
      `,
      [
        tenantId,
        customerId,
        membershipPlanId,
        startAt.toISOString(),
        endAt.toISOString(),
        minutesRemaining,
        usesRemaining,
      ]
    );

    const membership = ins.rows[0];

    // Ledger entry (matches your table: customer_membership_id, minutes_delta, uses_delta)
    await db.query(
      `
      INSERT INTO membership_ledger
        (tenant_id, customer_membership_id, booking_id, type, minutes_delta, uses_delta, note)
      VALUES
        ($1, $2, NULL, 'grant', $3, $4, $5)
      `,
      [tenantId, membership.id, minutesRemaining, usesRemaining, `Initial grant for ${plan.name}`]
    );

    return res.json({ membership, customerId, membershipPlanId, planName: plan.name });
  } catch (err) {
    console.error("POST /api/customer-memberships/subscribe error:", err);
    return res.status(500).json({ error: "Failed to subscribe." });
  }
});

// POST /api/customer-memberships/consume-next?tenantSlug=...
// Body: { customerId, bookingId, minutesToDebit, usesToDebit, note? }
//
// Deterministically chooses ONE eligible active membership and debits it, with:
// - row locks (FOR UPDATE) to prevent race conditions
// - idempotency via uq_membership_ledger_booking_debit
// - DB check constraints for non-negative balances (cm_non_negative_balances)

router.post("/consume-next", requireTenant, requireAdminOrTenantRole("staff"), async (req, res) => {
  const tenantId = req.tenantId;
  const customerId = Number(req.body?.customerId);
  const bookingId = req.body?.bookingId ? Number(req.body.bookingId) : null;
  const minutesToDebit = Number(req.body?.minutesToDebit || 0);
  const usesToDebit = Number(req.body?.usesToDebit || 0);
  const note = (req.body?.note || "").toString().trim() || null;

  if (!Number.isFinite(customerId) || customerId <= 0) {
    return res.status(400).json({ error: "Invalid customerId." });
  }
  if (!Number.isFinite(bookingId) || bookingId <= 0) {
  return res.status(400).json({ error: "bookingId is required (must be a real booking id)." });
  }  
  if ((!Number.isFinite(minutesToDebit) || minutesToDebit < 0) || (!Number.isFinite(usesToDebit) || usesToDebit < 0)) {
    return res.status(400).json({ error: "Invalid debit values." });
  }
  if (minutesToDebit === 0 && usesToDebit === 0) {
    return res.status(400).json({ error: "minutesToDebit or usesToDebit is required." });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Pick ONE eligible membership. Ordering is deterministic:
    // 1) earliest end_at (NULLs last)
    // 2) oldest created_at
    // 3) id tie-breaker
    const pick = await client.query(
      `
      SELECT
        id,
        minutes_remaining,
        uses_remaining
      FROM customer_memberships
      WHERE tenant_id = $1
        AND customer_id = $2
        AND status = 'active'
        AND (start_at IS NULL OR start_at <= NOW())
        AND (end_at IS NULL OR end_at > NOW())
        AND (
          ($3::int > 0 AND COALESCE(minutes_remaining, 0) >= $3::int)
          OR
          ($4::int > 0 AND COALESCE(uses_remaining, 0) >= $4::int)
        )
      ORDER BY (end_at IS NULL) ASC, end_at ASC NULLS LAST, created_at ASC, id ASC
      FOR UPDATE
      LIMIT 1
      `,
      [tenantId, customerId, minutesToDebit, usesToDebit]
    );

    if (!pick.rows.length) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "No eligible membership entitlement found." });
    }

    const cmId = pick.rows[0].id;

    // Insert ledger debit (idempotency per booking)
    // NOTE: Your ledger 'type' values are 'grant' and 'debit'.
    if (bookingId != null) {
      await client.query(
        `
        INSERT INTO membership_ledger
          (tenant_id, customer_membership_id, booking_id, type, minutes_delta, uses_delta, note)
        VALUES
          ($1, $2, $3, 'debit', $4, $5, $6)
        `,
        [tenantId, cmId, bookingId, -minutesToDebit, -usesToDebit, note]
      );
    } else {
      // Allow manual debit without bookingId (no idempotency guard needed)
      await client.query(
        `
        INSERT INTO membership_ledger
          (tenant_id, customer_membership_id, booking_id, type, minutes_delta, uses_delta, note)
        VALUES
          ($1, $2, NULL, 'debit', $3, $4, $5)
        `,
        [tenantId, cmId, -minutesToDebit, -usesToDebit, note]
      );
    }

    // Recompute cached balances from ledger (ledger is the source of truth)
    const upd = await client.query(
      `
      UPDATE customer_memberships cm
      SET
        minutes_remaining = GREATEST(
          0,
          COALESCE(
            (
              SELECT SUM(ml.minutes_delta)
              FROM membership_ledger ml
              WHERE ml.customer_membership_id = cm.id
            ),
            0
          )
        ),
        uses_remaining = GREATEST(
          0,
          COALESCE(
            (
              SELECT SUM(ml.uses_delta)
              FROM membership_ledger ml
              WHERE ml.customer_membership_id = cm.id
            ),
            0
          )
        )
      WHERE cm.id = $1 AND cm.tenant_id = $2
      RETURNING *
      `,
      [membershipId, tenantId]
    );

    return res.json({ membership: upd.rows[0] });
  } catch (err) {
    // Idempotency: if this booking was already debited, return the current membership state.
    if (err && err.code === "23505" && bookingId != null) {
      await client.query("ROLLBACK");
      try {
        const existing = await db.query(
          `
          SELECT customer_membership_id
          FROM membership_ledger
          WHERE tenant_id = $1 AND booking_id = $2 AND type = 'debit'
          ORDER BY created_at DESC
          LIMIT 1
          `,
          [tenantId, bookingId]
        );
        const cmId = existing.rows?.[0]?.customer_membership_id;
        if (cmId) {
          const cm = await db.query(
            `SELECT * FROM customer_memberships WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
            [tenantId, cmId]
          );
          return res.json({ membership: cm.rows[0], alreadyDebited: true, alreadyDebitted: true, bookingId, customerMembershipId: cmId });
}
      } catch (_) {
        // fall through
      }
      return res.status(409).json({ error: "Booking already debited." });
    }

    await client.query("ROLLBACK");
    console.error("POST /api/customer-memberships/consume-next error:", err);
    return res.status(500).json({ error: "Failed to consume membership entitlement." });
  } finally {
    client.release();
  }
});

// GET /api/customer-memberships/:id/ledger?tenantSlug=...
};
