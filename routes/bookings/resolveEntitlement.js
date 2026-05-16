'use strict';

// routes/bookings/resolveEntitlement.js
//
// Post-BEGIN membership consumption + prepaid resolution for the booking
// creation engine. Extracted from routes/bookings/create.js (PR 5, Phase 1
// refactor).
//
// Responsibility: given an open transaction client and the request's
// entitlement intent (auto-consume / require / explicit-ID for both
// membership and prepaid), validate eligibility, lock the chosen rows
// (FOR UPDATE), and emit either the consumption metadata or a structured
// 4xx/5xx failure with ROLLBACK already executed.
//
// Exposed as TWO functions, not one bundled call:
//
//   resolveMembership(client, ctx)
//     → handles ROLLBACKs #1-#10 in the Step-1 inventory: service-eligibility
//       guard, auto-consume preflight + FOR UPDATE select, explicit-ID FOR
//       UPDATE select + ownership/status/balance checks. On success returns
//       { ok: true, finalCustomerMembershipId, debitMinutes, debitUses,
//         membershipBefore, membershipPolicy }.
//
//   resolvePrepaid(client, ctx)
//     → handles ROLLBACKs #11-#14: customer-presence guard, schema probe,
//       resolvePrepaidSelection helper, quantity check. On success returns
//       { ok: true, prepaidApplied }.
//
// Transaction posture: BOTH functions run INSIDE the BEGIN…COMMIT
// transaction. They take the transaction `client` and own their own
// ROLLBACK on failure — the orchestrator pattern is the same `if (!result.ok)
// return res.status(...).json(...)` used by PRs 2/3/4, but NO orchestrator-
// side ROLLBACK call is needed for the entitlement section. (The catch-all
// ROLLBACK at the bottom of the transaction try/catch still covers
// unexpected exceptions from post-entitlement code.)
//
// resolveMembership has TWO failure semantics depending on entry path:
//   - Auto-consume path (no explicit customerMembershipId): a soft-fail at
//     ROLLBACK #4 or #5 returns { ok: true, finalCustomerMembershipId: null,
//     debitMinutes: 0, debitUses: 0, membershipBefore: null,
//     membershipPolicy } so the orchestrator continues to resolvePrepaid.
//     Only require-mode (`requireMembership=true`) triggers the hard
//     ROLLBACK at #4/#5.
//   - Explicit-ID path (customerMembershipId present): insufficient balance
//     at ROLLBACK #10 is ALWAYS a hard fail regardless of requireMembership.
//     There is no soft mode for the explicit-ID path.
//   - Service-eligibility hard-fail (ROLLBACK #2) fires when
//     allow_membership=false AND either require-mode OR explicit-ID is in
//     effect; soft-mode auto-consume (neither require nor explicit) flips
//     wantAutoMembership to false and continues with no membership applied.
//
// buildMembershipInsufficientPayload at ROLLBACK #4 has its `message` field
// mutated after build to "No eligible membership entitlement found." —
// preserve byte-identical.
//
// Closure back-edges: 4 of the 5 success-shape fields are consumed by the
// post-INSERT ledger-write block (still in create.js for PR 5; PR 6 will
// absorb it). debitMinutes / debitUses drive the membership_ledger INSERT;
// membershipBefore + membershipPolicy drive the resolution payload built
// on a post-INSERT balance-UPDATE rowCount=0 failure. Returning all four
// out of this module keeps the orchestrator the only place they live.

const {
  getServiceAllowMembership,
  loadMembershipCheckoutPolicy,
  buildMembershipInsufficientPayload,
  prepaidTablesExist,
  resolvePrepaidSelection,
  computePrepaidRedemptionSelection,
} = require('../../utils/bookingRouteHelpers');

async function resolveMembership(client, ctx) {
  const {
    tenantId,
    serviceId,
    finalCustomerId,
    customerMembershipId,
    autoConsumeMembership,
    requireMembership,
    duration,
  } = ctx;

  let finalCustomerMembershipId = null;
  let debitMinutes = 0;
  let debitUses = 0;
  // Snapshot of selected membership balance BEFORE debit (for resolution UI)
  let membershipBefore = null;

  // Tenant membership checkout policy (defaults safe)
  const membershipPolicy = await loadMembershipCheckoutPolicy(client, tenantId);

  // Optional: auto-consume an eligible membership entitlement (platform-safe, no schema change)
  // If requireMembership=true, we will HARD FAIL when no eligible entitlement exists.
  let wantAutoMembership =
    (autoConsumeMembership === true || String(autoConsumeMembership).toLowerCase() === "true");
  let wantRequireMembership =
    (requireMembership === true || String(requireMembership).toLowerCase() === "true");

  const hasExplicitMembershipId =
    customerMembershipId != null && String(customerMembershipId).trim() !== "";

  // Service-level eligibility guard:
  // We only allow membership debits for services explicitly marked allow_membership=true.
  // This prevents accidental credit use for non-membership products (e.g., lessons, karaoke).
  const membershipRequested = wantAutoMembership || wantRequireMembership || hasExplicitMembershipId;

  if (membershipRequested) {
    if (!serviceId) {
      await client.query("ROLLBACK");
      return { ok: false, status: 400, body: { error: "Membership credits require a service selection." } };
    }

    const svcRule = await getServiceAllowMembership(client, tenantId, serviceId);
    if (!svcRule.allowed) {
      // Hard-fail when the caller explicitly requested membership use.
      if (wantRequireMembership || hasExplicitMembershipId) {
        await client.query("ROLLBACK");
        return {
          ok: false,
          status: 409,
          body: {
            error: "This service is not eligible for membership credits. Ask the business to enable membership for this service in Setup → Memberships.",
          },
        };
      }

      // Soft mode: ignore auto consumption for non-eligible services.
      wantAutoMembership = false;
      wantRequireMembership = false;
    }
  }

  if (!finalCustomerMembershipId && (wantAutoMembership || wantRequireMembership) && !customerMembershipId) {
    if (!finalCustomerId) {
      await client.query("ROLLBACK");
      return { ok: false, status: 400, body: { error: "Membership consumption requires a signed-in customer." } };
    }

    // Pick ONE eligible active membership deterministically.
    // Eligibility: active + not expired + (has any remaining balance: minutes_remaining > 0 OR uses_remaining > 0)
    // NOTE: We intentionally allow selecting an insufficient membership so the UX can offer Smart Top-Up.
    // Ordering: soonest expiry first (NULLS LAST), then highest remaining balance, then id.
    const eligible = await client.query(
      `
      SELECT id, customer_id, minutes_remaining, uses_remaining
      FROM customer_memberships
      WHERE tenant_id = $1
        AND customer_id = $2
        AND COALESCE(status, 'active') = 'active'
        AND (end_at IS NULL OR end_at > NOW())
        AND (COALESCE(minutes_remaining,0) > 0 OR COALESCE(uses_remaining,0) > 0)
      ORDER BY
        end_at NULLS LAST,
        end_at ASC,
        COALESCE(minutes_remaining,0) DESC,
        COALESCE(uses_remaining,0) DESC,
        id ASC
      LIMIT 1
      FOR UPDATE
      `,
      [tenantId, finalCustomerId]
    );

    if (!eligible.rows.length) {
      if (wantRequireMembership) {
        await client.query("ROLLBACK");
        const payload = buildMembershipInsufficientPayload({ policy: membershipPolicy, durationMinutes: Number(duration), membershipBefore: null, membershipId: null });
        payload.message = "No eligible membership entitlement found.";
        return { ok: false, status: 409, body: payload };
      }
      // soft mode: proceed without membership
    } else {
      const cm = eligible.rows[0];
      const minsRemaining = Number(cm.minutes_remaining || 0);
      const usesRemaining = Number(cm.uses_remaining || 0);

      // Debit policy mirrors the explicit membership path:
      // capture balances for resolution
      membershipBefore = { minutes_remaining: minsRemaining, uses_remaining: usesRemaining, id: cm.id };

      if (minsRemaining >= Number(duration)) {
        debitMinutes = -Number(duration);
        debitUses = 0;
      } else if (usesRemaining >= 1) {
        debitMinutes = 0;
        debitUses = -1;
      } else if (wantRequireMembership) {
        await client.query("ROLLBACK");
        return {
          ok: false,
          status: 409,
          body: buildMembershipInsufficientPayload({ policy: membershipPolicy, durationMinutes: Number(duration), membershipBefore, membershipId: cm.id }),
        };
      }

      finalCustomerMembershipId = cm.id;
    }
  }

  if (hasExplicitMembershipId) {
    const cmid = Number(customerMembershipId);
    if (!Number.isFinite(cmid) || cmid <= 0) {
      await client.query("ROLLBACK");
      return { ok: false, status: 400, body: { error: "Invalid customerMembershipId." } };
    }

    // Lock the membership row to prevent concurrent double-spend.
    const cmRes = await client.query(
      `
      SELECT id, customer_id, status, end_at, minutes_remaining, uses_remaining
      FROM customer_memberships
      WHERE id=$1 AND tenant_id=$2
      FOR UPDATE
      `,
      [cmid, tenantId]
    );

    if (!cmRes.rows.length) {
      await client.query("ROLLBACK");
      return { ok: false, status: 400, body: { error: "Unknown customerMembershipId for tenant." } };
    }

    const cm = cmRes.rows[0];

    // If booking is linked to a customer, enforce membership belongs to same customer.
    if (finalCustomerId && Number(cm.customer_id) !== Number(finalCustomerId)) {
      await client.query("ROLLBACK");
      return { ok: false, status: 400, body: { error: "Membership does not belong to this customer." } };
    }

    if (String(cm.status) !== "active" || (cm.end_at && new Date(cm.end_at).getTime() <= Date.now())) {
      await client.query("ROLLBACK");
      return { ok: false, status: 400, body: { error: "Membership is not active or is expired." } };
    }

    const minsRemaining = Number(cm.minutes_remaining || 0);
    const usesRemaining = Number(cm.uses_remaining || 0);

    membershipBefore = { minutes_remaining: minsRemaining, uses_remaining: usesRemaining, id: cm.id };

    // Default debit policy:
    // - If membership has enough minutes, debit booking duration minutes.
    // - Otherwise, if it has uses, debit 1 use.
    // (You can make this service-specific later.)
    if (minsRemaining >= Number(duration)) {
      debitMinutes = -Number(duration);
      debitUses = 0;
    } else if (usesRemaining >= 1) {
      debitMinutes = 0;
      debitUses = -1;
    } else {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 409,
        body: buildMembershipInsufficientPayload({ policy: membershipPolicy, durationMinutes: Number(duration), membershipBefore, membershipId: cm.id }),
      };
    }

    finalCustomerMembershipId = cm.id;
  }

  return {
    ok: true,
    finalCustomerMembershipId,
    debitMinutes,
    debitUses,
    membershipBefore,
    membershipPolicy,
  };
}

async function resolvePrepaid(client, ctx) {
  const {
    tenantId,
    resolvedServiceId,
    finalCustomerId,
    duration,
    serviceDurationMinutes,
    prepaidEntitlementId,
    autoConsumePrepaid,
    requirePrepaid,
  } = ctx;

  const wantRequirePrepaid =
    requirePrepaid === true || String(requirePrepaid).toLowerCase() === "true";

  const prepaidRequested =
    autoConsumePrepaid === true || String(autoConsumePrepaid).toLowerCase() === "true" ||
    wantRequirePrepaid ||
    (prepaidEntitlementId != null && String(prepaidEntitlementId).trim() !== "");

  if (!prepaidRequested) {
    return { ok: true, prepaidApplied: null };
  }

  if (!finalCustomerId) {
    await client.query("ROLLBACK");
    return { ok: false, status: 400, body: { error: "Prepaid redemption requires a signed-in customer." } };
  }

  const prepaidReady = await prepaidTablesExist(client);
  if (!prepaidReady) {
    await client.query("ROLLBACK");
    return { ok: false, status: 503, body: { error: "Prepaid accounting schema is not installed." } };
  }

  const selectedEntitlement = await resolvePrepaidSelection(client, {
    tenantId,
    customerId: finalCustomerId,
    entitlementId: prepaidEntitlementId ? Number(prepaidEntitlementId) : null,
    serviceId: resolvedServiceId,
  });

  if (!selectedEntitlement) {
    if (wantRequirePrepaid) {
      await client.query("ROLLBACK");
      return { ok: false, status: 409, body: { error: "No eligible prepaid balance found for this booking." } };
    }
    return { ok: true, prepaidApplied: null };
  }

  const prepaidSelection = computePrepaidRedemptionSelection(selectedEntitlement, Number(duration), Number(serviceDurationMinutes || duration || 0));
  const remaining = Number(selectedEntitlement.remaining_quantity || 0);
  if (remaining < prepaidSelection.redeemedQuantity) {
    await client.query("ROLLBACK");
    return { ok: false, status: 409, body: { error: "Insufficient prepaid balance for this booking." } };
  }

  return {
    ok: true,
    prepaidApplied: {
      entitlementId: Number(selectedEntitlement.id),
      prepaidProductId: Number(selectedEntitlement.prepaid_product_id),
      prepaidProductName: selectedEntitlement.prepaid_product_name || null,
      redeemedQuantity: prepaidSelection.redeemedQuantity,
      redemptionMode: prepaidSelection.redemptionMode,
      notes: `Applied to booking`,
    },
  };
}

module.exports = { resolveMembership, resolvePrepaid };
