'use strict';

// __tests__/contractPdf.test.js
// G2a-2: Tests for utils/contractPdf.js

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Mock pdfkit with a fluent no-op stub that still emits the writeStream 'finish' event.
// We record method calls so tests can assert the sections were emitted.
const mockCalls = [];
function mockPDFDocumentCtor(/* opts */) {
  const methods = [
    'font','fontSize','fillColor','strokeColor','text','rect','fillAndStroke',
    'moveTo','lineTo','stroke','lineWidth','moveDown','addPage',
  ];
  const stub = {
    page: { height: 842, width: 595.28 },
    y: 100,
    _pipedStream: null,
  };
  methods.forEach((m) => {
    stub[m] = (...args) => {
      mockCalls.push({ method: m, args });
      return stub;
    };
  });
  stub.pipe = (s) => {
    stub._pipedStream = s;
    return stub;
  };
  stub.end = () => {
    // Simulate pdfkit writing bytes then closing the stream
    if (stub._pipedStream) {
      process.nextTick(() => {
        stub._pipedStream.emit('finish');
      });
    }
  };
  return stub;
}
jest.mock('pdfkit', () => mockPDFDocumentCtor, { virtual: false });

// Mock fs.createWriteStream so it returns an EventEmitter and doesn't actually write.
// Must be fully inline (no out-of-scope refs) due to jest.mock hoisting rules.
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  const { EventEmitter } = require('events');
  return {
    ...actual,
    createWriteStream: () => {
      const s = new EventEmitter();
      s.write = () => {};
      s.end = () => s.emit('finish');
      return s;
    },
    createReadStream: () => {
      const s = new EventEmitter();
      process.nextTick(() => {
        s.emit('data', Buffer.from('fake-pdf-bytes'));
        s.emit('end');
      });
      return s;
    },
  };
});

// Mock the R2 upload: return a deterministic URL
jest.mock('../utils/r2', () => ({
  uploadFileToR2: jest.fn(async ({ key }) => ({
    key,
    url: `https://r2-mock.example.com/${key}`,
  })),
  deleteFromR2: jest.fn(async () => {}),
  publicUrlForKey: jest.fn((k) => `https://r2-mock.example.com/${k}`),
  extractKeyFromPublicUrl: jest.fn(() => null),
  sanitizeEndpoint: jest.fn((x) => x),
  safeName: jest.fn((x) => x),
}));

jest.mock('../utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  child: jest.fn(() => ({ info: jest.fn(), error: jest.fn() })),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function baseArgs(overrides = {}) {
  return {
    contract: {
      id: 42,
      contract_number: 'AQB-CON-2026-0001',
      status: 'draft',
      start_date: '2026-05-01',
      end_date:   '2026-08-01',
      monthly_rate: 500.000,
      total_value: 1500.000,
      security_deposit: 500.000,
      currency_code: 'JOD',
      auto_release_on_expiry: false,
      created_at: '2026-04-23T12:00:00Z',
      payment_schedule_snapshot: [],
      terms: null,
    },
    tenant: {
      id: 33,
      name: 'Aqaba Book',
      slug: 'aqababooking',
      address_line1: 'Industrial City',
      city: 'Aqaba',
      country_code: 'JO',
      admin_email: 'info@aqababook.com',
    },
    customer: {
      id: 99,
      name: 'John Doe',
      phone: '+962771234567',
      email: 'john@example.com',
    },
    resource: {
      id: 7,
      name: 'Marina Suite 301',
      building_name: 'Marina Towers',
      property_details_json: { bedrooms: 2, bathrooms: 1, view: 'sea view' },
    },
    taxConfig: {
      vat_rate: 16,
      vat_label: 'VAT',
      tax_inclusive: false,
    },
    invoices: [
      { milestone_index: 0, milestone_label: 'Deposit', label: 'Deposit',
        amount: 375.000, due_date: '2026-04-23' },
      { milestone_index: 1, milestone_label: 'Month 1', label: 'Month 1',
        amount: 375.000, due_date: '2026-05-01' },
      { milestone_index: 2, milestone_label: 'Month 2', label: 'Month 2',
        amount: 375.000, due_date: '2026-06-01' },
      { milestone_index: 3, milestone_label: 'Month 3', label: 'Month 3',
        amount: 375.000, due_date: '2026-07-01' },
    ],
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('utils/contractPdf — formatters', () => {
  const { _internal } = require('../utils/contractPdf');

  describe('formatMoney', () => {
    test('3-decimal JOD with thousands separator', () => {
      expect(_internal.formatMoney(1500, 'JOD')).toBe('JOD 1,500.000');
      expect(_internal.formatMoney(500.5, 'JOD')).toBe('JOD 500.500');
      expect(_internal.formatMoney(0.001, 'JOD')).toBe('JOD 0.001');
    });
    test('handles missing currency code', () => {
      expect(_internal.formatMoney(100, '')).toBe('100.000');
    });
    test('returns em-dash on non-finite', () => {
      expect(_internal.formatMoney(NaN, 'JOD')).toBe('—');
      expect(_internal.formatMoney(undefined, 'JOD')).toBe('—');
    });
  });

  describe('formatDateLong', () => {
    test('renders as "D Month YYYY"', () => {
      expect(_internal.formatDateLong('2026-05-01')).toBe('1 May 2026');
      expect(_internal.formatDateLong('2026-12-31T00:00:00Z')).toBe('31 December 2026');
    });
    test('handles null + invalid', () => {
      expect(_internal.formatDateLong(null)).toBe('—');
      expect(_internal.formatDateLong('not-a-date')).toBe('—');
    });
  });

  describe('monthsBetween / nightsBetween', () => {
    test('3-month contract', () => {
      expect(_internal.monthsBetween('2026-05-01', '2026-08-01')).toBe(3);
      expect(_internal.nightsBetween('2026-05-01', '2026-08-01')).toBe(92);
    });
    test('invalid inputs → 0', () => {
      expect(_internal.monthsBetween('bad', '2026-05-01')).toBe(0);
      expect(_internal.nightsBetween(null, '2026-05-01')).toBe(0);
    });
  });
});

describe('utils/contractPdf — generateContractPdf', () => {
  const { generateContractPdf } = require('../utils/contractPdf');

  beforeEach(() => {
    mockCalls.length = 0;
    jest.clearAllMocks();
  });

  test('happy path returns { url, key, hash }', async () => {
    const out = await generateContractPdf(baseArgs());

    expect(out).toMatchObject({
      key: expect.stringMatching(/^contracts\/33\/AQB-CON-2026-0001_\d+\.pdf$/),
      url: expect.stringContaining('r2-mock.example.com'),
      hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  test('R2 key is tenant-scoped with contract number + timestamp', async () => {
    const out = await generateContractPdf(baseArgs());
    expect(out.key.startsWith('contracts/33/')).toBe(true);
    expect(out.key.includes('AQB-CON-2026-0001')).toBe(true);
  });

  test('rejects non-English language', async () => {
    await expect(generateContractPdf(baseArgs({ contract: baseArgs().contract }))).resolves.toBeDefined();
    await expect(generateContractPdf({ ...baseArgs(), language: 'ar' }))
      .rejects.toThrow(/language 'ar' not yet supported/);
  });

  test('renders DRAFT badge when status=draft', async () => {
    await generateContractPdf(baseArgs());
    const textCalls = mockCalls.filter((c) => c.method === 'text');
    const rendered = textCalls.map((c) => c.args[0]).join(' | ');
    expect(rendered).toContain('[DRAFT]');
  });

  test('renders PENDING SIGNATURE badge when status=pending_signature', async () => {
    const args = baseArgs();
    args.contract.status = 'pending_signature';
    await generateContractPdf(args);
    const textCalls = mockCalls.filter((c) => c.method === 'text');
    const rendered = textCalls.map((c) => c.args[0]).join(' | ');
    expect(rendered).toContain('[PENDING SIGNATURE]');
  });

  test('omits badge when status=signed', async () => {
    const args = baseArgs();
    args.contract.status = 'signed';
    await generateContractPdf(args);
    const textCalls = mockCalls.filter((c) => c.method === 'text');
    const rendered = textCalls.map((c) => c.args[0]).join(' | ');
    expect(rendered).not.toContain('[DRAFT]');
    expect(rendered).not.toContain('[PENDING SIGNATURE]');
  });

  test('includes contract number in rendered output', async () => {
    await generateContractPdf(baseArgs());
    const textCalls = mockCalls.filter((c) => c.method === 'text');
    const rendered = textCalls.map((c) => c.args[0]).join(' | ');
    expect(rendered).toContain('AQB-CON-2026-0001');
  });

  test('includes tenant name, customer name, resource name', async () => {
    await generateContractPdf(baseArgs());
    const rendered = mockCalls.filter((c) => c.method === 'text')
      .map((c) => c.args[0]).join(' | ');
    expect(rendered).toContain('Aqaba Book');
    expect(rendered).toContain('John Doe');
    expect(rendered).toContain('Marina Suite 301');
  });

  test('renders each milestone row in the payment schedule table', async () => {
    await generateContractPdf(baseArgs());
    const rendered = mockCalls.filter((c) => c.method === 'text')
      .map((c) => c.args[0]).join(' | ');
    expect(rendered).toContain('Deposit');
    expect(rendered).toContain('Month 1');
    expect(rendered).toContain('Month 2');
    expect(rendered).toContain('Month 3');
  });

  test('renders VAT treatment line when vat_rate > 0', async () => {
    await generateContractPdf(baseArgs());
    const rendered = mockCalls.filter((c) => c.method === 'text')
      .map((c) => c.args[0]).join(' | ');
    expect(rendered).toMatch(/16%.*VAT/);
    expect(rendered).toContain('applied on top of');
  });

  test('renders "included in" when tax_inclusive=true (Birdie style)', async () => {
    const args = baseArgs();
    args.taxConfig = { vat_rate: 16, vat_label: 'VAT', tax_inclusive: true };
    await generateContractPdf(args);
    const rendered = mockCalls.filter((c) => c.method === 'text')
      .map((c) => c.args[0]).join(' | ');
    expect(rendered).toContain('included in');
  });

  test('omits VAT line when vat_rate = 0', async () => {
    const args = baseArgs();
    args.taxConfig = { vat_rate: 0, tax_inclusive: false };
    await generateContractPdf(args);
    const rendered = mockCalls.filter((c) => c.method === 'text')
      .map((c) => c.args[0]).join(' | ');
    expect(rendered).not.toMatch(/VAT/);
  });

  test('renders terms text when provided', async () => {
    const args = baseArgs();
    args.contract.terms = 'Tenant responsible for utilities.';
    await generateContractPdf(args);
    const rendered = mockCalls.filter((c) => c.method === 'text')
      .map((c) => c.args[0]).join(' | ');
    expect(rendered).toContain('Tenant responsible for utilities.');
  });

  test('renders "No additional terms specified." fallback when terms empty', async () => {
    await generateContractPdf(baseArgs());
    const rendered = mockCalls.filter((c) => c.method === 'text')
      .map((c) => c.args[0]).join(' | ');
    expect(rendered).toContain('No additional terms specified.');
  });

  test('gracefully handles missing customer phone/email', async () => {
    const args = baseArgs();
    args.customer = { id: 99, name: 'John Doe' };
    const out = await generateContractPdf(args);
    expect(out.key).toContain('AQB-CON-2026-0001');
  });

  test('gracefully handles missing property_details_json', async () => {
    const args = baseArgs();
    delete args.resource.property_details_json;
    const out = await generateContractPdf(args);
    expect(out.key).toContain('AQB-CON-2026-0001');
  });

  test('handles property_details_json as string (JSON)', async () => {
    const args = baseArgs();
    args.resource.property_details_json = JSON.stringify({ bedrooms: 3, view: 'city view' });
    await generateContractPdf(args);
    const rendered = mockCalls.filter((c) => c.method === 'text')
      .map((c) => c.args[0]).join(' | ');
    expect(rendered).toContain('3 bedrooms');
    expect(rendered).toContain('city view');
  });

  test('handles empty invoices array with fallback message', async () => {
    const args = baseArgs();
    args.invoices = [];
    await generateContractPdf(args);
    const rendered = mockCalls.filter((c) => c.method === 'text')
      .map((c) => c.args[0]).join(' | ');
    expect(rendered).toContain('No payment schedule has been defined');
  });

  test('throws if contract missing', async () => {
    await expect(generateContractPdf({ tenant: {}, customer: {}, resource: {} }))
      .rejects.toThrow(/contract, tenant, customer, resource required/);
  });

  test('Auto-release shows "Yes" when true', async () => {
    const args = baseArgs();
    args.contract.auto_release_on_expiry = true;
    await generateContractPdf(args);
    const rendered = mockCalls.filter((c) => c.method === 'text')
      .map((c) => c.args[0]).join(' | ');
    // Find the Auto-release row value
    const ix = rendered.indexOf('Auto-release on expiry');
    expect(ix).toBeGreaterThan(-1);
    // "Yes" should appear somewhere after it
    expect(rendered.slice(ix)).toContain('Yes');
  });
});
