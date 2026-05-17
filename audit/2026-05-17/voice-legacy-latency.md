# Voice Legacy Single-Prompt Latency Benchmark

**Run at:** 2026-05-17T12:05:40.477Z
**Tenant:** Birdie Golf
**Iterations:** 20 (10 availability + 10 confirmation)
**Path:** legacy single-prompt `runSupportAgent` (no `features.voice_two_query` flag → legacy branch)
**Call shape:** initial → handleAction → conditional follow-up (skip on successful `create_booking`, mirroring `routes/ai.js:1240-1242`)
**Model:** `claude-sonnet-4-6` · legacy `buildSystemPrompt` system block with `cache_control: ephemeral`
**handleAction:** SIMULATED (zero-latency canned response — isolates Claude latency from DB/availability-engine cost)

## Percentiles (ms)

| Stage                     | P50 | P90 | P99 |
|---------------------------|----:|----:|----:|
| Total                     | 5294.1 | 11032.2 | 12251.2 |
| Call 1 (initial)          | 2091.6 | 3950.7 | 8139.9 |
| Call 2 (follow-up, 20/20)  | 3179.5 | 5142.6 | 9786.4 |

## Per-iteration timings (ms)

| # | total | call1 | call2 | action |
|--:|------:|------:|------:|--------|
| 1 | 11032.2 | 8139.9 | 2892.1 | check_availability |
| 2 | 5247.2 | 2067.5 | 3179.5 | check_availability |
| 3 | 4998.5 | 2091.6 | 2906.9 | check_availability |
| 4 | 5174.7 | 2343.2 | 2831.5 | check_availability |
| 5 | 4610.7 | 1744.7 | 2866.0 | check_availability |
| 6 | 4728.9 | 1913.3 | 2815.6 | check_availability |
| 7 | 4697.7 | 2093.8 | 2603.8 | check_availability |
| 8 | 4653.4 | 1791.7 | 2861.6 | check_availability |
| 9 | 12251.2 | 2464.7 | 9786.4 | check_availability |
| 10 | 4867.4 | 2028.5 | 2838.9 | check_availability |
| 11 | 5080.0 | 2024.8 | 3055.2 | check_availability |
| 12 | 6889.2 | 2164.2 | 4724.8 | check_availability |
| 13 | 5773.4 | 2057.0 | 3716.3 | check_availability |
| 14 | 5423.7 | 2034.3 | 3389.4 | check_availability |
| 15 | 5409.9 | 2323.8 | 3086.1 | check_availability |
| 16 | 7608.0 | 2465.4 | 5142.6 | check_availability |
| 17 | 7364.5 | 3950.7 | 3413.8 | check_availability |
| 18 | 5294.1 | 2062.1 | 3232.1 | check_availability |
| 19 | 6733.1 | 2442.6 | 4290.5 | check_availability |
| 20 | 5227.8 | 2037.5 | 3190.3 | check_availability |

## Reproduction

```bash
ANTHROPIC_API_KEY=sk-ant-... node scripts/benchmark/voice-legacy.js
```

Uses the same Birdie fixture as `voice-two-query.js`. `handleAction` is simulated; DB and availability-engine latency are NOT included. Confirmation iterations skip the follow-up Claude call when the booking succeeds — same as production behavior.

## Comparison to two-query benchmark

To judge whether 2.3's brain+persona architecture is meaningfully slower than today's legacy path, compare this report's percentiles against `audit/2026-05-17/voice-two-query-latency.md`.

- If legacy P90 is **comparable** (within ~20-30%) → two-query is acceptable; the bug-elimination payoff justifies a similar latency profile.
- If legacy P90 is **significantly faster** (e.g., 2× faster) → two-query needs structural tuning (bulk prompts above 1024 tokens, switch persona to Haiku, etc.) before Phase 2.4 can flip the flag.

## Notes

- Legacy's system prompt is the full mixed brain+persona `buildSystemPrompt` output, which is much larger than 2.1/2.2's split prompts. **It should comfortably exceed Anthropic's 1024-token cache threshold**, meaning `cache_control: ephemeral` actually engages — unlike the two-query pipeline where the smaller split prompts fall below threshold.
- Confirmation iterations typically make 1 Claude call (initial only). Availability iterations make 2 (initial + follow-up). The `Call 2` percentile only includes iterations that actually made the second call.
