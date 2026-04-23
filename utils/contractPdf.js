'use strict';

// utils/contractPdf.js
// G2a-2: Generate an unsigned contract PDF using pdfkit, upload to R2.
//
// Language: English only in this version. The generateContractPdf()
// function accepts a `language` option defaulting to 'en'; a future Arabic
// (or bilingual) implementation can branch on this value without changing
// callers. Until then, passing anything other than 'en' throws.
//
// Usage:
//   const { generateContractPdf } = require('./utils/contractPdf');
//   const { url, key, hash } = await generateContractPdf({
//     contract, tenant, customer, resource, taxConfig, invoices
//   });

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { uploadFileToR2 } = require('./r2');
const logger = require('./logger');

// ---------------------------------------------------------------------------
// Layout constants (A4 with 50pt margins)
// ---------------------------------------------------------------------------

const PAGE_MARGIN = 50;
const PAGE_WIDTH  = 595.28;  // A4 width in pt
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;  // 495.28pt
const LABEL_COL_WIDTH = 110;
const VALUE_COL_START = PAGE_MARGIN + LABEL_COL_WIDTH;
const VALUE_COL_WIDTH = CONTENT_WIDTH - LABEL_COL_WIDTH;

const COLORS = {
  text: '#111827',
  mute: '#6b7280',
  rule: '#e5e7eb',
  tableHead: '#f3f4f6',
  draft: '#dc2626',
};

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

const MONTHS_EN = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function formatDateLong(v) {
  if (!v) return '—';
  const d = (v instanceof Date) ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getUTCDate()} ${MONTHS_EN[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function formatDateShort(v) {
  if (!v) return '—';
  const d = (v instanceof Date) ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  const mon = MONTHS_EN[d.getUTCMonth()].slice(0, 3);
  return `${d.getUTCDate()} ${mon} ${d.getUTCFullYear()}`;
}

function formatMoney(amount, currencyCode) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '—';
  const parts = n.toFixed(3).split('.');
  const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${currencyCode || ''} ${intPart}.${parts[1]}`.trim();
}

function monthsBetween(start, end) {
  if (start == null || end == null || start === '' || end === '') return 0;
  const s = new Date(start);
  const e = new Date(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return 0;
  const years = e.getUTCFullYear() - s.getUTCFullYear();
  const months = e.getUTCMonth() - s.getUTCMonth();
  return years * 12 + months;
}

function nightsBetween(start, end) {
  if (start == null || end == null || start === '' || end === '') return 0;
  const s = new Date(start);
  const e = new Date(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return 0;
  return Math.round((e.getTime() - s.getTime()) / 86400000);
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

function statusBadgeText(status) {
  if (status === 'draft') return 'DRAFT';
  if (status === 'pending_signature') return 'PENDING SIGNATURE';
  return null; // no badge for signed / active / terminal states
}

// ---------------------------------------------------------------------------
// pdfkit helpers
// ---------------------------------------------------------------------------

function rule(doc, y) {
  doc.strokeColor(COLORS.rule).lineWidth(0.5)
     .moveTo(PAGE_MARGIN, y).lineTo(PAGE_MARGIN + CONTENT_WIDTH, y).stroke();
  doc.fillColor(COLORS.text);
}

function sectionHeader(doc, text) {
  doc.moveDown(0.8);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(COLORS.text).text(text.toUpperCase(), PAGE_MARGIN);
  doc.moveDown(0.3);
}

function kv(doc, label, value) {
  const y = doc.y;
  doc.font('Helvetica').fontSize(10).fillColor(COLORS.mute)
     .text(label, PAGE_MARGIN, y, { width: LABEL_COL_WIDTH });
  doc.font('Helvetica').fontSize(10).fillColor(COLORS.text)
     .text(value || '—', VALUE_COL_START, y, { width: VALUE_COL_WIDTH });
  doc.moveDown(0.15);
}

function ensureRoomOrPageBreak(doc, needed) {
  const bottomLimit = doc.page.height - PAGE_MARGIN;
  if (doc.y + needed > bottomLimit) {
    doc.addPage();
  }
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {object} opts.contract     — row from contracts
 * @param {object} opts.tenant       — row from tenants (needs slug, name, address_*, tax_config)
 * @param {object} opts.customer     — row from customers
 * @param {object} opts.resource     — row from resources
 * @param {object} opts.taxConfig    — resolved tax config from utils/taxEngine
 * @param {Array}  opts.invoices     — exploded payment schedule (from contracts.payment_schedule_snapshot)
 * @param {string} [opts.language]   — 'en' (default). Other values throw until bilingual is implemented.
 * @returns {Promise<{url, key, hash}>}
 */
async function generateContractPdf(opts) {
  const {
    contract, tenant, customer, resource, taxConfig, invoices,
    language = 'en',
  } = opts || {};

  if (language !== 'en') {
    throw new Error(`generateContractPdf: language '${language}' not yet supported (only 'en')`);
  }
  if (!contract || !tenant || !customer || !resource) {
    throw new Error('generateContractPdf: contract, tenant, customer, resource required');
  }

  // Require pdfkit lazily so CI without the package still boots (same pattern as stripe)
  let PDFDocument;
  try {
    PDFDocument = require('pdfkit');
  } catch {
    throw new Error('pdfkit is not installed. Run: npm install pdfkit');
  }

  // Prepare temp file
  const tmpName = `contract-${contract.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pdf`;
  const tmpPath = path.join(os.tmpdir(), tmpName);

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: PAGE_MARGIN, bottom: PAGE_MARGIN, left: PAGE_MARGIN, right: PAGE_MARGIN },
    info: {
      Title: `Contract ${contract.contract_number}`,
      Author: tenant.name || 'Flexrz',
      Subject: 'Rental Contract',
      Creator: 'Flexrz',
      Producer: 'Flexrz PDF Generator',
      CreationDate: new Date(),
    },
  });

  const stream = fs.createWriteStream(tmpPath);
  doc.pipe(stream);

  // ─── Header strip ─────────────────────────────────────────────────────────
  const headerTop = PAGE_MARGIN;
  doc.font('Helvetica-Bold').fontSize(14).fillColor(COLORS.text)
     .text(tenant.name || '', PAGE_MARGIN, headerTop, { align: 'right', width: CONTENT_WIDTH });
  if (tenant.address_line1 || tenant.city) {
    const addrLine = [tenant.address_line1, tenant.city, tenant.country_code].filter(Boolean).join(', ');
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.mute)
       .text(addrLine, PAGE_MARGIN, doc.y, { align: 'right', width: CONTENT_WIDTH });
  }

  doc.moveDown(1.5);
  rule(doc, doc.y);

  // ─── Title ────────────────────────────────────────────────────────────────
  doc.moveDown(1);
  doc.font('Helvetica-Bold').fontSize(22).fillColor(COLORS.text)
     .text('RENTAL CONTRACT', PAGE_MARGIN, doc.y, { align: 'center', width: CONTENT_WIDTH });

  doc.moveDown(0.8);

  // ─── Contract meta (number + issue date + draft badge) ────────────────────
  const metaY = doc.y;
  doc.font('Helvetica').fontSize(10).fillColor(COLORS.mute)
     .text('Contract No.', PAGE_MARGIN, metaY, { width: LABEL_COL_WIDTH, continued: false });
  doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.text)
     .text(contract.contract_number || '—', VALUE_COL_START, metaY);

  const issueY = doc.y;
  doc.font('Helvetica').fontSize(10).fillColor(COLORS.mute)
     .text('Issue Date', PAGE_MARGIN, issueY, { width: LABEL_COL_WIDTH });
  doc.font('Helvetica').fontSize(10).fillColor(COLORS.text)
     .text(formatDateLong(contract.created_at || new Date()), VALUE_COL_START, issueY);

  const badge = statusBadgeText(contract.status);
  if (badge) {
    doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.draft)
       .text(`[${badge}]`, PAGE_MARGIN, metaY, { align: 'right', width: CONTENT_WIDTH });
    doc.fillColor(COLORS.text);
  }

  doc.moveDown(0.8);
  rule(doc, doc.y);

  // ─── Parties ──────────────────────────────────────────────────────────────
  sectionHeader(doc, 'Parties');

  doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.text)
     .text('Landlord', PAGE_MARGIN);
  doc.moveDown(0.2);
  kv(doc, 'Name', tenant.name);
  const tenantAddr = [tenant.address_line1, tenant.address_line2, tenant.city, tenant.country_code]
    .filter(Boolean).join(', ');
  if (tenantAddr) kv(doc, 'Address', tenantAddr);
  if (tenant.admin_email) kv(doc, 'Email', tenant.admin_email);

  doc.moveDown(0.4);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.text)
     .text('Tenant', PAGE_MARGIN);
  doc.moveDown(0.2);
  kv(doc, 'Name', customer.name);
  if (customer.phone) kv(doc, 'Phone', customer.phone);
  if (customer.email) kv(doc, 'Email', customer.email);

  doc.moveDown(0.4);
  rule(doc, doc.y);

  // ─── Property ─────────────────────────────────────────────────────────────
  sectionHeader(doc, 'Property');
  kv(doc, 'Unit', resource.name);
  if (resource.building_name) kv(doc, 'Building', resource.building_name);
  if (resource.property_details_json) {
    const pd = typeof resource.property_details_json === 'object'
      ? resource.property_details_json
      : (() => { try { return JSON.parse(resource.property_details_json); } catch { return {}; } })();
    const bits = [];
    if (pd.bedrooms) bits.push(`${pd.bedrooms} bedroom${pd.bedrooms === 1 ? '' : 's'}`);
    if (pd.bathrooms) bits.push(`${pd.bathrooms} bathroom${pd.bathrooms === 1 ? '' : 's'}`);
    if (pd.view) bits.push(pd.view);
    if (pd.notes) bits.push(pd.notes);
    if (bits.length) kv(doc, 'Details', bits.join(', '));
  }

  doc.moveDown(0.4);
  rule(doc, doc.y);

  // ─── Term ─────────────────────────────────────────────────────────────────
  sectionHeader(doc, 'Term');
  kv(doc, 'Start Date', formatDateLong(contract.start_date));
  kv(doc, 'End Date',   formatDateLong(contract.end_date));
  const months = monthsBetween(contract.start_date, contract.end_date);
  const nights = nightsBetween(contract.start_date, contract.end_date);
  kv(doc, 'Duration', `${months} month${months === 1 ? '' : 's'} (${nights} night${nights === 1 ? '' : 's'})`);
  kv(doc, 'Auto-release on expiry', contract.auto_release_on_expiry ? 'Yes' : 'No');

  doc.moveDown(0.4);
  rule(doc, doc.y);

  // ─── Financial Terms ──────────────────────────────────────────────────────
  sectionHeader(doc, 'Financial Terms');
  const curr = contract.currency_code || 'JOD';
  kv(doc, 'Monthly Rent',          formatMoney(contract.monthly_rate, curr));
  kv(doc, 'Total Contract Value',  formatMoney(contract.total_value, curr));
  kv(doc, 'Security Deposit',      `${formatMoney(contract.security_deposit, curr)} (refundable)`);

  if (taxConfig && taxConfig.vat_rate > 0) {
    const treatment = taxConfig.tax_inclusive
      ? `${taxConfig.vat_rate}% ${taxConfig.vat_label || 'VAT'} included in rates shown`
      : `${taxConfig.vat_rate}% ${taxConfig.vat_label || 'VAT'} applied on top of rates shown`;
    kv(doc, 'Tax Treatment', treatment);
  }

  doc.moveDown(0.4);
  rule(doc, doc.y);

  // ─── Payment Schedule Table ───────────────────────────────────────────────
  sectionHeader(doc, 'Payment Schedule');

  if (Array.isArray(invoices) && invoices.length > 0) {
    const tableTop = doc.y;
    const rowH = 22;
    const colNum  = PAGE_MARGIN;
    const colDesc = PAGE_MARGIN + 35;
    const colDate = PAGE_MARGIN + 250;
    const colAmt  = PAGE_MARGIN + CONTENT_WIDTH;  // right-aligned

    // Header row
    doc.rect(PAGE_MARGIN, tableTop, CONTENT_WIDTH, rowH)
       .fillAndStroke(COLORS.tableHead, COLORS.rule);
    doc.fillColor(COLORS.text).font('Helvetica-Bold').fontSize(10);
    doc.text('#',           colNum + 6,  tableTop + 6);
    doc.text('Description', colDesc,     tableTop + 6);
    doc.text('Due Date',    colDate,     tableTop + 6);
    doc.text('Amount',      PAGE_MARGIN, tableTop + 6, { align: 'right', width: CONTENT_WIDTH - 10 });

    // Data rows
    let y = tableTop + rowH;
    let totalAmount = 0;

    doc.font('Helvetica').fontSize(10).fillColor(COLORS.text);

    invoices.forEach((inv, idx) => {
      ensureRoomOrPageBreak(doc, rowH * 2);
      doc.text(String(idx + 1),             colNum + 6,  y + 6);
      doc.text(inv.label || inv.milestone_label || '—', colDesc, y + 6, { width: 200 });
      doc.text(formatDateShort(inv.due_date), colDate,    y + 6);
      doc.text(formatMoney(inv.amount, curr), PAGE_MARGIN, y + 6, { align: 'right', width: CONTENT_WIDTH - 10 });

      doc.strokeColor(COLORS.rule).lineWidth(0.3)
         .moveTo(PAGE_MARGIN, y + rowH).lineTo(PAGE_MARGIN + CONTENT_WIDTH, y + rowH).stroke();
      doc.strokeColor(COLORS.text);

      totalAmount += Number(inv.amount || 0);
      y += rowH;
    });

    // Totals row
    doc.rect(PAGE_MARGIN, y, CONTENT_WIDTH, rowH)
       .fillAndStroke(COLORS.tableHead, COLORS.rule);
    doc.fillColor(COLORS.text).font('Helvetica-Bold').fontSize(10);
    doc.text('Total', colDesc, y + 6);
    doc.text(formatMoney(totalAmount, curr),
             PAGE_MARGIN, y + 6, { align: 'right', width: CONTENT_WIDTH - 10 });

    doc.y = y + rowH + 10;
  } else {
    doc.font('Helvetica-Oblique').fontSize(10).fillColor(COLORS.mute)
       .text('No payment schedule has been defined for this contract.', PAGE_MARGIN);
  }

  rule(doc, doc.y + 4);

  // ─── Terms & Conditions ───────────────────────────────────────────────────
  sectionHeader(doc, 'Terms & Conditions');
  const termsText = (contract.terms && String(contract.terms).trim())
    ? String(contract.terms).trim()
    : 'No additional terms specified.';
  doc.font('Helvetica').fontSize(10).fillColor(COLORS.text)
     .text(termsText, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH, align: 'left' });

  doc.moveDown(0.5);
  rule(doc, doc.y);

  // ─── Signatures ───────────────────────────────────────────────────────────
  ensureRoomOrPageBreak(doc, 180);
  sectionHeader(doc, 'Signatures');
  doc.moveDown(0.4);

  const sigLeft  = PAGE_MARGIN;
  const sigRight = PAGE_MARGIN + CONTENT_WIDTH / 2 + 10;
  const colW     = CONTENT_WIDTH / 2 - 10;
  const sigTop   = doc.y;

  doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.text)
     .text('LANDLORD', sigLeft,  sigTop)
     .text('TENANT',   sigRight, sigTop);

  const lineY = sigTop + 48;
  doc.strokeColor(COLORS.text).lineWidth(0.5)
     .moveTo(sigLeft,  lineY).lineTo(sigLeft  + colW, lineY).stroke()
     .moveTo(sigRight, lineY).lineTo(sigRight + colW, lineY).stroke();

  doc.font('Helvetica').fontSize(9).fillColor(COLORS.mute)
     .text('Signature', sigLeft,  lineY + 4)
     .text('Signature', sigRight, lineY + 4);

  doc.font('Helvetica').fontSize(10).fillColor(COLORS.text)
     .text('Name:',          sigLeft,  lineY + 22)
     .text(`Name: ${customer.name || ''}`, sigRight, lineY + 22);

  doc.text('Date: _________',  sigLeft,  lineY + 40)
     .text('Date: _________',  sigRight, lineY + 40);

  // ─── Footer (on last page only; pdfkit doesn't easily do repeating footers
  //     without tricks, so we use a one-shot footer on the last page)
  const footerY = doc.page.height - PAGE_MARGIN - 15;
  doc.font('Helvetica').fontSize(8).fillColor(COLORS.mute);
  const genText = `Generated ${formatDateLong(new Date())} · ${contract.contract_number} · flexrz.com`;
  doc.text(genText, PAGE_MARGIN, footerY, { width: CONTENT_WIDTH, align: 'center' });

  // ─── Finalize ────────────────────────────────────────────────────────────
  doc.end();
  await new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  // Compute SHA-256 of the generated file
  const hash = await sha256File(tmpPath);

  // Upload to R2 under a tenant-scoped key
  const key = `contracts/${tenant.id}/${contract.contract_number}_${Date.now()}.pdf`;
  const { url } = await uploadFileToR2({ filePath: tmpPath, key, contentType: 'application/pdf' });
  // uploadFileToR2 deletes the temp file on success.

  logger.info({
    tenantId: tenant.id, contractId: contract.id, contractNumber: contract.contract_number,
    key, hashPrefix: hash.slice(0, 12),
  }, 'contract PDF generated');

  return { url, key, hash };
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

module.exports = {
  generateContractPdf,
  // exposed for tests
  _internal: { formatMoney, formatDateLong, formatDateShort, monthsBetween, nightsBetween },
};
