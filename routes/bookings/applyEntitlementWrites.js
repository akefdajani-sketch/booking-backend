'use strict';

// routes/bookings/applyEntitlementWrites.js
//
// Post-INSERT, in-transaction membership + prepaid bookkeeping. Extracted
// from routes/bookings/create.js (PR 6, Phase 1 refactor). Pairs with
// persist.js (booking row + booking_code + sessions); together they
// replace the original L269-848 in-transaction write block.
//
// Public entry: applyEntitlementWrites(client, ctx, bookingId, created) →
//   { ok: true, prepaidApplied } | { ok: false, status, body }
// On failure, ROLLBACK is already done inside the module.
//
// `created` is part of the signature for future use — the prepaid block
// (#19-#21 in the PR 6 inventory) currently has NO created gate, meaning
// idempotency replay can double-write prepaid_redemptions, decrement
// remaining_quantity twice, and write a duplicate prepaid_transactions
// row. PR 6 preserves this verbatim; a Phase 1 cleanup PR after PR 7
// will gate the prepaid block on `created`. Keeping `created` in the
// signature now so the cleanup is a one-line patch, not an API change.
//
// ROLLBACK paths inside (2):
//   - Zero-delta debit guard (500, both debitMinutes and debitUses are 0)
//   - membership_insufficient_balance after debit (409, balance UPDATE
//     returned rowCount=0)
//
// Membership 23505 swallow at the ledger INSERT is the "no double-debit"
// invariant — preserved byte-identical. Test 4 (idempotency replay)
// explicitly asserts this.
//
// prepaidApplied is the same object reference passed in via ctx; it gets
// mutated in place (.redemptionId and .remainingQuantity fields set from
// RETURNING). Returning it explicitly per the PR 6 contract for boundary
// visibility — same reference, visible at the destructure.

const { buildMembershipResolution } = require('../../utils/bookingRouteHelpers');

// ─── writeMembershipSideEffects ────────────────────────────────────────────
// If a membership was applied, debit it once per booking (idempotent by
// unique constraint on customer_membership_id, booking_id). Then recompute
// the balance in the SAME transaction so the system is correct even if
// DB triggers are incomplete in a given environment.
async function writeMembershipSideEffects(client, ctx, bookingId) {
  const {
    tenantId,
    finalCustomerMembershipId,
    debitMinutes,
    debitUses,
    membershipBefore,
    membershipPolicy,
  } = ctx;

  if (!finalCustomerMembershipId) return { ok: true };

  const minutesDelta = Number(debitMinutes || 0);
  const usesDelta = Number(debitUses || 0);

  // Guard: never write a no-op ledger line.
  // Can happen if durationMinutes is accidentally 0, or if the debit policy
  // fails to set deltas.
  if (minutesDelta === 0 && usesDelta === 0) {
    await client.query("ROLLBACK");
    return {
      ok: false,
      status: 500,
      body: {
        error: "Membership debit failed: computed a zero delta. Please contact support.",
      },
    };
  }

  let ledgerInserted = false;
  try {
    await client.query(
      `
      INSERT INTO membership_ledger
        (tenant_id, customer_membership_id, booking_id, type, minutes_delta, uses_delta, note)
      VALUES
        ($1, $2, $3, 'debit', $4, $5, $6)
      `,
      [
        tenantId,
        finalCustomerMembershipId,
        bookingId,
        minutesDelta || null,
        usesDelta || null,
        `Debit for booking ${bookingId}`,
      ]
    );
    ledgerInserted = true;
  } catch (e) {
    // If this is a replay, the ledger row may already exist. Ignore unique-violation.
    if (!(e && e.code === "23505")) throw e;
  }

  // Apply balance changes in the SAME transaction.
  // IMPORTANT: Only apply the balance update if we actually inserted the ledger line.
  // If a unique-violation happened (replay), we must NOT double-debit.
  if (!ledgerInserted) return { ok: true };

  // Guard against going negative. This prevents a hard 500 (constraint violation)
  // and turns it into a clean "insufficient balance" response.
  const balRes = await client.query(
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
    RETURNING id, minutes_remaining, uses_remaining
    `,
    [finalCustomerMembershipId, tenantId]
  );

  if (balRes.rowCount === 0) {
    await client.query('ROLLBACK');
    return {
      ok: false,
      status: 409,
      body: {
        error: 'membership_insufficient_balance',
        message:
          'Membership does not have enough remaining balance for this booking. Please choose a shorter duration or a different payment option.',
        resolution: (() => {
          try {
            const before = membershipBefore || {};
            const beforeMins = Number(before.minutes_remaining ?? 0);
            const beforeUses = Number(before.uses_remaining ?? 0);

            // When we attempted a debit that would go negative, compute the shortage.
            const minutesShort =
              minutesDelta < 0 ? Math.max(0, -(beforeMins + minutesDelta)) : 0;
            const usesShort =
              usesDelta < 0 ? Math.max(0, -(beforeUses + usesDelta)) : 0;

            const r = buildMembershipResolution({
              policy: membershipPolicy,
              minutesShort,
              usesShort,
            });
            r.membershipId = before.id || null;
            return r;
          } catch {
            return buildMembershipResolution({ policy: membershipPolicy, minutesShort: 0, usesShort: 0 });
          }
        })(),
      },
    };
  }

  // If balance is now depleted, expire the membership so the customer can renew.
  // Works for minutes-only, uses-only, or hybrid (Birdie) memberships.
  try {
    const newBal = balRes.rows[0] || {};
    const mins = Number(newBal.minutes_remaining ?? 0);
    const uses = Number(newBal.uses_remaining ?? 0);

    if (mins <= 0 && uses <= 0) {
      await client.query(
        `
        UPDATE customer_memberships
        SET status = 'expired'
        WHERE id = $1 AND tenant_id = $2 AND status = 'active'
        `,
        [finalCustomerMembershipId, tenantId]
      );
    } else {
      // Time-based expiry guard (in case end_at has passed)
      await client.query(
        `
        UPDATE customer_memberships
        SET status = 'expired'
        WHERE id = $1 AND tenant_id = $2 AND status = 'active'
          AND end_at IS NOT NULL AND end_at <= NOW()
        `,
        [finalCustomerMembershipId, tenantId]
      );
    }
  } catch (eExpire) {
    // Don't fail booking if the expiry update fails; balances + ledger are already correct.
    console.warn("Membership expiry update failed (non-fatal):", eExpire?.message || eExpire);
  }

  return { ok: true };
}

// ─── writePrepaidSideEffects ───────────────────────────────────────────────
// If a prepaid entitlement was applied, INSERT the redemption row,
// decrement remaining_quantity (with 'consumed' status flip when zero),
// and INSERT a prepaid_transactions row. Mutates ctx.prepaidApplied with
// the redemptionId + remainingQuantity from RETURNING.
async function writePrepaidSideEffects(client, ctx, bookingId) {
  const { tenantId, finalCustomerId, prepaidApplied } = ctx;

  if (!prepaidApplied) return;

  const redemptionRes = await client.query(
    `
    INSERT INTO prepaid_redemptions (
      tenant_id,
      booking_id,
      customer_id,
      entitlement_id,
      prepaid_product_id,
      redeemed_quantity,
      redemption_mode,
      notes,
      metadata
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
    RETURNING *
    `,
    [
      tenantId,
      bookingId,
      finalCustomerId,
      prepaidApplied.entitlementId,
      prepaidApplied.prepaidProductId,
      prepaidApplied.redeemedQuantity,
      prepaidApplied.redemptionMode,
      prepaidApplied.notes,
      JSON.stringify({ source: 'booking_create' }),
    ]
  );
  prepaidApplied.redemptionId = redemptionRes.rows?.[0]?.id || null;

  const entUpdate = await client.query(
    `
    UPDATE customer_prepaid_entitlements
    SET
      remaining_quantity = GREATEST(0, COALESCE(remaining_quantity,0) - $3),
      status = CASE WHEN GREATEST(0, COALESCE(remaining_quantity,0) - $3) = 0 THEN 'consumed' ELSE status END,
      updated_at = NOW()
    WHERE tenant_id = $1 AND id = $2
    RETURNING remaining_quantity
    `,
    [tenantId, prepaidApplied.entitlementId, prepaidApplied.redeemedQuantity]
  );
  prepaidApplied.remainingQuantity = entUpdate.rows?.[0]?.remaining_quantity ?? null;

  await client.query(
    `
    INSERT INTO prepaid_transactions (
      tenant_id,
      customer_id,
      entitlement_id,
      prepaid_product_id,
      transaction_type,
      quantity_delta,
      money_amount,
      currency,
      notes,
      metadata,
      actor_user_id
    )
    VALUES ($1,$2,$3,$4,'redemption',$5,NULL,NULL,$6,$7::jsonb,NULL)
    `,
    [
      tenantId,
      finalCustomerId,
      prepaidApplied.entitlementId,
      prepaidApplied.prepaidProductId,
      -prepaidApplied.redeemedQuantity,
      `Applied to booking ${bookingId}`,
      JSON.stringify({ bookingId }),
    ]
  );
}

// ─── applyEntitlementWrites (public entry point) ──────────────────────────
// eslint-disable-next-line no-unused-vars
async function applyEntitlementWrites(client, ctx, bookingId, created) {
  const memResult = await writeMembershipSideEffects(client, ctx, bookingId);
  if (!memResult.ok) return memResult;

  await writePrepaidSideEffects(client, ctx, bookingId);

  return { ok: true, prepaidApplied: ctx.prepaidApplied || null };
}

module.exports = applyEntitlementWrites;
