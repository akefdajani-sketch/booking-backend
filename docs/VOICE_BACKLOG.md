\# Voice Agent Backlog



\*\*Last updated:\*\* 2026-05-11

\*\*Baseline:\*\* OPTION-A-FINAL (utils/claudeService.js \~834 lines after Bug B fix)

\*\*Source of truth audit:\*\* docs/AUDIT\_2026-05-11.md



This is the canonical list of outstanding voice agent work. Prioritized.

Smoke-test in production with real Birdie Golf voice traffic between changes.



\---



\## ✅ Shipped (2026-05-11)



\- \*\*Voice Bug B (over-booking)\*\* — CONFLICT CHECK rule added to RULES

&#x20; block in utils/claudeService.js after the AVAILABILITY rule. 6 lines.

&#x20; Instructs agent to scan CUSTOMER ACCOUNT / UPCOMING BOOKINGS for

&#x20; time-range overlaps before proposing/confirming.



\---



\## 🟡 P1 — Voice Bug A: availability overflow past closing hours



\*\*Symptom:\*\* Agent offered a 4-hour karaoke slot at 10pm when business

closes at midnight (would extend to 2am).



\*\*Diagnosis (from docs/AUDIT\_2026-05-11.md):\*\*

> Engine is correct. closeBufferMin = max(stepMin, durationMin) at

> availabilityEngine.js line 150 properly enforces close-buffer. Bug

> is in the prompt: LATEST START is computed against the smallest

> bookable duration only (claudeService.js line 77). Agent reads

> "22:00 latest start" + "4hr available" as independently true.

> The "exception" carve-out at lines 542-544 also encourages skipping

> check\_availability when the time is "inside" the operating window.



\*\*Fix surfaces:\*\*

\- (A) Recompute LATEST START at claudeService.js:77 to factor in the

&#x20; actual proposed service duration, not the smallest bookable duration.

\- (B) Add a prompt rule explicitly forbidding bookings whose

&#x20; `start + duration > closing time`. Even when LATEST START is wrong,

&#x20; the rule provides a second check.



\*\*Recommended approach:\*\* Both. (A) fixes the data the agent sees;

(B) adds belt-and-suspenders. Net: \~20 minutes prompt-only changes.



\*\*Risk:\*\* Low. Prompt-only. Variable-duration services only affected.



\*\*Test:\*\* Ask agent for a 4-hour karaoke booking starting after 8pm

on a day with midnight closing. Should refuse + offer earlier time.



\---



\## 🟡 P1 — Voice Bug D (prompt diet portion only)



\*\*Symptom:\*\* Agent inconsistency turn-to-turn. Sometimes calls

check\_availability, sometimes doesn't. Sometimes proactive, sometimes

not.



\*\*Diagnosis (from docs/AUDIT\_2026-05-11.md):\*\*

> RULES block is \~127 lines (claudeService.js lines 528-655) with \~17

> rules. Specific issues:

> - Duplicated availability rule: lines 529 ("MUST emit

>   ACTION:check\_availability AND STOP your turn") and 606 ("Always

>   call check\_availability before confirming any slot")

> - "MUST/STOP" vs "MAY" strength mixed across rules

> - "TWO LINES, TWO TURNS" at line 622 contradicts confirmation-mode

>   injection at lines 685-693

> - No tool\_choice configured — actions regex-parsed from text



\*\*Fix surfaces (prompt-only portion):\*\*

\- Collapse the duplicated availability rule into ONE rule

\- Resolve TWO-LINES contradiction: pick either "two turns always" OR

&#x20; "single turn during confirmation" and remove the conflicting

&#x20; language

\- Promote weak "MAY"s to "MUST" or remove them where the looseness

&#x20; isn't intentional

\- Cap RULES at \~50 lines total



\*\*Risk:\*\* Medium. Risk of removing something semantically important

by accident. Read each rule carefully before consolidating. Diff

both directions: source diff AND rendered-prompt diff.



\*\*Estimated effort:\*\* \~45 minutes prompt review + edit + smoke test.



\*\*Test:\*\* Ask agent the same booking question 5 times in fresh

sessions. Behavior should be consistent across runs (calling

check\_availability every time, asking for PENDING\_BOOKING confirmation

every time, etc.).



\---



\## 🔵 P2 — Voice Bug C: no "Sim 3 like last time" personalization



\*\*Symptom:\*\* Agent doesn't proactively suggest customer's usual

choice. Doesn't surface remaining package/membership credits.



\*\*Diagnosis (from docs/AUDIT\_2026-05-11.md):\*\*

> voiceContext.formatCustomerForVoice (lines 527-614) emits ZERO

> past-bookings/patterns data. The chat-path PATTERNS DETECTED +

> PERSONALIZATION rule (claudeService.js 329-357 / 643-651) exists

> but uses MAY instead of MUST.



\*\*Fix surfaces:\*\*

\- Add past-bookings rendering to voiceContext.js: surface last 5

&#x20; bookings per service with resource\_id, staff\_id, time-of-day pattern

\- Promote PATTERNS DETECTED rule in claudeService.js from MAY to MUST

\- Add upsell rule for value comparison ("5-pack is 30 each vs 35 single")



\*\*Risk:\*\* Medium. Two-file change. Behavior change customers will

notice. Demo to ak before shipping.



\*\*Estimated effort:\*\* \~45-60 minutes.



\*\*Test:\*\* Customer with 5 prior Sim 3 bookings asks for "a golf sim."

Agent should propose Sim 3 with one-tap accept. Customer with active

membership should be offered membership credits as default payment.



\---



\## 🔵 P3 — Voice Bug D (tool\_choice migration portion)



\*\*Diagnosis:\*\* Voice agent emits ACTION:{...} as regex-parsed text

(claudeService.js:735). No Anthropic tools configured. Compare with

ROADMAP-OPTION-C.md Phase 2.



\*\*Fix:\*\* Replace giant prompt + regex parsing with structured tools:

\- check\_availability

\- find\_packages\_for\_service

\- get\_customer\_balance

\- get\_service\_details

\- propose\_booking

\- create\_booking

\- cancel\_booking



Use tool\_choice: "auto" for normal turns, "tool" (forced) for

availability turns.



\*\*Risk:\*\* High. Largest blast radius change in voice agent. Touches

prompt structure, ACTION parsing, retry logic, every consumer of

claudeService.runSupportAgent(). PENDING\_BOOKING + confirmation

handshake also need re-tooling.



\*\*Cost impact:\*\* $0.05-0.10 → $0.10-0.30 per conversation (per

ROADMAP-OPTION-C.md). Latency 1-2s → 2-5s per turn.



\*\*Estimated effort:\*\* 3-5 sessions including thorough smoke testing.



\*\*Prerequisite:\*\* Build smoke-test harness (below) first so

regressions are caught automatically.



\---



\## 🛠️ Discipline items (not bug fixes, but enabling work)



\### Smoke-test harness for voice agent

Currently the only voice agent test is "ak listens to it." Need:

\- Fixture: known transcript replay through claudeService.runSupportAgent()

\- Assertions: ACTION block emitted, ACTION shape valid, no banned phrases

\- Logs: token cost per turn, latency

\- Run on every voice-prompt PR before merge



\### Cost dashboard

Per-tenant token spend tracking. Currently Birdie burns \~$3.49/mo.

Estimated $30-50/mo at full Multi-agent Clawbot scale. Needs visibility.

\- /api/admin/voice-usage route showing per-tenant $/day, $/month

\- Tied to tenant\_ai\_usage\_log table (ROADMAP-OPTION-C.md Phase 1)



\### Voice-prompt diff review

Currently you only see source code diff, not the rendered string the

model receives. Need a CLI or script that takes a tenant slug and

prints buildSystemPrompt() output, so prompt changes can be diffed

against the actual rendered string the model sees.



\---



\## ❄️ Technical debt flagged by docs/AUDIT\_2026-05-11.md PART 1



\### routes/ai.js

\- slotConfirmationCache IIFE singleton (lines TBD) — process-local

&#x20; cache, won't survive horizontal scale. Single Render instance today

&#x20; so not biting, but a scale-out hazard.



\### routes/tenants/core.js

\- Incomplete POST /:id/logo stub at lines 815-819. Either complete

&#x20; the handler or remove. Quick win on next touch of that file.



\### routes/bookings/crud.js

\- requireAppAuth import flagged as probably dead code. Trivial

&#x20; cleanup.



\### utils/claudeService.js

\- Module-level Anthropic() singleton is INTENTIONAL (prompt cache

&#x20; warmth). Do NOT move during any refactor. Document in code if not

&#x20; already.



\---



\## Per-tenant voice prompt scaling



VOICE-FIX-6 shipped per-tenant prompt snapshots via

tenants.voice\_prompt\_snapshot JSONB (migration 066). Only Birdie has

a snapshot today.



\*\*To scale:\*\*

\- Onboarding wizard (WIZ-1 series) auto-generates starter snapshot

&#x20; from tenant business data. voicePromptGenerator.js is already wired.

\- Owner UI to view/edit/regenerate snapshots. Route exists at

&#x20; /api/admin/voice-prompt/:slug/{generate,read,update,clear}.

\- Per-tenant smoke tests before going live with voice on a new tenant.



\---



\## What NOT to do



\- Do not over-aggressively prompt-engineer ("ACTION must be FIRST

&#x20; LINE", "STOP your turn", "NEVER do X" without escape). Previous

&#x20; session lessons (SESSION-SUMMARY-2026-05-04.md) showed this collapses

&#x20; multi-step flows.

\- Do not consolidate rules without reading each one carefully. The

&#x20; duplicated availability rule LOOKS like a duplicate but the two

&#x20; instances scope different turn types — verify before merging.

\- Do not migrate to tool\_choice without smoke-test harness in place.

\- Do not bypass the OPTION-A-FINAL baseline. Any future voice prompt

&#x20; edit starts from current main, not from an older snapshot.



\---



End of backlog. Update this file whenever a voice item ships or a

new bug is observed.

