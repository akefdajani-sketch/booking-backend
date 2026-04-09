// meMemberships.js
// Customer self-service membership routes: GET/POST /me/memberships, GET /me/memberships/:id/ledger
// Mounted by routes/customers.js

const express = require("express");
const { pool } = require("../../db");
const db = pool;
const requireAdminOrTenantRole = require("../../middleware/requireAdminOrTenantRole");
const requireAppAuth = require("../../middleware/requireAppAuth");
const { requireTenant } = require("../../middleware/requireTenant");
const { getExistingColumns, firstExisting, pickCol, softDeleteClause, safeIntExpr, getErrorCode } = require("../../utils/customerQueryHelpers");


module.exports = function mount(router) {
router.get("/me/memberships", requireAppAuth, requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.tenant?.id;
    const email = (req.googleUser?.email || "").toLowerCase();
    if (!tenantId) return res.status(400).json({ error: "Missing tenant" });
    if (!email) return res.status(401).json({ error: "Unauthorized" });

    const cust = await pool.query(
      `SELECT id FROM customers WHERE tenant_id=$1 AND LOWER(email)=LOWER($2) LIMIT 1`,
      [tenantId, email]
    );

    if (cust.rows.length === 0) {
      return res.json({ memberships: [] });
    }

    const customerId = cust.rows[0].id;

    // Column names in customer_memberships / membership_plans have changed over
    // time. Build a query that only references columns that exist.
    //
    // IMPORTANT (money-trust): The current platform uses an append-only ledger
    // with customer_memberships.minutes_remaining / uses_remaining as the
    // authoritative cached balances. Older iterations used included/used
    // minutes. This endpoint must support BOTH shapes so the public booking UI
    // can reliably determine if the customer has spendable credits.
    const cmPlanId = await pickCol("customer_memberships", "cm", [
      "plan_id",
      "membership_plan_id",
    ]);

    const cmStatusRaw = await pickCol("customer_memberships", "cm", ["status"], "NULL");
    const cmStarted = await pickCol(
      "customer_memberships",
      "cm",
      ["started_at", "start_at", "created_at"],
      "NULL"
    );
    const cmEndAt = await pickCol(
      "customer_memberships",
      "cm",
      ["end_at", "expires_at", "valid_until"],
      "NULL"
    );

    // Ledger-era balances (preferred when columns exist)
    const cmMinutesRemaining = await pickCol(
      "customer_memberships",
      "cm",
      ["minutes_remaining"],
      "NULL"
    );
    const cmUsesRemaining = await pickCol(
      "customer_memberships",
      "cm",
      ["uses_remaining"],
      "NULL"
    );

    // Legacy minutes fields (fallback)
    const cmUsedLegacy = await pickCol(
      "customer_memberships",
      "cm",
      ["used_minutes", "minutes_used"],
      "NULL"
    );
    const cmIncludedLegacy = await pickCol(
      "customer_memberships",
      "cm",
      ["included_minutes", "minutes_total", "minutes_included"],
      "NULL"
    );

    const mpName = await pickCol("membership_plans", "mp", ["name", "title"], "NULL");
    const mpDesc = await pickCol(
      "membership_plans",
      "mp",
      ["description", "subtitle"],
      "NULL"
    );
    const mpIncluded = await pickCol(
      "membership_plans",
      "mp",
      ["included_minutes", "minutes_total", "minutes_included"],
      "NULL"
    );

    const mpIncludedUses = await pickCol(
      "membership_plans",
      "mp",
      ["included_uses", "uses_total", "uses_included"],
      "NULL"
    );

    // Prefer ledger-era minutes_remaining when available; otherwise compute from included-used.
    const legacyIncludedExpr = `COALESCE(${mpIncluded}, ${cmIncludedLegacy})`;
    const legacyUsedExpr = `COALESCE(${cmUsedLegacy}, 0)`;
    const legacyRemainingExpr = `CASE WHEN ${legacyIncludedExpr} IS NOT NULL THEN GREATEST(${legacyIncludedExpr} - ${legacyUsedExpr}, 0) ELSE NULL END`;

    const minutesRemainingExpr = `COALESCE(${cmMinutesRemaining}, ${legacyRemainingExpr})`;
    const usesRemainingExpr = `COALESCE(${cmUsesRemaining}, 0)`;

    // Normalize status so the UI doesn't show "active" when end_at has passed.
    // If status column doesn't exist, we treat it as 'active' until end_at.
    const statusExpr = `CASE
      -- Time expiry
      WHEN ${cmEndAt} IS NOT NULL AND ${cmEndAt} <= NOW() THEN 'expired'

      -- Credit expiry (Option A: sessions/classes are uses)
      WHEN (COALESCE(${mpIncluded}, 0) > 0 AND (${minutesRemainingExpr}) <= 0) THEN 'expired'
      WHEN (COALESCE(${mpIncludedUses}, 0) > 0 AND (${usesRemainingExpr}) <= 0) THEN 'expired'

      -- Fallback: if plan credit shape is unknown, treat "both depleted" as expired
      WHEN (${mpIncluded} IS NULL AND ${mpIncludedUses} IS NULL)
        AND (COALESCE(${minutesRemainingExpr}, 0) <= 0 AND COALESCE(${usesRemainingExpr}, 0) <= 0) THEN 'expired'

      WHEN ${cmStatusRaw} IS NULL THEN 'active'
      WHEN LOWER(${cmStatusRaw}::text) IN ('active','cancelled','expired') THEN LOWER(${cmStatusRaw}::text)
      ELSE LOWER(${cmStatusRaw}::text)
    END`;

    const orderCol = await pickCol(
      "customer_memberships",
      "cm",
      ["created_at", "started_at", "start_at"],
      "cm.id"
    );

    const q = await pool.query(
      `
      SELECT
        cm.id,
        cm.tenant_id,
        cm.customer_id,
        ${cmPlanId} AS plan_id,
        ${statusExpr} AS status,
        ${cmStarted} AS started_at,
        ${cmEndAt} AS end_at,
        ${minutesRemainingExpr}::int AS minutes_remaining,
        ${usesRemainingExpr}::int AS uses_remaining,
        ${minutesRemainingExpr}::int AS remaining_minutes,
        ${mpName} AS plan_name,
        ${mpDesc} AS plan_description
      FROM customer_memberships cm
      LEFT JOIN membership_plans mp ON mp.id = ${cmPlanId}
      WHERE cm.tenant_id = $1
        AND cm.customer_id = $2
      ORDER BY ${orderCol} DESC NULLS LAST, cm.id DESC
      LIMIT 200
      `,
      [tenantId, customerId]
    );

    return res.json({ memberships: q.rows });
  } catch (e) {
    console.error("GET /customers/me/memberships error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// -----------------------------------------------------------------------------
// GET /customers/me/memberships/:id/ledger
// Customer self-service ledger/usage history for a specific membership.
// Returns { ledger: [...] }
// -----------------------------------------------------------------------------
router.get(
  "/me/memberships/:id/ledger",
  requireAppAuth,
  requireTenant,
  async (req, res) => {
    try {
      const tenantId = req.tenantId;
      const email = req.user?.email;
      const membershipId = Number(req.params.id);

      if (!tenantId) return res.status(400).json({ error: "Missing tenant" });
      if (!email) return res.status(401).json({ error: "Missing user" });
      if (!Number.isFinite(membershipId)) {
        return res.status(400).json({ error: "Invalid membership id" });
      }

      // Resolve the customer record for this tenant + Google user
      const customerRes = await db.query(
        `SELECT id FROM customers WHERE tenant_id=$1 AND email=$2 LIMIT 1`,
        [tenantId, email]
      );
      const customerId = customerRes.rows?.[0]?.id;
      if (!customerId) {
        // User has no customer record for this tenant yet
        return res.json({ ledger: [] });
      }

      // Ensure the membership belongs to this customer + tenant
      const cmRes = await db.query(
        `SELECT id FROM customer_memberships
         WHERE id=$1 AND tenant_id=$2 AND customer_id=$3
         LIMIT 1`,
        [membershipId, tenantId, customerId]
      );
      if (!cmRes.rows?.[0]?.id) {
        return res.json({ ledger: [] });
      }

      // Ledger rows (keep shape consistent with memberships.js)
      const ledgerRes = await db.query(
        `SELECT id, customer_membership_id, type, minutes_delta, uses_delta, note, created_at
         FROM membership_ledger
         WHERE customer_membership_id=$1
         ORDER BY created_at DESC
         LIMIT 200`,
        [membershipId]
      );

      return res.json({ ledger: ledgerRes.rows || [] });
    } catch (err) {
      console.error("GET /customers/me/memberships/:id/ledger error:", err);
      return res.status(500).json({ error: "Server error" });
    }
  }
);

// Subscribe/purchase a membership plan as the signed-in customer
router.post("/me/memberships/subscribe", requireAppAuth, requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenant?.id;
    const email = (req.googleUser?.email || "").toLowerCase();
    const { planId, payment_method } = req.body || {};
    const planIdNum = Number(planId);
    const paymentMethod = typeof payment_method === "string" && payment_method ? payment_method : null;

    if (!tenantId) return res.status(400).json({ error: "Missing tenant" });
    if (!email) return res.status(401).json({ error: "Unauthorized" });
    if (!Number.isFinite(planIdNum)) return res.status(400).json({ error: "Invalid planId" });

    const cust = await pool.query(
      `SELECT id FROM customers WHERE tenant_id=$1 AND LOWER(email)=LOWER($2) LIMIT 1`,
      [tenantId, email]
    );
    if (cust.rows.length === 0) return res.status(404).json({ error: "Customer not found" });
    const customerId = cust.rows[0].id;

    // membership_plans has had a few schema iterations (type vs billing_type).
    const mpCols = await getExistingColumns("membership_plans");
    const planTypeCol = firstExisting(mpCols, ["type", "billing_type"]);
    const planNameCol = firstExisting(mpCols, ["name", "title"]);

    const plan = await pool.query(
      `
      SELECT
        id,
        ${planNameCol ? planNameCol : "NULL"} AS name,
        ${planTypeCol ? planTypeCol : "NULL"} AS plan_type,
        included_minutes,
        included_uses,
        validity_days
      FROM membership_plans
      WHERE id=$1 AND tenant_id=$2
      LIMIT 1
      `,
      [planIdNum, tenantId]
    );
    if (plan.rows.length === 0) return res.status(404).json({ error: "Plan not found" });

    const p = plan.rows[0];
    const includedMinutes = Number(p.included_minutes || 0);
    const includedUses = p.included_uses == null ? null : Number(p.included_uses);
    const validityDays = Number(p.validity_days || 0);

    const now = new Date();
    const endAt = validityDays > 0
      ? new Date(now.getTime() + (validityDays * 24 * 60 * 60 * 1000))
      : null;

    await pool.query("BEGIN");

    try {
      // -------------------------------------------------------------------
      // Option A (agreed): sessions/classes/visits are "uses". Birdie is minutes.
      //
      // A membership is effectively expired if:
      // - time-based: end_at <= NOW()
      // - credit-based: minutes_remaining <= 0 OR uses_remaining <= 0 (depending on plan)
      // - hybrid: either of the above
      //
      // We allow repurchase once it's effectively expired.
      // -------------------------------------------------------------------

      // 1) Auto-expire any "active" rows that are effectively expired (time OR credits).
      //    This prevents a stale active row from blocking renewals.
      await pool.query(
        `
        UPDATE customer_memberships
        SET status = 'expired'
        WHERE tenant_id = $1
          AND customer_id = $2
          AND plan_id = $3
          AND status = 'active'
          AND (
            (end_at IS NOT NULL AND end_at <= NOW())
            OR (COALESCE(minutes_remaining, 0) <= 0 AND COALESCE(uses_remaining, 0) <= 0)
          )
        `,
        [tenantId, customerId, planIdNum]
      );

      // 2) If there is still an active membership for this plan, return it (idempotent).
      const existing = await pool.query(
        `
        SELECT id, tenant_id, customer_id, plan_id, status, start_at, end_at, minutes_remaining, uses_remaining
        FROM customer_memberships
        WHERE tenant_id=$1 AND customer_id=$2 AND plan_id=$3 AND status='active'
        ORDER BY id DESC
        LIMIT 1
        `,
        [tenantId, customerId, planIdNum]
      );

      if (existing.rows.length > 0) {
        await pool.query("COMMIT");
        return res.json({ ok: true, alreadyActive: true, membership: existing.rows[0] });
      }

      // 3) Create a fresh membership row.
      // Ensure payment_method column exists (safe, idempotent – same pattern as ensurePaymentMethodColumn.js)
      await pool.query(`
        ALTER TABLE customer_memberships
          ADD COLUMN IF NOT EXISTS payment_method TEXT
            CHECK (payment_method IS NULL OR payment_method IN ('card','cliq','cash','free'))
      `).catch(() => { /* column already exists or DB doesn't support CHECK on ADD — non-fatal */ });

      let membership;
      try {
        const ins = await pool.query(
          `
          INSERT INTO customer_memberships
            (tenant_id, customer_id, plan_id, status, start_at, end_at, minutes_remaining, uses_remaining, payment_method)
          VALUES
            ($1, $2, $3, 'active', $4, $5, $6, $7, $8)
          RETURNING id, tenant_id, customer_id, plan_id, status, start_at, end_at, minutes_remaining, uses_remaining, payment_method
          `,
          [
            tenantId,
            customerId,
            planIdNum,
            now.toISOString(),
            endAt ? endAt.toISOString() : null,
            // Balances are derived from the membership_ledger; initialize to 0.
            0,
            0,
            paymentMethod,
          ]
        );
        membership = ins.rows[0];
      } catch (eIns) {
        // payment_method column may not exist yet if the ALTER above was blocked.
        // Fall back to insert without it.
        if (eIns && String(eIns.message || "").includes("payment_method")) {
          const ins2 = await pool.query(
            `
            INSERT INTO customer_memberships
              (tenant_id, customer_id, plan_id, status, start_at, end_at, minutes_remaining, uses_remaining)
            VALUES
              ($1, $2, $3, 'active', $4, $5, $6, $7)
            RETURNING id, tenant_id, customer_id, plan_id, status, start_at, end_at, minutes_remaining, uses_remaining
            `,
            [
              tenantId,
              customerId,
              planIdNum,
              now.toISOString(),
              endAt ? endAt.toISOString() : null,
              0,
              0,
            ]
          );
          membership = ins2.rows[0];
        } else if (eIns && eIns.code === "23505" && String(eIns.constraint || "") === "uq_cm_one_active_per_plan") {
          // Race condition — unique constraint fired; return the active membership cleanly.
          const raced = await pool.query(
            `
            SELECT id, tenant_id, customer_id, plan_id, status, start_at, end_at, minutes_remaining, uses_remaining
            FROM customer_memberships
            WHERE tenant_id=$1 AND customer_id=$2 AND plan_id=$3 AND status='active'
            ORDER BY id DESC
            LIMIT 1
            `,
            [tenantId, customerId, planIdNum]
          );
          if (raced.rows.length > 0) {
            await pool.query("COMMIT");
            return res.json({ ok: true, alreadyActive: true, membership: raced.rows[0] });
          }
          throw eIns;
        } else {
          throw eIns;
        }
      }

      // 4) Create the initial GRANT row in the ledger (money-truth).
      await pool.query(
        `
        INSERT INTO membership_ledger
          (tenant_id, customer_membership_id, booking_id, type, minutes_delta, uses_delta, note)
        VALUES
          ($1, $2, NULL, 'grant', $3, $4, $5)
        `,
        [
          tenantId,
          membership.id,
          includedMinutes || null,
          (includedUses == null ? 0 : includedUses),
          `Initial grant for plan ${planIdNum}${p.name ? ` (${p.name})` : ""}`,
        ]
      );

      await pool.query("COMMIT");
      return res.json({ ok: true, alreadyActive: false, membership });
    } catch (e2) {
      await pool.query("ROLLBACK");
      console.error("POST /customers/me/memberships/subscribe DB error:", e2);
      return res.status(500).json({ error: "Server error" });
    }
  } catch (e) {
    console.error("POST /customers/me/memberships/subscribe error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});
};
