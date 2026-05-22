'use strict';

// utils/inviteUrlBase.js
// Resolve the public-frontend base URL used to build invite-acceptance links
// (`${base}/invite?token=...`). Shared by tenant-user invites and
// staff-portal invites.
//
// Reads (in order):
//   1. FRONTEND_BASE_URL — historical name unique to this file's consumers
//   2. FRONTEND_URL      — canonical name documented in ENVIRONMENT.md and
//                          used by ~14 other routes (billing,
//                          dispatchNotifications, contract invoices, etc.)
//   3. https://app.flexrz.com — hardcoded last-resort default that matches
//                               the rest of the codebase.
//
// 2026-05-21 incident: only FRONTEND_URL was set on Render Production. The
// previous inline `process.env.FRONTEND_BASE_URL || ""` produced a null
// inviteUrl, the surrounding `if (inviteUrl)` short-circuited, and every
// invite email was silently dropped with no email_log row.

const logger = require('./logger');

let warnedOnce = false;

function getInviteUrlBase() {
  if (!process.env.FRONTEND_BASE_URL && !process.env.FRONTEND_URL && !warnedOnce) {
    warnedOnce = true;
    logger.warn(
      'FRONTEND_BASE_URL/FRONTEND_URL not set — using app.flexrz.com fallback for invite links'
    );
  }
  return String(
    process.env.FRONTEND_BASE_URL
    || process.env.FRONTEND_URL
    || 'https://app.flexrz.com'
  ).replace(/\/$/, '');
}

module.exports = { getInviteUrlBase };
