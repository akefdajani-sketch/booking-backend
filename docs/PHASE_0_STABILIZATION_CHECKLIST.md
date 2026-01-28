1️⃣ PHASE-0 STABILIZATION CHECKLIST (PDF-READY)

File: docs/PHASE_0_STABILIZATION_CHECKLIST.md
(Can be exported to PDF exactly as-is)

Purpose

This checklist defines when the system is considered safe.
If any item fails, no release is allowed.

A. ENVIRONMENT SANITY (MANDATORY)

 Single backend origin

Frontend uses one source of truth (NEXT_PUBLIC_API_BASE_URL)

No hardcoded prod URLs inside pages or proxies

 Backend health endpoint reachable

/health returns OK

Database connected

B. TENANT ISOLATION (P0 – CRITICAL)

 All backend queries require tenant context

 No default tenant fallbacks

 Tenant mismatch requests are rejected

 Public booking resolves tenant only from slug / header / referer

C. BOOKING CORRECTNESS (P0 – CRITICAL)

 Multi-slot selection works

 Service controls time

 Slot interval comes from service

 Booking duration = selected slots × slot interval

 Availability recalculated at booking creation

 No overbooking possible

D. MEMBERSHIP LEDGER INTEGRITY (P0 – CRITICAL)

 Ledger is append-only

 No edits / deletes

 Usage derived only from ledger

 Booking + ledger writes are atomic

E. GOLDEN PATH ROUTES (ALL MUST PASS)

 / renders (no backend dependency)

 /owner/dashboard loads (login or dashboard)

 /owner/{slug} loads (no undefined, no redirect loop)

 /book/{slug} loads with:

Correct theme

Services visible

Availability returned

Phase-0 Exit Rule

If all boxes are checked, the system is Phase-0 stable.
If even one fails, the release is blocked.
