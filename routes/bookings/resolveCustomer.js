'use strict';

// routes/bookings/resolveCustomer.js
//
// Pre-BEGIN customer record resolution for the booking creation engine.
// Extracted from routes/bookings/create.js (PR 2, Phase 1 refactor).
//
// Responsibility: given a tenant + a derived customer identity (email + name
// + phone), find the existing customers row by tenant + lowercased email,
// or INSERT a new minimal record. Runs against the pool (db.query), NOT a
// transaction client — this fires before BEGIN.
//
// Error pattern matches validate.js: returns
//   { ok: true, customer: { id, name, phone, email } }
// or
//   { ok: false, status, body }
//
// IMPORTANT — security invariant preserved: customerId from the client
// payload is NEVER trusted. The orchestrator drops req.body.customerId and
// only the email-keyed lookup or INSERT-RETURNING decides the canonical id.

const db = require('../../db');

async function resolveCustomer({ tenantId, email, name, phone, isAdminBypass }) {
  // Initial values used when there is no existing row, or as fallbacks when
  // the existing row has empty fields. Phone is normalized to null when blank
  // so the DB sees NULL (not ''). Name falls back to "Customer" to satisfy
  // the customers.name NOT NULL (where applicable).
  let finalCustomerName = String(name || '').trim() || 'Customer';
  let finalCustomerPhone = String(phone || '').trim() || null;
  const finalCustomerEmail = email;

  const existingCust = await db.query(
    `SELECT id, name, phone, email
     FROM customers
     WHERE tenant_id=$1 AND LOWER(email)=LOWER($2)
     LIMIT 1`,
    [tenantId, finalCustomerEmail]
  );

  let finalCustomerId = null;
  if (existingCust.rows.length) {
    const row = existingCust.rows[0];
    finalCustomerId = row.id;
    finalCustomerName = String(row.name || finalCustomerName).trim() || finalCustomerName;
    // Prefer stored phone; only update if client supplied a phone.
    finalCustomerPhone = String(row.phone || '').trim() || finalCustomerPhone;
  } else {
    // Create a minimal customer record.
    const ins = await db.query(
      `INSERT INTO customers (tenant_id, name, phone, email, created_at)
       VALUES ($1,$2,$3,$4,NOW())
       RETURNING id`,
      [tenantId, finalCustomerName, finalCustomerPhone, finalCustomerEmail]
    );
    finalCustomerId = ins.rows?.[0]?.id || null;
  }

  if (!finalCustomerId) {
    return { ok: false, status: 500, body: { error: 'Failed to resolve customer.' } };
  }

  // isAdminBypass is accepted in the signature for caller clarity (it
  // signals which derivation path produced `name`/`phone` upstream) but is
  // not consumed here — the lookup/insert logic is identical for public
  // and admin-bypass flows.
  void isAdminBypass;

  return {
    ok: true,
    customer: {
      id: finalCustomerId,
      name: finalCustomerName,
      phone: finalCustomerPhone,
      email: finalCustomerEmail,
    },
  };
}

module.exports = resolveCustomer;
