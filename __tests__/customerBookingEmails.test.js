'use strict';

// __tests__/customerBookingEmails.test.js
// PR H (Customer booking emails).
//
// Tests cover:
//   - shouldSendEmail gate composition (plan + creds + per-event toggle)
//   - Each of the 4 customer booking templates renders successfully
//   - Reason codes match SMS/WA gate API for consistency
//
// Mocks db, logger, and entitlements so tests run without infrastructure.

jest.mock('../db', () => ({
  query: jest.fn(),
}));
jest.mock('../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../utils/entitlements', () => ({
  hasFeature: jest.fn(),
}));
jest.mock('../utils/twilioCredentials', () => ({
  isTwilioEnabledForTenant: jest.fn().mockResolvedValue(false),
}));
jest.mock('../utils/whatsappCredentials', () => ({
  isWhatsAppEnabledForTenant: jest.fn().mockResolvedValue(false),
}));

const db = require('../db');
const { hasFeature } = require('../utils/entitlements');
const { shouldSendEmail } = require('../utils/notificationGates');
const templates = require('../utils/customerBookingEmailTemplates');

describe('shouldSendEmail — 3-gate composition', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.RESEND_API_KEY;
  });

  test('rejects invalid eventKind', async () => {
    const r = await shouldSendEmail(1, 'bogus_event');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/invalid eventKind/);
  });

  test('returns plan_disabled when tenant lacks email_reminders feature', async () => {
    hasFeature.mockResolvedValue(false);
    const r = await shouldSendEmail(1, 'confirmations');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('plan_disabled');
  });

  test('returns creds_missing when RESEND_API_KEY is unset', async () => {
    hasFeature.mockResolvedValue(true);
    const r = await shouldSendEmail(1, 'confirmations');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('creds_missing');
  });

  test('returns tenant_toggle_off when toggle column is FALSE', async () => {
    hasFeature.mockResolvedValue(true);
    process.env.RESEND_API_KEY = 'fake_key';
    db.query.mockResolvedValueOnce({ rows: [{ toggle: false }] });
    const r = await shouldSendEmail(1, 'confirmations');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('tenant_toggle_off');
    delete process.env.RESEND_API_KEY;
  });

  test('returns ok=true when all 3 gates pass', async () => {
    hasFeature.mockResolvedValue(true);
    process.env.RESEND_API_KEY = 'fake_key';
    db.query.mockResolvedValueOnce({ rows: [{ toggle: true }] });
    const r = await shouldSendEmail(1, 'confirmations');
    expect(r.ok).toBe(true);
    delete process.env.RESEND_API_KEY;
  });

  test('returns ok=true when toggle column is missing (generous default)', async () => {
    hasFeature.mockResolvedValue(true);
    process.env.RESEND_API_KEY = 'fake_key';
    // Simulate "column does not exist" error from the toggle read
    const err = new Error('column "email_confirmations_enabled" does not exist');
    db.query.mockRejectedValueOnce(err);
    const r = await shouldSendEmail(1, 'confirmations');
    // Pre-055 schema treats missing column as TRUE (legacy behavior preserved)
    expect(r.ok).toBe(true);
    delete process.env.RESEND_API_KEY;
  });

  test('honors per-event window toggles independently', async () => {
    hasFeature.mockResolvedValue(true);
    process.env.RESEND_API_KEY = 'fake_key';

    // 24h reminder OFF, 1h reminder ON — they're independent columns
    db.query
      .mockResolvedValueOnce({ rows: [{ toggle: false }] }) // reminder_24h
      .mockResolvedValueOnce({ rows: [{ toggle: true }] }); // reminder_1h

    const r24 = await shouldSendEmail(1, 'reminder_24h');
    expect(r24.ok).toBe(false);
    expect(r24.reason).toBe('tenant_toggle_off');

    const r1 = await shouldSendEmail(1, 'reminder_1h');
    expect(r1.ok).toBe(true);

    delete process.env.RESEND_API_KEY;
  });
});

describe('customerBookingEmailTemplates — all 4 templates render', () => {
  const ctx = {
    tenantName: 'Birdie Golf',
    tenantTimezone: 'Asia/Amman',
    bookingUrl: 'https://app.flexrz.com/book/birdie-golf',
    customerName: 'Akef',
    serviceName: '9-hole green fee',
    resourceName: 'Course A',
    startTime: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    bookingCode: 'BG-12345',
    accentColor: '#0a7c43',
  };

  test('renderBookingConfirmation produces tenant-branded subject + body', () => {
    const out = templates.renderBookingConfirmation(ctx);
    expect(out.subject).toMatch(/Birdie Golf/);
    expect(out.subject).toMatch(/Booking confirmed/);
    expect(out.html).toMatch(/Birdie Golf/);
    expect(out.html).toMatch(/9-hole green fee/);
    expect(out.html).toMatch(/Course A/);
    expect(out.html).toMatch(/BG-12345/);
    expect(out.html).toMatch(/#0a7c43/); // tenant accent color
    expect(out.text).toMatch(/9-hole green fee/);
  });

  test('renderBookingReminder24h has tomorrow framing', () => {
    const out = templates.renderBookingReminder24h(ctx);
    expect(out.subject).toMatch(/tomorrow/i);
    expect(out.html).toMatch(/See you tomorrow/);
    expect(out.html).toMatch(/Birdie Golf/);
  });

  test('renderBookingReminder1h has imminent framing', () => {
    const out = templates.renderBookingReminder1h(ctx);
    expect(out.subject).toMatch(/1 hour/);
    expect(out.html).toMatch(/See you in an hour/);
  });

  test('renderBookingCancellation has cancelled framing', () => {
    const out = templates.renderBookingCancellation(ctx);
    expect(out.subject).toMatch(/cancelled/i);
    expect(out.html).toMatch(/has been cancelled/);
    expect(out.html).toMatch(/Birdie Golf/);
  });

  test('templates escape HTML in user-controlled fields (XSS safe)', () => {
    const evilCtx = {
      ...ctx,
      customerName: '<script>alert(1)</script>Akef',
      tenantName: 'Birdie<img src=x onerror=alert(1)>',
      serviceName: 'Service & "quoted"',
    };
    const out = templates.renderBookingConfirmation(evilCtx);
    expect(out.html).not.toMatch(/<script>alert/);
    expect(out.html).not.toMatch(/<img src=x onerror/);
    expect(out.html).toMatch(/&lt;script&gt;/);
    expect(out.html).toMatch(/&amp;/);
  });

  test('templates handle missing optional fields gracefully', () => {
    const minimal = {
      tenantName: 'Birdie Golf',
      tenantTimezone: 'Asia/Amman',
      startTime: new Date().toISOString(),
    };
    expect(() => templates.renderBookingConfirmation(minimal)).not.toThrow();
    expect(() => templates.renderBookingReminder24h(minimal)).not.toThrow();
    expect(() => templates.renderBookingReminder1h(minimal)).not.toThrow();
    expect(() => templates.renderBookingCancellation(minimal)).not.toThrow();

    // Empty tenant name shouldn't break — falls back to no-prefix subject
    const out = templates.renderBookingConfirmation({
      ...minimal,
      tenantName: '',
    });
    expect(out.subject.length).toBeGreaterThan(0);
  });
});
