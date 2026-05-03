'use strict';

// utils/aiContextCache.js
// ────────────────────────────────────────────────────────────────────────────
// VOICE-PERF-1: In-memory TTL cache for AI context lookups.
//
// Both routes/ai.js's fetchBusinessContext() and fetchCustomerData() do
// 4-7 DB queries per voice/chat turn. Across a typical 5-turn voice
// session that's 20-35 redundant queries — context doesn't change mid-call.
// This module wraps both calls with a 60s TTL cache plus explicit
// invalidation hooks called by mutation routes (services CRUD, rate rules,
// memberships, etc.) so price/service edits made in the dashboard surface
// to the AI immediately rather than waiting for TTL expiry.
//
// Scope: single Render instance. We don't have a Redis layer yet, but the
// access pattern (one tenant per session, sticky to one instance) and the
// 60s TTL makes per-process caching genuinely useful — typical scale-out
// concern (cache divergence between instances) reduces to a 60s staleness
// window, same as the TTL itself.
//
// Bust API: mutation routes call bustBusiness(tenantId) when anything in
// the business context changes (services, rates, hours, etc.) and
// bustCustomer(tenantId, email) when a customer's bookings/memberships/
// packages change. bustTenant(tenantId) clears business + every customer
// for that tenant — used for tenant-wide changes (timezone, branding).
// ────────────────────────────────────────────────────────────────────────────

const TTL_MS = 60_000;

// Map<tenantIdString, { value, expiresAt }>
const businessCache = new Map();

// Map<`${tenantId}:${emailLower}`, { value, expiresAt }>
const customerCache = new Map();

// Diagnostic counters — useful for /health
const counters = {
  business_hits:   0,
  business_misses: 0,
  customer_hits:   0,
  customer_misses: 0,
  business_busts:  0,
  customer_busts:  0,
};

function nowMs() { return Date.now(); }

function _businessKey(tenantId) {
  return String(tenantId);
}

function _customerKey(tenantId, email) {
  const emailLower = String(email || '').toLowerCase();
  return `${tenantId}:${emailLower}`;
}

function getBusiness(tenantId) {
  if (tenantId == null) return null;
  const entry = businessCache.get(_businessKey(tenantId));
  if (!entry) {
    counters.business_misses++;
    return null;
  }
  if (nowMs() > entry.expiresAt) {
    businessCache.delete(_businessKey(tenantId));
    counters.business_misses++;
    return null;
  }
  counters.business_hits++;
  return entry.value;
}

function setBusiness(tenantId, value) {
  if (tenantId == null) return;
  businessCache.set(_businessKey(tenantId), {
    value,
    expiresAt: nowMs() + TTL_MS,
  });
}

function getCustomer(tenantId, email) {
  if (tenantId == null || !email) return null;
  const entry = customerCache.get(_customerKey(tenantId, email));
  if (!entry) {
    counters.customer_misses++;
    return null;
  }
  if (nowMs() > entry.expiresAt) {
    customerCache.delete(_customerKey(tenantId, email));
    counters.customer_misses++;
    return null;
  }
  counters.customer_hits++;
  return entry.value;
}

function setCustomer(tenantId, email, value) {
  if (tenantId == null || !email) return;
  customerCache.set(_customerKey(tenantId, email), {
    value,
    expiresAt: nowMs() + TTL_MS,
  });
}

// ── Invalidation API ────────────────────────────────────────────────────────

function bustBusiness(tenantId) {
  if (tenantId == null) return;
  if (businessCache.delete(_businessKey(tenantId))) {
    counters.business_busts++;
  }
}

function bustCustomer(tenantId, email) {
  if (tenantId == null) return;
  // Specific customer
  if (email) {
    if (customerCache.delete(_customerKey(tenantId, email))) {
      counters.customer_busts++;
    }
    return;
  }
  // No email → bust all customers for this tenant
  const prefix = `${tenantId}:`;
  for (const k of customerCache.keys()) {
    if (k.startsWith(prefix)) {
      customerCache.delete(k);
      counters.customer_busts++;
    }
  }
}

function bustTenant(tenantId) {
  bustBusiness(tenantId);
  bustCustomer(tenantId);
}

function stats() {
  return {
    ttl_ms:            TTL_MS,
    business_entries:  businessCache.size,
    customer_entries:  customerCache.size,
    ...counters,
  };
}

// Useful for tests
function _resetForTests() {
  businessCache.clear();
  customerCache.clear();
  for (const k of Object.keys(counters)) counters[k] = 0;
}

module.exports = {
  TTL_MS,
  getBusiness, setBusiness,
  getCustomer, setCustomer,
  bustBusiness, bustCustomer, bustTenant,
  stats,
  _resetForTests,
};
