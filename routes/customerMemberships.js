// routes/customerMemberships.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const db = pool;

const requireAdmin = require("../middleware/requireAdmin");
const requireGoogleAuth = require("../middleware/requireGoogleAuth");
const { requireTenant } = require("../middleware/requireTenant");

function shouldUseCustomerView(req) {
  const q = req.query || {};
  return Boolean(q.customerId || q.customerEmail);
}

// GET /api/customer-memberships?tenantSlug|tenantId&customerId=
// ADMIN: customer memberships are private tenant data

// CUSTOMER: return memberships for the signed-in Google user
// (backward compatible with the public booking UI which calls this endpoint)
router.get(
  "/",
  (req, res, next) => {
    if (shouldUseCustomerView(req)) return next();
    return next("route");
  },
  requireGoogleAuth,
  requireTenant,
  async (req, res) => {
    try {
      const tenantId = req.tenantId;
      const googleEmail = String(req.googleUser?.email || "").toLowerCase();
      const customerEmail = String(req.query.customerEmail || "").toLowerCase();

      // If the caller provided customerEmail, ensure it matches the signed-in user
      if (customerEmail && googleEmail && customerEmail !== googleEmail) {
        return res.status(403).json({ error: "Forbidden" });
      }

      let customerId = Number(req.query.customerId);

      // Resolve customerId by email if needed
      if ((!Number.isFinite(customerId) || customerId <= 0) && googleEmail) {
        const c = await db.query(
          `SELECT id FROM customers WHERE tenant_id=$1 AND lower(email)=lower($2) LIMIT 1`,
          [tenantId, googleEmail]
        );
        customerId = c.rows?.[0]?.id ? Number(c.rows[0].id) : NaN;
      }

      // Validate the customer belongs to this tenant and matches the signed-in email
      if (Number.isFinite(customerId) && customerId > 0) {
        const c2 = await db.query(
          `SELECT id, email FROM customers WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
          [customerId, tenantId]
        );
        if (!c2.rows[0]) return res.json({ memberships: [] });
        const dbEmail = String(c2.rows[0].email || "").toLowerCase();
        if (googleEmail && dbEmail && dbEmail !== googleEmail) {
          return res.status(403).json({ error: "Forbidden" });
        }
      } else {
        return res.json({ memberships: [] });
      }

      // Same filters as admin endpoint
      const includeExpired = String(req.query.includeExpired || "").toLowerCase() === "true";
      const includeArchived = String(req.query.includeArchived || "").toLowerCase() === "true";

      const where = ["cm.tenant_id=$1", "cm.customer_id=$2"];
      const params = [tenantId, customerId];

      if (!includeExpired) where.push("(cm.end_at IS NULL OR cm.end_at > NOW())");
      if (!includeArchived) where.push("cm.status <> 'archived'");

      const q = `
        SELECT
          cm.id,
          cm.customer_id,
          cm.membership_plan_id,
          cm.status,
          cm.start_at,
          cm.end_at,
          cm.minutes_total,
          cm.minutes_used,
          cm.created_at,
          mp.name AS plan_name,
          mp.price AS plan_price,
          mp.valid_days AS plan_valid_days
        FROM customer_memberships cm
        LEFT JOIN membership_plans mp ON mp.id = cm.membership_plan_id
        WHERE ${where.join(" AND ")}
        ORDER BY cm.created_at DESC
        LIMIT 100
      `;

      const r = await db.query(q, params);
      return res.json({ memberships: r.rows || [] });
    } catch (e) {
      console.error("customer-memberships(customer) error", e);
      return res.status(500).json({ error: "Server error" });
    }
  }
);

router.get("/", requireAdmin, requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const customerId = Number(req.query.customerId);

    // Optional filters
    // includeExpired=true   -> include memberships with end_at <= now()
    // includeArchived=true  -> include status='archived'
    const includeExpired = String(req.query.includeExpired || "").toLowerCase() === "true";
    const includeArchived = String(req.query.includeArchived || "").toLowerCase() === "true";

    if (!Number.isFinite(customerId) || customerId <= 0) {
      return res.json({ memberships: [] });
    }

    // Customer must belong to tenant
    const c = await db.query(
      `SELECT id FROM customers WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
      [customerId, tenantId]
    );
    if (!c.rows.length) return res.json({ memberships: [] });

    const r = await db.query(
      `
      SELECT
        cm.id,
        cm.tenant_id,
        cm.customer_id,
        cm.plan_id,
        cm.status,
        cm.start_at,
        cm.end_at,
        cm.minutes_remaining,
        cm.uses_remaining,
        mp.name AS plan_name,
        mp.description AS plan_description,
        mp.price AS plan_price,
        mp.currency AS plan_currency,
        mp.included_minutes,
        mp.included_uses,
        mp.validity_days,
        CASE
          WHEN cm.status = 'archived' THEN 'archived'
          WHEN cm.end_at IS NOT NULL AND cm.end_at <= NOW() THEN 'expired'
          WHEN cm.start_at IS NOT NULL AND cm.start_at > NOW() THEN 'scheduled'
          WHEN cm.status = 'active' THEN 'active'
          ELSE cm.status
        END AS lifecycle_state,
        (
          cm.status = 'active'
          AND (cm.start_at IS NULL OR cm.start_at <= NOW())
          AND (cm.end_at IS NULL OR cm.end_at > NOW())
        ) AS is_currently_active
      FROM customer_memberships cm
      JOIN membership_plans mp
        ON mp.id = cm.plan_id
       AND mp.tenant_id = $1
      WHERE cm.tenant_id = $1
        AND cm.customer_id = $2
        AND ($3::boolean OR cm.end_at IS NULL OR cm.end_at > NOW())
        AND ($4::boolean OR cm.status <> 'archived')
      ORDER BY cm.start_at DESC NULLS LAST, cm.created_at DESC NULLS LAST
      `,
      [tenantId, customerId, includeExpired, includeArchived]
    );

    return res.json({ memberships: r.rows });
  } catch (err) {
    console.error("GET /api/customer-memberships error:", err);
    return res.status(500).json({ error: "Failed to load memberships." });
  }
});

// Manually archive a membership (keeps the record but hides it from default lists)
// PATCH /api/customer-memberships/:id/archive?tenantSlug=...
router.patch("/:id/archive", requireAdmin, requireTenant, async (req, res) => {
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

// POST /api/customer-memberships/subscribe?tenantSlug=...
// Body: { customerId, membershipPlanId }
router.post("/subscribe", requireAdmin, requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const customerId = Number(req.body?.customerId);
    const membershipPlanId = Number(req.body?.membershipPlanId);

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

    return res.json({ membership });
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
router.post("/consume-next", requireAdmin, requireTenant, async (req, res) => {
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
router.get("/:id/ledger", requireAdmin, requireTenant, async (req, res) => {
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



// -----------------------------------------------------------------------------
// Membership top-up (Smart Top-Up)
// Creates a positive ledger line and increments balances atomically.
// -----------------------------------------------------------------------------
// Stored policy: tenants.branding.membershipCheckout (or compatible paths)
async function loadMembershipCheckoutPolicy(dbClient, tenantId) {
  const defaults = {
    mode: "smart_top_up",
    topUp: {
      enabled: true,
      allowSelfServe: true,
      roundToMinutes: 30,
      minPurchaseMinutes: 30,
      pricePerMinute: 0,
      currency: null,
    },
  };

  try {
    const r = await dbClient.query(
      `
      SELECT COALESCE(branding, '{}'::jsonb) AS branding, currency_code
      FROM tenants
      WHERE id = $1
      LIMIT 1
      `,
      [Number(tenantId)]
    );
    if (!r.rows.length) return defaults;

    const branding = r.rows[0]?.branding || {};
    const currency = r.rows[0]?.currency_code || null;

    const maybe =
      branding?.membershipCheckout ||
      branding?.membership_checkout ||
      branding?.membership?.checkout ||
      branding?.membership?.checkoutPolicy ||
      null;

    const merged = { ...defaults, ...(maybe && typeof maybe === "object" ? maybe : {}) };
    merged.topUp = { ...defaults.topUp, ...(merged.topUp || {}) };
    if (!merged.topUp.currency) merged.topUp.currency = currency;

    return merged;
  } catch {
    return defaults;
  }
}

function roundUpMinutes(value, roundTo) {
  const v = Math.max(0, Number(value || 0));
  const r = Math.max(1, Number(roundTo || 1));
  return Math.ceil(v / r) * r;
}

async function applyMembershipTopUp({
  client,
  tenantId,
  membershipId,
  minutesToAdd,
  usesToAdd,
  note,
  actorType,
}) {
  const mins = Number(minutesToAdd || 0);
  const uses = Number(usesToAdd || 0);
  if (mins <= 0 && uses <= 0) {
    throw new Error("Top-up requires minutesToAdd or usesToAdd.");
  }

  await client.query("BEGIN");
  try {
    // Ensure membership belongs to tenant (lock row)
    const mRes = await client.query(
      `
      SELECT id, customer_id, status, end_at, minutes_remaining, uses_remaining
      FROM customer_memberships
      WHERE tenant_id = $1 AND id = $2
      FOR UPDATE
      `,
      [Number(tenantId), Number(membershipId)]
    );
    if (!mRes.rows.length) {
      await client.query("ROLLBACK");
      return { ok: false, status: 404, error: "membership not found" };
    }

    const m = mRes.rows[0];

    // Block archived memberships
    if (String(m.status) === "archived") {
      await client.query("ROLLBACK");
      return { ok: false, status: 409, error: "membership is archived" };
    }

    // Block time-expired memberships (end_at passed)
    if (m.end_at && new Date(m.end_at).getTime() <= Date.now()) {
      await client.query("ROLLBACK");
      return { ok: false, status: 409, error: "membership is expired (time)" };
    }

    // Insert ledger credit
    const type = "topup";
    const ledgerNote = note || `Top-up (${actorType || "system"})`;
    await client.query(
      `
      INSERT INTO membership_ledger
        (tenant_id, customer_membership_id, booking_id, type, minutes_delta, uses_delta, note)
      VALUES
        ($1, $2, NULL, $3, $4, $5, $6)
      `,
      [
        Number(tenantId),
        Number(membershipId),
        type,
        mins > 0 ? mins : null,
        uses > 0 ? uses : null,
        ledgerNote,
      ]
    );

    // Apply balances
    const upd = await client.query(
      `
      UPDATE customer_memberships
      SET
        minutes_remaining = COALESCE(minutes_remaining, 0) + $1::int,
        uses_remaining = COALESCE(uses_remaining, 0) + $2::int,
        status = CASE
          WHEN status = 'expired' THEN 'active'
          ELSE status
        END
      WHERE tenant_id = $3 AND id = $4
      RETURNING id, tenant_id, customer_id, status, minutes_remaining, uses_remaining
      `,
      [mins, uses, Number(tenantId), Number(membershipId)]
    );

    await client.query("COMMIT");
    return { ok: true, membership: upd.rows[0] };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  }
}

// CUSTOMER: POST /api/customer-memberships/:id/top-up?tenantSlug=...
// Body: { minutesToAdd?: number, usesToAdd?: number, note?: string }
//
// Requires Google auth + tenant, and policy must allow self-serve top-ups.
router.post("/:id/top-up", requireGoogleAuth, requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const membershipId = Number(req.params.id);

    const googleEmail = String(req.googleUser?.email || "").toLowerCase().trim();
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
router.post("/:id/top-up-admin", requireAdmin, requireTenant, async (req, res) => {
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
});
module.exports = router;
