'use strict';

// utils/stripeInvoicing.js
// G2a-2: Create Stripe invoices for contract milestones. Lazy-create per-tenant
// Stripe Tax Rate on first use.
//
// All Stripe invoices created here include metadata:
//   { contract_invoice_id, contract_id, tenant_id }
// This metadata is how routes/stripeWebhook.js routes incoming events to
// contract_invoices vs. the existing tenant_invoices (SaaS billing) path.

const { pool } = require('../db');
const logger = require('./logger');
const { getStripe, isStripeEnabled } = require('./stripe');
const { loadTenantTaxConfig } = require('./taxEngine');

// Convert NUMERIC(12,3) money to Stripe's minor-unit integer.
// JOD has 3 decimal places (fils), so 1.500 JOD → 1500.
// USD has 2 (cents), so 10.000 USD → 1000 (we floor the third decimal).
// We look up the decimal count from a small table; Stripe rounds anyway,
// but being explicit avoids float wobble.
const CURRENCY_DECIMALS = {
  JOD: 3, KWD: 3, BHD: 3, OMR: 3, TND: 3,
  USD: 2, EUR: 2, GBP: 2, AED: 2, SAR: 2, EGP: 2,
  JPY: 0, KRW: 0,
};

function moneyToMinor(amount, currencyCode) {
  const n = Number(amount);
  if (!Number.isFinite(n)) throw new Error('moneyToMinor: invalid amount');
  const decimals = CURRENCY_DECIMALS[String(currencyCode || '').toUpperCase()] ?? 2;
  return Math.round(n * Math.pow(10, decimals));
}

// ---------------------------------------------------------------------------
// Lazy-ensure per-tenant Stripe Tax Rate
// ---------------------------------------------------------------------------

/**
 * Returns the Stripe Tax Rate ID for a tenant. If the tenant has one stored,
 * returns it; otherwise creates one from tenants.tax_config and persists.
 *
 * Returns null if the tenant has no VAT configured (vat_rate = 0). Callers
 * should then omit `default_tax_rates` from the Stripe invoice.
 */
async function ensureStripeTaxRate(tenantId) {
  const stripe = getStripe();
  if (!stripe) return null;

  const { rows } = await pool.query(
    `SELECT stripe_tax_rate_id FROM tenants WHERE id = $1`,
    [tenantId]
  );
  if (rows.length === 0) throw new Error(`tenant ${tenantId} not found`);
  if (rows[0].stripe_tax_rate_id) {
    return rows[0].stripe_tax_rate_id;
  }

  const taxCfg = await loadTenantTaxConfig(tenantId);
  const vatRate = Number(taxCfg.vat_rate || 0);
  if (!vatRate || vatRate <= 0) {
    return null; // no VAT → no tax rate needed
  }

  const taxRate = await stripe.taxRates.create({
    display_name: taxCfg.vat_label || 'VAT',
    description:  `${vatRate}% ${taxCfg.vat_label || 'VAT'}`,
    percentage:   vatRate,
    inclusive:    Boolean(taxCfg.tax_inclusive),
    metadata:     { tenant_id: String(tenantId) },
  });

  await pool.query(
    `UPDATE tenants SET stripe_tax_rate_id = $1, updated_at = NOW() WHERE id = $2`,
    [taxRate.id, tenantId]
  );

  logger.info({ tenantId, stripeTaxRateId: taxRate.id, vatRate }, 'Stripe Tax Rate created for tenant');
  return taxRate.id;
}

// ---------------------------------------------------------------------------
// Ensure the customer has a Stripe Customer record
// ---------------------------------------------------------------------------

/**
 * Returns a Stripe customer ID for the given DB customer, creating one if
 * needed. Writes the ID back to customers.stripe_customer_id (column added
 * here if not present — assumed to exist; see migration note in handoff).
 *
 * For simplicity and to avoid adding another migration, we store the stripe
 * customer id in the `metadata` JSONB column on customers (already present),
 * under key `stripe_customer_id`. Adjust if a dedicated column exists.
 */
async function ensureStripeCustomer(customer, tenantId) {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe not configured');

  // Prefer a top-level column if present
  if (customer.stripe_customer_id) {
    return customer.stripe_customer_id;
  }

  // Fall back to metadata JSONB
  const meta = customer.metadata || {};
  if (meta && meta.stripe_customer_id) {
    return meta.stripe_customer_id;
  }

  const created = await stripe.customers.create({
    name:  customer.name || undefined,
    email: customer.email || undefined,
    phone: customer.phone || undefined,
    metadata: {
      tenant_id:   String(tenantId),
      customer_id: String(customer.id),
    },
  });

  // Persist: prefer dedicated column if it exists, else metadata JSONB merge.
  try {
    await pool.query(
      `UPDATE customers SET stripe_customer_id = $1 WHERE id = $2 AND tenant_id = $3`,
      [created.id, customer.id, tenantId]
    );
  } catch (err) {
    // column may not exist in this environment; fall back to metadata
    await pool.query(
      `UPDATE customers
          SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
        WHERE id = $2 AND tenant_id = $3`,
      [JSON.stringify({ stripe_customer_id: created.id }), customer.id, tenantId]
    );
  }

  logger.info({ tenantId, customerId: customer.id, stripeCustomerId: created.id },
              'Stripe customer created');
  return created.id;
}

// ---------------------------------------------------------------------------
// Create + finalize + send a Stripe invoice for a contract milestone
// ---------------------------------------------------------------------------

/**
 * Creates a Stripe invoice for the given contract_invoices row, finalizes and
 * sends it. Returns { stripeInvoiceId, hostedInvoiceUrl, status }.
 *
 * Caller must have already verified tenant_id ownership.
 */
async function createStripeInvoiceForMilestone({ contract, contractInvoice, tenant, customer }) {
  if (!isStripeEnabled()) {
    throw new Error('Stripe is not configured on this server');
  }
  const stripe = getStripe();

  const currency = String(contract.currency_code || 'JOD').toLowerCase();
  const amountMinor = moneyToMinor(contractInvoice.amount, currency);
  const taxRateId = await ensureStripeTaxRate(tenant.id);
  const stripeCustomerId = await ensureStripeCustomer(customer, tenant.id);

  // 1. Create the invoice item (line item on the invoice)
  const description = [
    contract.contract_number,
    contractInvoice.milestone_label || `Milestone ${contractInvoice.milestone_index + 1}`,
  ].filter(Boolean).join(' — ');

  const invoiceItem = await stripe.invoiceItems.create({
    customer: stripeCustomerId,
    amount:   amountMinor,
    currency,
    description,
    tax_rates: taxRateId ? [taxRateId] : undefined,
    metadata: {
      tenant_id: String(tenant.id),
      contract_id: String(contract.id),
      contract_invoice_id: String(contractInvoice.id),
    },
  });

  // 2. Create the invoice with metadata so the webhook can route this to
  //    contract_invoices (not tenant_invoices).
  const dueDate = contractInvoice.due_date
    ? Math.floor(new Date(contractInvoice.due_date).getTime() / 1000)
    : undefined;

  const invoice = await stripe.invoices.create({
    customer:            stripeCustomerId,
    collection_method:   'send_invoice',
    days_until_due:      dueDate ? undefined : 7,
    due_date:            dueDate,
    description:         `Contract ${contract.contract_number}: ${contractInvoice.milestone_label || ''}`.trim(),
    metadata: {
      tenant_id:           String(tenant.id),
      contract_id:         String(contract.id),
      contract_invoice_id: String(contractInvoice.id),
      flexrz_channel:      'contract',  // explicit marker for the webhook router
    },
  });

  // 3. Finalize and send
  const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
  await stripe.invoices.sendInvoice(finalized.id);

  return {
    stripeInvoiceId:     finalized.id,
    hostedInvoiceUrl:    finalized.hosted_invoice_url || null,
    invoiceItemId:       invoiceItem.id,
    status:              'sent',
  };
}

// ---------------------------------------------------------------------------
// Mark a Stripe invoice as paid_out_of_band (cash / bank transfer)
// ---------------------------------------------------------------------------

async function markStripeInvoicePaidOutOfBand(stripeInvoiceId) {
  if (!isStripeEnabled()) return; // no-op if Stripe isn't configured
  const stripe = getStripe();
  try {
    await stripe.invoices.pay(stripeInvoiceId, { paid_out_of_band: true });
  } catch (err) {
    // If already paid, Stripe returns 400 invoice_payment_required — swallow.
    if (err && err.code === 'invoice_no_payment_required') return;
    logger.warn({ stripeInvoiceId, err: err && err.message },
                'markStripeInvoicePaidOutOfBand failed (non-fatal)');
  }
}

// ---------------------------------------------------------------------------
// Void a Stripe invoice (e.g. contract cancelled)
// ---------------------------------------------------------------------------

async function voidStripeInvoice(stripeInvoiceId) {
  if (!isStripeEnabled()) return;
  const stripe = getStripe();
  try {
    await stripe.invoices.voidInvoice(stripeInvoiceId);
  } catch (err) {
    logger.warn({ stripeInvoiceId, err: err && err.message },
                'voidStripeInvoice failed (non-fatal)');
  }
}

module.exports = {
  ensureStripeTaxRate,
  ensureStripeCustomer,
  createStripeInvoiceForMilestone,
  markStripeInvoicePaidOutOfBand,
  voidStripeInvoice,
  // exposed for tests
  _internal: { moneyToMinor },
};
