'use strict';

// PR-6a: shared error type for payment-link settlement utilities.
//
// Both utils/rentalPaymentLinkSettlement.js and
// utils/contractInvoiceLinkSettlement.js throw this on settle failures so
// callers — the public record-payment routes AND BAE /complete — can map
// failure codes uniformly:
//   - Route handlers   → HTTP status from err.httpStatus + err.message.
//   - BAE /complete    → needs_reconcile reason from `settle_failed_${err.code}`.

class SettlementError extends Error {
  constructor({ code, message, httpStatus }) {
    super(message);
    this.code       = code;
    this.httpStatus = httpStatus || 409;
    this.name       = 'SettlementError';
  }
}

module.exports = { SettlementError };
