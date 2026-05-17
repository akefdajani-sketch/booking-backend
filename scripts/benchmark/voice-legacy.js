#!/usr/bin/env node
'use strict';

// scripts/benchmark/voice-legacy.js
//
// Phase 2.4 — real-Claude latency benchmark for the LEGACY single-prompt
// runSupportAgent path. Sibling to scripts/benchmark/voice-two-query.js.
//
// Purpose: establish the legacy baseline so we can judge whether the
// two-query path's 4-5s P90 is an outlier or in line with current
// production behavior. Without this, we have no real "before" number.
//
// Usage:
//   ANTHROPIC_API_KEY=sk-ant-... node scripts/benchmark/voice-legacy.js
//
// Output:
//   - console summary
//   - markdown report at audit/<YYYY-MM-DD>/voice-legacy-latency.md
//
// WHAT THIS MEASURES:
//   The legacy production path (utils/claudeService.js runSupportAgent's
//   single-prompt branch — NOT the two-query orchestrator):
//     turn 1: runSupportAgent → ACTION line + reply
//     handleAction (SIMULATED — zero-latency canned response)
//     turn 2 (conditional): runSupportAgent follow-up with structured
//             action result injected as a synthetic [SYSTEM: ...] user
//             turn. Matches the production pattern in routes/ai.js
//             L1218-1231.
//     For successful create_booking the follow-up is SKIPPED in
//     production (routes/ai.js:1240-1242 — uses actionResult.message
//     directly). This benchmark mirrors that behavior; confirmation
//     iterations typically end up with 1 Claude call, availability
//     iterations with 2.
//
// WHAT THIS DOES NOT MEASURE:
//   - Real handleAction latency (DB queries, availabilityEngine fan-out)
//   - Brain/persona pipeline (use voice-two-query.js for that)
//   - First-turn cache-miss in pathological scenarios (20 sequential
//     iterations warm the cache for calls 2+)

const path = require('path');
const fs = require('fs');

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY env var is required.');
  console.error('Run: ANTHROPIC_API_KEY=sk-ant-... node scripts/benchmark/voice-legacy.js');
  process.exit(2);
}

const { runSupportAgent } = require('../../utils/claudeService');

// ── Tenant + customer fixtures (Birdie-shaped, NO features flag) ────────
// IMPORTANT: do NOT set features.voice_two_query — we want the legacy path.
const TENANT = {
  id: 1,
  slug: 'birdie-golf',
  name: 'Birdie Golf',
  timezone: 'Asia/Amman',
  // features deliberately omitted — legacy single-prompt path runs
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
  // The following fields are pulled from the legacy buildSystemPrompt path;
  // empty arrays keep the prompt building paths quiet without prompting
  // any "looks broken" warnings.
  memberships: [],
  rates: [],
  workingHours: [],
  resources: [
    { id: 1, name: 'Sim 1' },
    { id: 2, name: 'Sim 2' },
  ],
  staff: [],
  categories: [],
  prepaidProducts: [],
  serviceHours: [],
};

const CUSTOMER = {
  profile: { id: 99, name: 'Test Customer', email: 'bench@example.com', phone: null },
  bookings: [],
  memberships: [],
  packages: [],
};

// ── Simulated handleAction (zero-latency canned response) ───────────────
function simHandleAction(action) {
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

// ── actionContext builder — mirrors routes/ai.js L1171-1216 verbatim ────
function buildActionContextString(action, actionResult) {
  if (action.type === 'check_availability') {
    if (actionResult.success && Array.isArray(actionResult.slots) && actionResult.slots.length > 0) {
      if (actionResult.structured) {
        const lines = actionResult.slots.map((s) => {
          const parts = [];
          if (s.resources && s.resources.length > 0) {
            const resStr = s.resources.map((r) => {
              if (r.free) return `${r.name} FREE`;
              if (r.ownership === 'YOUR')  return `${r.name} BOOKED (YOUR existing booking)`;
              if (r.ownership === 'OTHER') return `${r.name} BOOKED (other customer)`;
              return `${r.name} BUSY`;
            }).join(', ');
            parts.push(resStr);
          }
          return `  - ${s.time}: ${parts.join(' | ')}`;
        }).join('\n');
        return `AVAILABILITY RESULT for ${action.date} (${actionResult.slots.length} slot times):\n${lines}\n\nWhen relaying to the customer: name the specific free resources, flag any of YOUR existing bookings, and never claim "all sims free" without naming them.`;
      }
      const slotTimes = actionResult.slots.map((s) => s.time || s.label).filter(Boolean).slice(0, 15).join(', ');
      return `AVAILABILITY RESULT: Found ${actionResult.slots.length} available slots on ${action.date}: ${slotTimes}.`;
    }
    if (actionResult.success) {
      return `AVAILABILITY RESULT: ${actionResult.message || `No available slots on ${action.date}.`}`;
    }
    return `AVAILABILITY RESULT: Failed — ${actionResult.message}`;
  }
  if (action.type === 'create_booking') {
    return actionResult.success
      ? `BOOKING RESULT: ${actionResult.message}`
      : `BOOKING RESULT: Failed — ${actionResult.message}`;
  }
  if (action.type === 'cancel_booking') {
    return actionResult.success
      ? `CANCELLATION RESULT: ${actionResult.message}`
      : `CANCELLATION RESULT: Failed — ${actionResult.message}`;
  }
  return '';
}

// ── Single iteration: legacy call 1 → handleAction → conditional call 2
async function runOneLegacyPipeline({ message, history = [], confirmationMode = false }) {
  const t0 = process.hrtime.bigint();

  // ── Call 1 (initial) ──────────────────────────────────────────────
  const c1Start = process.hrtime.bigint();
  const initial = await runSupportAgent({
    tenantContext: TENANT, customerData: CUSTOMER, isSignedIn: true,
    history, message, confirmationMode,
  });
  const c1End = process.hrtime.bigint();
  const call1Ms = Number(c1End - c1Start) / 1e6;

  // ── handleAction (simulated, no latency) ──────────────────────────
  let actionResult = null;
  if (initial.action) actionResult = simHandleAction(initial.action);

  // ── Call 2 (conditional follow-up) ────────────────────────────────
  // Mirror routes/ai.js L1218-1245:
  //   - run follow-up for check_availability + cancel_booking
  //   - SKIP follow-up for successful create_booking (uses actionResult.message)
  let call2Ms = 0;
  let didCall2 = false;
  const skipFollowUp =
    initial.action?.type === 'create_booking' && actionResult?.success === true;

  if (initial.action && actionResult && !skipFollowUp) {
    const actionContext = buildActionContextString(initial.action, actionResult);
    if (actionContext) {
      const c2Start = process.hrtime.bigint();
      await runSupportAgent({
        tenantContext: TENANT, customerData: CUSTOMER, isSignedIn: true,
        history: [
          ...history,
          { role: 'user', content: message },
          ...(initial.reply ? [{ role: 'assistant', content: initial.reply }] : []),
          { role: 'user', content: `[SYSTEM: ${actionContext}]` },
        ],
        message: actionContext,
      });
      const c2End = process.hrtime.bigint();
      call2Ms = Number(c2End - c2Start) / 1e6;
      didCall2 = true;
    }
  }

  const t1 = process.hrtime.bigint();

  return {
    total_ms:   Number(t1 - t0) / 1e6,
    call1_ms:   call1Ms,
    call2_ms:   call2Ms,
    didCall2,
    actionType: initial.action?.type || 'no_action',
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
  if (!Number.isFinite(n)) return '       —';
  return n.toFixed(1).padStart(7, ' ') + ' ms';
}

(async () => {
  console.log(`\n# Voice Legacy Single-Prompt Latency Benchmark — ${new Date().toISOString()}\n`);
  console.log('Tenant: Birdie Golf | Iterations: 20 (10 availability + 10 confirmation)');
  console.log('Path: legacy single-prompt runSupportAgent (features.voice_two_query NOT set)');
  console.log('Call shape: initial → handleAction → conditional follow-up (skip on create_booking success)');
  console.log('Model: claude-sonnet-4-6 (legacy buildSystemPrompt has cache_control ephemeral)');
  console.log('handleAction: SIMULATED (zero-latency canned response — isolates Claude latency)\n');

  const results = [];
  for (let i = 0; i < SCENARIOS.length; i++) {
    process.stdout.write(`  ${(i + 1).toString().padStart(2, ' ')}/${SCENARIOS.length} … `);
    try {
      const r = await runOneLegacyPipeline(SCENARIOS[i]);
      results.push(r);
      const c2 = r.didCall2 ? formatMs(r.call2_ms) : '   (skipped)';
      console.log(`total=${formatMs(r.total_ms)} call1=${formatMs(r.call1_ms)} call2=${c2} action=${r.actionType}`);
    } catch (err) {
      console.log(`ERROR: ${err?.message || err}`);
      results.push({ total_ms: NaN, call1_ms: NaN, call2_ms: NaN, didCall2: false, actionType: 'error', error: err?.message || String(err) });
    }
  }

  // ── Percentiles ──────────────────────────────────────────────────────
  const valid = results.filter((r) => Number.isFinite(r.total_ms));
  const totals  = valid.map((r) => r.total_ms).sort((a, b) => a - b);
  const call1s  = valid.map((r) => r.call1_ms).sort((a, b) => a - b);
  // call2 percentiles only over iterations that DID a 2nd call (otherwise it's misleading)
  const call2s = valid.filter((r) => r.didCall2).map((r) => r.call2_ms).sort((a, b) => a - b);

  const totalsP50 = percentile(totals, 0.50);
  const totalsP90 = percentile(totals, 0.90);
  const totalsP99 = percentile(totals, 0.99);
  const call1P50  = percentile(call1s, 0.50);
  const call1P90  = percentile(call1s, 0.90);
  const call2P50  = percentile(call2s, 0.50);
  const call2P90  = percentile(call2s, 0.90);

  const callTwoCount = valid.filter((r) => r.didCall2).length;

  console.log('\n── PERCENTILES ──────────────────────────────────────');
  console.log(`Total              P50: ${formatMs(totalsP50)}   P90: ${formatMs(totalsP90)}   P99: ${formatMs(totalsP99)}`);
  console.log(`Call 1 (initial)   P50: ${formatMs(call1P50)}   P90: ${formatMs(call1P90)}`);
  console.log(`Call 2 (follow-up) P50: ${formatMs(call2P50)}   P90: ${formatMs(call2P90)}   (${callTwoCount}/${valid.length} iterations made a 2nd call)`);
  console.log();

  // ── Write markdown report ────────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  const reportDir = path.join(__dirname, '..', '..', 'audit', today);
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, 'voice-legacy-latency.md');

  const tableRows = results.map((r, i) => {
    const total = Number.isFinite(r.total_ms) ? r.total_ms.toFixed(1) : '—';
    const c1 = Number.isFinite(r.call1_ms) ? r.call1_ms.toFixed(1) : '—';
    const c2 = r.didCall2 ? r.call2_ms.toFixed(1) : '(skipped)';
    return `| ${i + 1} | ${total} | ${c1} | ${c2} | ${r.actionType} |`;
  }).join('\n');

  const report = `# Voice Legacy Single-Prompt Latency Benchmark

**Run at:** ${new Date().toISOString()}
**Tenant:** Birdie Golf
**Iterations:** ${SCENARIOS.length} (10 availability + 10 confirmation)
**Path:** legacy single-prompt \`runSupportAgent\` (no \`features.voice_two_query\` flag → legacy branch)
**Call shape:** initial → handleAction → conditional follow-up (skip on successful \`create_booking\`, mirroring \`routes/ai.js:1240-1242\`)
**Model:** \`claude-sonnet-4-6\` · legacy \`buildSystemPrompt\` system block with \`cache_control: ephemeral\`
**handleAction:** SIMULATED (zero-latency canned response — isolates Claude latency from DB/availability-engine cost)

## Percentiles (ms)

| Stage                     | P50 | P90 | P99 |
|---------------------------|----:|----:|----:|
| Total                     | ${totalsP50.toFixed(1)} | ${totalsP90.toFixed(1)} | ${totalsP99.toFixed(1)} |
| Call 1 (initial)          | ${call1P50.toFixed(1)} | ${call1P90.toFixed(1)} | ${percentile(call1s, 0.99).toFixed(1)} |
| Call 2 (follow-up, ${callTwoCount}/${valid.length})  | ${call2P50.toFixed(1)} | ${call2P90.toFixed(1)} | ${percentile(call2s, 0.99).toFixed(1)} |

## Per-iteration timings (ms)

| # | total | call1 | call2 | action |
|--:|------:|------:|------:|--------|
${tableRows}

## Reproduction

\`\`\`bash
ANTHROPIC_API_KEY=sk-ant-... node scripts/benchmark/voice-legacy.js
\`\`\`

Uses the same Birdie fixture as \`voice-two-query.js\`. \`handleAction\` is simulated; DB and availability-engine latency are NOT included. Confirmation iterations skip the follow-up Claude call when the booking succeeds — same as production behavior.

## Comparison to two-query benchmark

To judge whether 2.3's brain+persona architecture is meaningfully slower than today's legacy path, compare this report's percentiles against \`audit/${today}/voice-two-query-latency.md\`.

- If legacy P90 is **comparable** (within ~20-30%) → two-query is acceptable; the bug-elimination payoff justifies a similar latency profile.
- If legacy P90 is **significantly faster** (e.g., 2× faster) → two-query needs structural tuning (bulk prompts above 1024 tokens, switch persona to Haiku, etc.) before Phase 2.4 can flip the flag.

## Notes

- Legacy's system prompt is the full mixed brain+persona \`buildSystemPrompt\` output, which is much larger than 2.1/2.2's split prompts. **It should comfortably exceed Anthropic's 1024-token cache threshold**, meaning \`cache_control: ephemeral\` actually engages — unlike the two-query pipeline where the smaller split prompts fall below threshold.
- Confirmation iterations typically make 1 Claude call (initial only). Availability iterations make 2 (initial + follow-up). The \`Call 2\` percentile only includes iterations that actually made the second call.
`;

  fs.writeFileSync(reportPath, report, 'utf8');
  console.log(`Report written: ${reportPath}\n`);

  process.exit(0);
})().catch((err) => {
  console.error('Benchmark crashed:', err?.stack || err);
  process.exit(3);
});
