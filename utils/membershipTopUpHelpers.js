// utils/membershipTopUpHelpers.js
//
// Top-up helpers for customer-membership routes.
// Extracted from routes/customerMemberships.js.
// Used by routes/customerMemberships/topup.js.

/**
 * Load the tenant's membership checkout policy from branding JSONB.
 * Returns a safe default if the tenant has no policy configured.
 */
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
      `SELECT COALESCE(branding, '{}'::jsonb) AS branding, currency_code
         FROM tenants WHERE id = $1 LIMIT 1`,
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

/**
 * Atomically apply a membership top-up:
 *   1. Lock the membership row (FOR UPDATE)
 *   2. Insert a ledger credit line
 *   3. Increment cached balances
 * Returns { ok: true, membership } or { ok: false, status, error }.
 */
async function applyMembershipTopUp({ client, tenantId, membershipId, minutesToAdd, usesToAdd, note, actorType }) {
  const mins = Number(minutesToAdd || 0);
  const uses = Number(usesToAdd   || 0);
  if (mins <= 0 && uses <= 0) throw new Error("Top-up requires minutesToAdd or usesToAdd.");

  await client.query("BEGIN");
  try {
    const mRes = await client.query(
      `SELECT id, customer_id, status, end_at, minutes_remaining, uses_remaining
         FROM customer_memberships
        WHERE tenant_id = $1 AND id = $2
        FOR UPDATE`,
      [Number(tenantId), Number(membershipId)]
    );
    if (!mRes.rows.length) {
      await client.query("ROLLBACK");
      return { ok: false, status: 404, error: "membership not found" };
    }

    const m = mRes.rows[0];
    if (String(m.status) === "archived") {
      await client.query("ROLLBACK");
      return { ok: false, status: 409, error: "membership is archived" };
    }
    if (m.end_at && new Date(m.end_at).getTime() <= Date.now()) {
      await client.query("ROLLBACK");
      return { ok: false, status: 409, error: "membership is expired (time)" };
    }

    await client.query(
      `INSERT INTO membership_ledger
         (tenant_id, customer_membership_id, booking_id, type, minutes_delta, uses_delta, note)
       VALUES ($1, $2, NULL, 'topup', $3, $4, $5)`,
      [Number(tenantId), Number(membershipId), mins > 0 ? mins : null, uses > 0 ? uses : null,
       note || `Top-up (${actorType || "system"})`]
    );

    const upd = await client.query(
      `UPDATE customer_memberships
          SET minutes_remaining = COALESCE(minutes_remaining, 0) + $1::int,
              uses_remaining    = COALESCE(uses_remaining,    0) + $2::int,
              status = CASE WHEN status = 'expired' THEN 'active' ELSE status END
        WHERE tenant_id = $3 AND id = $4
        RETURNING id, tenant_id, customer_id, status, minutes_remaining, uses_remaining`,
      [mins, uses, Number(tenantId), Number(membershipId)]
    );

    await client.query("COMMIT");
    return { ok: true, membership: upd.rows[0] };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  }
}

module.exports = { loadMembershipCheckoutPolicy, roundUpMinutes, applyMembershipTopUp };
