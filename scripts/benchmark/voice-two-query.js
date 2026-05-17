#!/usr/bin/env node
'use strict';

// scripts/benchmark/voice-two-query.js
//
// Phase 2.3 — real-Claude latency benchmark for the brain → persona pipeline.
// NOT part of Jest. Run manually before merging Phase 2.3, and again after
// any prompt-size or model change.
//
// Usage:
//   ANTHROPIC_API_KEY=sk-ant-... node scripts/benchmark/voice-two-query.js
//
// Output:
//   - console summary (P50 / P90 / P99 / pass-vs-2.0s-gate)
//   - markdown report at audit/<YYYY-MM-DD>/voice-two-query-latency.md
//
// What this measures:
//   - Brain call: real Anthropic API roundtrip with the 2.1 brain prompt
//   - Persona call: real Anthropic API roundtrip with the 2.2 persona prompt
//   - handleAction is SIMULATED (returns canned slots/booking result) so the
//     benchmark isolates Claude latency from DB/availabilityEngine latency
//
// What this does NOT measure:
//   - Real handleAction latency (DB queries, availabilityEngine fan-out) —
//     measure separately in production via APM if needed.
//   - First-turn cache-miss latency in pathological scenarios — this script
//     runs 20 sequential iterations so calls 2+ benefit from prompt cache.

const path = require('path');
const fs = require('fs');

// Sanity: API key required
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY env var is required.');
  console.error('Run: ANTHROPIC_API_KEY=sk-ant-... node scripts/benchmark/voice-two-query.js');
  process.exit(2);
}

const { runBookingBrain } = require('../../utils/bookingBrain');
const { speakReply } = require('../../utils/voicePersona');

// ── Tenant + customer fixtures (Birdie-shaped) ──────────────────────────
const TENANT = {
  id: 1,
  slug: 'birdie-golf',
  name: 'Birdie Golf',
  timezone: 'Asia/Amman',
  features: { voice_two_query: true },
  services: [
    {
      id: 16, name: 'Karaoke', duration_minutes: 120, slot_interval_minutes: 60,
      price: 17.5, currency_code: 'JD', allow_membership: false,
    },
    {
      id: 5, name: 'Group Lesson', duration_minutes: 60, slot_interval_minutes: 30,
      price: 25, currency_code: 'JD', allow_membership: true,
    },
    {
      id: 11, name: 'Sim Bay', duration_minutes: 60, slot_interval_minutes: 30,
      price: 35, currency_code: 'JD', allow_membership: true,
    },
  ],
  resourceLinks: [
    { service_id: 16, resource_id: 1, resource_name: 'Sim 1' },
    { service_id: 16, resource_id: 2, resource_name: 'Sim 2' },
    { service_id: 11, resource_id: 1, resource_name: 'Sim 1' },
    { service_id: 11, resource_id: 2, resource_name: 'Sim 2' },
  ],
  staffLinks: [],
};

const CUSTOMER = {
  profile: { id: 99, name: 'Test Customer', email: 'bench@example.com', phone: null },
  bookings: [],
  memberships: [],
  packages: [],
};

// ── Simulated handleAction (zero-latency, isolates Claude timing) ───────
async function simHandleAction(action) {
  if (action.type === 'check_availability') {
    return {
      success: true,
      structured: true,
      slots: [
        { time: '17:00', any_free: true, resources: [{ id: 1, name: 'Sim 1', free: true }] },
        { time: '18:00', any_free: true, resources: [{ id: 1, name: 'Sim 1', free: true }] },
        { time: '21:00', any_free: true, resources: [{ id: 1, name: 'Sim 1', free: true }] },
      ],
    };
  }
  if (action.type === 'create_booking') {
    return { success: true, bookingId: 9999, message: '✅ Booked!' };
  }
  if (action.type === 'cancel_booking') {
    return { success: true, message: '✅ Cancelled.' };
  }
  return null;
}

// ── Single iteration: brain → handleAction → persona ────────────────────
async function runOnePipeline({ message, history = [], confirmationMode = false, language = 'en', consumerType = 'voice' }) {
  const t0 = process.hrtime.bigint();

  const brainStart = process.hrtime.bigint();
  const brain = await runBookingBrain({
    tenantContext: TENANT, customerData: CUSTOMER, isSignedIn: true,
    history, message, confirmationMode,
  });
  const brainEnd = process.hrtime.bigint();

  let actionResult = null;
  if (brain.action) actionResult = await simHandleAction(brain.action);

  const personaStart = process.hrtime.bigint();
  await speakReply({
    tenantContext: TENANT, brainOutput: brain, actionResult, language, consumerType,
  });
  const personaEnd = process.hrtime.bigint();

  const t1 = process.hrtime.bigint();

  return {
    total_ms:   Number(t1 - t0) / 1e6,
    brain_ms:   Number(brainEnd - brainStart) / 1e6,
    persona_ms: Number(personaEnd - personaStart) / 1e6,
    intent:     brain.intent,
    hadAction:  brain.action != null,
  };
}

// ── 20-iteration mix (10 availability + 10 confirmation) ────────────────
const SCENARIOS = [
  ...Array(10).fill({ message: 'what is available tomorrow for Karaoke', history: [], confirmationMode: false }),
  ...Array(10).fill({
    message: 'yes',
    history: [
      { role: 'user', content: 'book sim 1 at 5pm cash' },
      { role: 'assistant', content: 'Sim 1 at 5pm for 2 hours, cash, seventeen and a half dinars — shall I confirm?' },
    ],
    confirmationMode: true,
  }),
];

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function formatMs(n) {
  return n.toFixed(1).padStart(7, ' ') + ' ms';
}

(async () => {
  console.log(`\n# Voice Two-Query Latency Benchmark — ${new Date().toISOString()}\n`);
  console.log('Tenant: Birdie Golf | Iterations: 20 (10 availability + 10 confirmation)');
  console.log('Brain: claude-sonnet-4-6 temp=0 max_tokens=400 + ephemeral cache');
  console.log('Persona: claude-sonnet-4-6 temp=0.3 max_tokens=200 + ephemeral cache');
  console.log('handleAction: SIMULATED (zero-latency canned response — isolates Claude timing)\n');

  const results = [];
  for (let i = 0; i < SCENARIOS.length; i++) {
    process.stdout.write(`  ${(i + 1).toString().padStart(2, ' ')}/${SCENARIOS.length} … `);
    try {
      const r = await runOnePipeline(SCENARIOS[i]);
      results.push(r);
      console.log(`total=${formatMs(r.total_ms)} brain=${formatMs(r.brain_ms)} persona=${formatMs(r.persona_ms)} intent=${r.intent}`);
    } catch (err) {
      console.log(`ERROR: ${err?.message || err}`);
      results.push({ total_ms: NaN, brain_ms: NaN, persona_ms: NaN, intent: 'error', hadAction: false, error: err?.message || String(err) });
    }
  }

  // ── Percentiles ──────────────────────────────────────────────────────
  const valid = results.filter((r) => Number.isFinite(r.total_ms));
  const totals = valid.map((r) => r.total_ms).sort((a, b) => a - b);
  const brains = valid.map((r) => r.brain_ms).sort((a, b) => a - b);
  const personas = valid.map((r) => r.persona_ms).sort((a, b) => a - b);

  const totalsP50 = percentile(totals, 0.50);
  const totalsP90 = percentile(totals, 0.90);
  const totalsP99 = percentile(totals, 0.99);
  const brainP50  = percentile(brains, 0.50);
  const brainP90  = percentile(brains, 0.90);
  const personaP50 = percentile(personas, 0.50);
  const personaP90 = percentile(personas, 0.90);

  const PASS_THRESHOLD_MS = 2000;
  const passed = totalsP90 < PASS_THRESHOLD_MS;

  console.log('\n── PERCENTILES ──────────────────────────────────────');
  console.log(`Total   P50: ${formatMs(totalsP50)}   P90: ${formatMs(totalsP90)}   P99: ${formatMs(totalsP99)}`);
  console.log(`Brain   P50: ${formatMs(brainP50)}   P90: ${formatMs(brainP90)}`);
  console.log(`Persona P50: ${formatMs(personaP50)}   P90: ${formatMs(personaP90)}`);
  console.log(`\nGate: P90 total < ${PASS_THRESHOLD_MS}ms`);
  console.log(`Result: ${passed ? '✅ PASS' : '❌ FAIL'} (P90=${totalsP90.toFixed(1)}ms)\n`);

  // ── Write markdown report ────────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  const reportDir = path.join(__dirname, '..', '..', 'audit', today);
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, 'voice-two-query-latency.md');

  const tableRows = results.map((r, i) => {
    const total = Number.isFinite(r.total_ms) ? r.total_ms.toFixed(1) : '—';
    const brain = Number.isFinite(r.brain_ms) ? r.brain_ms.toFixed(1) : '—';
    const persona = Number.isFinite(r.persona_ms) ? r.persona_ms.toFixed(1) : '—';
    return `| ${i + 1} | ${total} | ${brain} | ${persona} | ${r.intent} |`;
  }).join('\n');

  const report = `# Voice Two-Query Latency Benchmark

**Run at:** ${new Date().toISOString()}
**Tenant:** Birdie Golf
**Iterations:** ${SCENARIOS.length} (10 availability + 10 confirmation)
**Brain config:** \`claude-sonnet-4-6\` · temp 0 · max_tokens 400 · cache_control: ephemeral
**Persona config:** \`claude-sonnet-4-6\` · temp 0.3 · max_tokens 200 · cache_control: ephemeral
**handleAction:** SIMULATED (zero-latency canned response — isolates Claude latency from DB/availability-engine cost)

## Gate

P90 total < ${PASS_THRESHOLD_MS}ms → **${passed ? '✅ PASS' : '❌ FAIL'}** (measured P90 = **${totalsP90.toFixed(1)}ms**)

## Percentiles (ms)

| Stage   | P50 | P90 | P99 |
|---------|----:|----:|----:|
| Total   | ${totalsP50.toFixed(1)} | ${totalsP90.toFixed(1)} | ${totalsP99.toFixed(1)} |
| Brain   | ${brainP50.toFixed(1)} | ${brainP90.toFixed(1)} | ${percentile(brains, 0.99).toFixed(1)} |
| Persona | ${personaP50.toFixed(1)} | ${personaP90.toFixed(1)} | ${percentile(personas, 0.99).toFixed(1)} |

## Per-iteration timings (ms)

| # | total | brain | persona | intent |
|--:|------:|------:|--------:|--------|
${tableRows}

## Reproduction

\`\`\`bash
ANTHROPIC_API_KEY=sk-ant-... node scripts/benchmark/voice-two-query.js
\`\`\`

The benchmark uses canned tenant + customer fixtures defined inline in the script. handleAction is simulated; DB and availability-engine latency are NOT included.

## Notes

- Prompt cache warms up after iteration 1 (cache TTL is 5 min, well within the 20-iteration run window).
- If P90 exceeds the 2.0s gate, the first latency lever is to drop persona temperature from 0.3 to 0 (sacrifices natural variation for speed) and/or reduce persona max_tokens from 200 to 150.
- Phase 2.4 will re-run this benchmark with real production DB activity from Birdie before flipping the flag.
`;

  fs.writeFileSync(reportPath, report, 'utf8');
  console.log(`Report written: ${reportPath}\n`);

  process.exit(passed ? 0 : 1);
})().catch((err) => {
  console.error('Benchmark crashed:', err?.stack || err);
  process.exit(3);
});
