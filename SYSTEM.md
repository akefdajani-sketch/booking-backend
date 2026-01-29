# 🧠 SYSTEM.md
## BookFlow — System Constitution & Build Law

> **This file defines how BookFlow is built, changed, reviewed, and scaled.**  
> If code conflicts with this document, **the code is wrong**.

---

## 1. What BookFlow Is

BookFlow is a **multi-tenant booking and operations SaaS** for **time-based service businesses** (golf venues, gyms, studios, salons, clinics, and similar operations).

BookFlow is **not** a calendar toy or a CRUD scheduler.  
BookFlow is the **operating system** for time-based businesses.

---

## 2. System Principles (Non-Negotiable)

### 2.1 One System, Not Two
Frontend and backend are **one system**. Any change must be evaluated end-to-end:
- UX
- Data flow
- Booking correctness
- Tenant safety
- Performance
- Commercial impact

### 2.2 Tenant Isolation Is Sacred
Every read/write, cache, and derived dataset must be **tenant-scoped**.
No cross-tenant leakage, ever.

### 2.3 Time Is First-Class
- Time rules must be explicit and consistent.
- Durations must reflect **real selected time**, not assumptions.
- Timezone handling must be deliberate (normalize and store consistently).

### 2.4 UI Never Lies
- “Saved” means saved.
- Disabled actions explain why.
- Empty states are intentional and helpful.
- No silent failures.

---

## 3. Phase Positioning

We are between:
- ✅ **Phase 0 — Stabilization**
- 🚧 **Phase 1 — Commercial v1 (Active)**

**Phase 1 goal:** a business can onboard, operate, and take bookings with **no founder intervention**.

---

## 4. Technical Stack (Locked)

### Frontend
- Next.js 16 + React 19 + TypeScript
- SSR + client hydration
- Theme tokens via CSS variables

### Backend
- Express.js + PostgreSQL
- Constraints preferred over “hopeful” app-only logic
- Ledger-style accounting for memberships

### Infra
- Frontend: Vercel
- Backend: Render
- Postgres: managed
- Assets: object storage (R2/S3-style)

---

## 5. Core Domain Laws (Do Not Break)

### 5.1 Bookings
- Multi-slot selection forms **one booking** (contiguous time block).
- **Service controls time rules** (not staff/resources).
- Stored duration must reflect the selected slots:
  - `duration_minutes = selected_slot_count × slot_interval_minutes`
- Booking lifecycle must be explicit (pending/confirmed/cancelled).

### 5.2 Availability
- Availability must be derived from:
  - working hours
  - existing bookings
  - staff/resource constraints
  - service slot rules
- Avoid split-brain logic: **one source of truth**.

### 5.3 Memberships (Ledger Rules)
- Ledger is **append-only**:
  - No edits
  - No deletes
- Every debit/credit is auditable and permanent.
- Idempotency must be respected for membership mutations.

---

## 6. Performance & Scale Rules

### Reads
- No unbounded loads.
- Lists must paginate / limit.
- Avoid N+1 patterns; add indexes when introducing filters.

### Writes
- Prefer idempotent mutations for anything users can retry.
- Must remain tenant-safe.

---

## 7. Commercial Awareness (Always On)

Every feature must answer:
> “Does this make BookFlow easier to sell, operate, or trust?”

Phase 1 work prioritizes:
- correctness
- onboarding
- owner usability
- reliability
- SaaS-grade theming & branding

Enterprise-only features (white-label, custom domains, APIs) must not leak into starter.

---

## 8. Change Discipline (Required)

Before writing code:
1. State assumptions
2. Map the data flow
3. Identify blast radius
4. Choose smallest safe change
5. Explicitly list what is NOT touched

---

## 9. Authority Hierarchy

When conflicts exist:
1. **SYSTEM.md**
2. Database constraints
3. Backend business logic
4. Frontend logic
5. UI polish

---

## 10. Final Rule

> BookFlow is being built to become a **real business**, not a clever codebase.

If a change does not improve **trust, clarity, sellability, or operational burden**, it does not ship.
