'use strict';

// __tests__/email.test.js
// PR G (Transactional email foundation).
//
// Tests cover:
//   - sendEmail behavior when RESEND_API_KEY is unset (graceful fail-open)
//   - sendEmail validation (missing required fields)
//   - sendEmail behavior with EMAIL_KILL_SWITCH=true
//   - stripHtml fallback (HTML → text)
//   - Each template renders successfully with a realistic context object

// Mock the db module BEFORE requiring email.js — the email module's
// recordAttempt() touches the email_log table, but tests run without a DB.
jest.mock('../db', () => ({
  query: jest.fn().mockResolvedValue({ rows: [] }),
}));

// Suppress logger noise in test output. The email module logs intentionally
// at info/warn/error — we don't need to see it.
jest.mock('../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { sendEmail, _stripHtml } = require('../utils/email');
const templates = require('../utils/emailTemplates');

describe('utils/email — sendEmail', () => {
  beforeEach(() => {
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_KILL_SWITCH;
  });

  test('returns ok=false on missing required fields', async () => {
    const r1 = await sendEmail({});
    expect(r1.ok).toBe(false);
    expect(r1.error).toMatch(/missing/);

    const r2 = await sendEmail({ kind: 'invite' });
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/missing recipient/);

    const r3 = await sendEmail({ kind: 'invite', to: 'a@b.c', subject: 'x' });
    expect(r3.ok).toBe(false);
    expect(r3.error).toMatch(/missing html/);
  });

  test('returns ok=true with status="skipped" when RESEND_API_KEY is unset (fail open)', async () => {
    const r = await sendEmail({
      kind: 'invite',
      to: 'akef@example.com',
      subject: 'Test',
      html: '<p>Hello</p>',
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('skipped');
  });

  test('honors EMAIL_KILL_SWITCH=true', async () => {
    process.env.RESEND_API_KEY = 'fake_key';
    process.env.EMAIL_KILL_SWITCH = 'true';
    const r = await sendEmail({
      kind: 'invite',
      to: 'akef@example.com',
      subject: 'Test',
      html: '<p>Hello</p>',
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('skipped');
  });

  test('kill switch is case-insensitive and only "true" activates it', async () => {
    process.env.RESEND_API_KEY = 'fake_key';
    // Mock fetch so we don't actually hit Resend
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'msg_test_123' }),
      text: async () => '',
    });

    process.env.EMAIL_KILL_SWITCH = 'TRUE';
    let r = await sendEmail({ kind: 'x', to: 'a@b.c', subject: 's', html: '<p/>' });
    expect(r.status).toBe('skipped');

    process.env.EMAIL_KILL_SWITCH = '';
    r = await sendEmail({ kind: 'x', to: 'a@b.c', subject: 's', html: '<p/>' });
    expect(r.status).toBe('sent');

    process.env.EMAIL_KILL_SWITCH = 'false';
    r = await sendEmail({ kind: 'x', to: 'a@b.c', subject: 's', html: '<p/>' });
    expect(r.status).toBe('sent');

    delete process.env.EMAIL_KILL_SWITCH;
    delete process.env.RESEND_API_KEY;
  });

  test('returns ok=true with messageId when Resend accepts', async () => {
    process.env.RESEND_API_KEY = 'fake_key';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'msg_resend_xyz' }),
      text: async () => '',
    });

    const r = await sendEmail({
      kind: 'invite',
      to: 'akef@example.com',
      subject: 'Test',
      html: '<p>Hello</p>',
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('sent');
    expect(r.messageId).toBe('msg_resend_xyz');
    expect(global.fetch).toHaveBeenCalledTimes(1);

    delete process.env.RESEND_API_KEY;
  });

  test('returns ok=false on Resend HTTP error', async () => {
    process.env.RESEND_API_KEY = 'fake_key';
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => '{"name":"validation_error","message":"Invalid recipient"}',
    });

    const r = await sendEmail({
      kind: 'invite',
      to: 'broken@invalid',
      subject: 'Test',
      html: '<p>Hello</p>',
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/HTTP 422/);

    delete process.env.RESEND_API_KEY;
  });

  test('handles network error gracefully', async () => {
    process.env.RESEND_API_KEY = 'fake_key';
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET'));

    const r = await sendEmail({
      kind: 'invite',
      to: 'akef@example.com',
      subject: 'Test',
      html: '<p>Hello</p>',
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/ECONNRESET/);

    delete process.env.RESEND_API_KEY;
  });
});

describe('utils/email — stripHtml', () => {
  test('removes tags but preserves text and line breaks', () => {
    const out = _stripHtml('<p>Hi <strong>Akef</strong>,</p><p>Visit our site.</p>');
    expect(out).toContain('Hi Akef');
    expect(out).toContain('Visit our site');
    expect(out).not.toContain('<');
  });

  test('removes script and style blocks entirely', () => {
    const out = _stripHtml('<p>Visible</p><script>alert("xss")</script><style>body{}</style>');
    expect(out).toContain('Visible');
    expect(out).not.toContain('alert');
    expect(out).not.toContain('body{}');
  });

  test('decodes common HTML entities', () => {
    const out = _stripHtml('<p>5 &amp; 7 &lt; 8 &gt; &quot;hello&quot; &#39;world&#39;</p>');
    expect(out).toContain('5 & 7 < 8 >');
    expect(out).toContain('"hello"');
    expect(out).toContain("'world'");
  });
});

describe('utils/emailTemplates — all 5 templates render', () => {
  test('renderInvite produces subject + html + text', () => {
    const out = templates.renderInvite({
      tenantName: 'Birdie Golf',
      inviterName: 'Akef',
      role: 'manager',
      inviteUrl: 'https://app.flexrz.com/invite?token=abc',
      expiresAt: new Date(Date.now() + 7 * 86400 * 1000).toISOString(),
    });
    expect(out.subject).toMatch(/Akef/);
    expect(out.subject).toMatch(/Birdie Golf/);
    expect(out.html).toMatch(/Accept invite/);
    expect(out.html).toMatch(/Akef/);
    expect(out.html).toMatch(/manager/);
    expect(out.text).toMatch(/Birdie Golf/);
  });

  test('renderTrialWarning produces subject + html + text', () => {
    const out = templates.renderTrialWarning({
      tenantName: 'Birdie Golf',
      trialEndsAt: new Date(Date.now() + 3 * 86400 * 1000).toISOString(),
      planName: 'Growth',
      manageBillingUrl: 'https://app.flexrz.com/owner/birdie-golf',
    });
    expect(out.subject).toMatch(/trial ends/);
    expect(out.html).toMatch(/Manage subscription/);
    expect(out.html).toMatch(/Growth/);
  });

  test('renderPaymentFailed produces subject + html + text with formatted amount', () => {
    const out = templates.renderPaymentFailed({
      tenantName: 'Birdie Golf',
      amountCents: 29880,
      currency: 'usd',
      manageBillingUrl: 'https://app.flexrz.com/owner/birdie-golf',
    });
    expect(out.subject).toMatch(/Payment failed/);
    expect(out.html).toMatch(/298\.80/); // $298.80 from 29880 cents
    expect(out.html).toMatch(/Update payment method/);
  });

  test('renderWelcome produces subject + html + text', () => {
    const out = templates.renderWelcome({
      tenantName: 'Birdie Golf',
      planName: 'Growth',
      trialEndsAt: new Date(Date.now() + 14 * 86400 * 1000).toISOString(),
      dashboardUrl: 'https://app.flexrz.com/owner/birdie-golf',
    });
    expect(out.subject).toMatch(/Welcome to Flexrz/);
    expect(out.html).toMatch(/Open my dashboard/);
    expect(out.html).toMatch(/Birdie Golf/);
  });

  test('renderTrialConverted produces subject + html + text', () => {
    const out = templates.renderTrialConverted({
      tenantName: 'Birdie Golf',
      planName: 'Growth',
      amountCents: 29880,
      currency: 'usd',
      manageBillingUrl: 'https://app.flexrz.com/owner/birdie-golf',
    });
    expect(out.subject).toMatch(/subscription is now active/i);
    expect(out.html).toMatch(/View billing/);
    expect(out.html).toMatch(/298\.80/);
  });

  test('templates escape HTML in user-controlled fields', () => {
    const out = templates.renderInvite({
      tenantName: '<script>alert(1)</script>Birdie',
      inviterName: 'Akef & co',
      role: 'manager',
      inviteUrl: 'https://app.flexrz.com/invite?token=abc',
    });
    expect(out.html).not.toMatch(/<script>alert/);
    expect(out.html).toMatch(/&lt;script&gt;/);
    expect(out.html).toMatch(/Akef &amp; co/);
  });
});
