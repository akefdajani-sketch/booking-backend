#!/usr/bin/env node
'use strict';

// scripts/backfill_contract_bookings.js
// CONTRACT-CALENDAR-1 — one-time idempotent backfill.
//
// For every existing 'signed' or 'active' contract, ensure a phantom booking
// exists in the bookings table. Also syncs resources.lease_* fields from the
// contract.
//
// Idempotent: safe to run multiple times. Skips contracts that already have
// a live phantom booking.
//
// Usage:
//   node scripts/backfill_contract_bookings.js
//   node scripts/backfill_contract_bookings.js --dry-run
//   node scripts/backfill_contract_bookings.js --tenant 33
//
// Exits 0 on success, 1 on any failure (and rolls back the failing contract).

const { pool } = require('../db');
const {
  materializeContractBooking,
  syncResourceLeaseFromContract,
} = require('../utils/contracts');

const args     = process.argv.slice(2);
const dryRun   = args.includes('--dry-run');
const tenantArg = args.indexOf('--tenant');
const tenantFilter = tenantArg >= 0 ? Number(args[tenantArg + 1]) : null;

async function main() {
  console.log(`[backfill] starting${dryRun ? ' (DRY RUN — no writes)' : ''}${tenantFilter ? ` (tenant ${tenantFilter} only)` : ''}`);

  const tenantClause = tenantFilter ? `AND c.tenant_id = ${Number(tenantFilter)}` : '';
  const { rows: contracts } = await pool.query(
    `SELECT c.*
       FROM contracts c
      WHERE c.status IN ('signed', 'active')
        ${tenantClause}
      ORDER BY c.tenant_id, c.id`
  );

  console.log(`[backfill] found ${contracts.length} signed/active contract(s) to evaluate`);

  let materialized = 0;
  let alreadyHad   = 0;
  let leaseSynced  = 0;
  let errors       = 0;

  for (const contract of contracts) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const phantom = await materializeContractBooking(client, contract);
      const lease   = await syncResourceLeaseFromContract(client, contract, 'apply');

      if (dryRun) {
        await client.query('ROLLBACK');
      } else {
        await client.query('COMMIT');
      }

      if (phantom.created) materialized += 1;
      else                 alreadyHad   += 1;
      if (lease.synced)    leaseSynced  += 1;

      console.log(
        `[backfill] contract ${contract.id} (${contract.contract_number || 'no#'}) ` +
        `→ booking ${phantom.bookingId}` +
        `${phantom.created ? ' [CREATED]' : ' [exists]'}` +
        `${lease.synced ? ` [lease ${lease.mode}]` : ''}`
      );
    } catch (err) {
      errors += 1;
      await client.query('ROLLBACK').catch(() => {});
      console.error(`[backfill] FAILED contract ${contract.id}: ${err.message}`);
    } finally {
      client.release();
    }
  }

  console.log(`[backfill] done. materialized=${materialized}, already_existed=${alreadyHad}, lease_synced=${leaseSynced}, errors=${errors}`);
  if (errors > 0) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[backfill] FATAL:', err);
    process.exit(1);
  });
