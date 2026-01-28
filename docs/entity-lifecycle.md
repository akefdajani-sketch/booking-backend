# BookFlow – Entity Lifecycle & Integrity Protocol

**Status:** Permanent Core Policy
**Applies to:** Services, Staff, Resources
**Scope:** All tenants, all plans
**Maps to:** Phase 0 (Trust & Data Integrity) → Phase 1 (Commercial Readiness)

---

## 1. Purpose

This protocol defines how *services*, *staff*, and *resources* are created, edited, retired, and (when safe) deleted within BookFlow.

Its goal is to:

* Protect booking history and financial integrity
* Prevent accidental data loss
* Give tenants flexibility to correct mistakes
* Avoid database bloat and uncontrolled duplication
* Ensure predictable, auditable behavior across all plans

This policy is **non-negotiable** and applies uniformly across the platform.

---

## 2. Core Principle: History Is Sacred

Once an entity is referenced by a booking, it becomes part of historical truth.

**Rule:**

* No action taken by a tenant may invalidate or rewrite past bookings.
* Bookings must always remain reproducible, auditable, and correct as created.

As a result:

* Entity *IDs* are immutable
* Entity *names and images* are mutable
* Operational rules apply **forward only**

---

## 3. Identity vs Display

Each entity is split conceptually into:

### 3.1 Identity (Immutable)

* `id`
* Tenant ownership
* Booking references

### 3.2 Display (Mutable)

* Display name
* Description
* Images / icons
* Color tags

**Rule:**

* Display fields are always editable
* Bookings never depend on display text

This allows tenants to fix spelling mistakes or branding issues at any time without risk.

---

## 4. Operational Rules & Forward-Only Changes

Operational attributes (examples):

* Service duration
* Slot interval
* Capacity rules
* Staff availability constraints
* Resource capacity/type

**Rule:**

* Changes to operational rules affect *future bookings only*
* Existing bookings retain the values captured at creation

Implementation strategy:

* Critical operational values are stored on the booking record
* Current entity rules are used only for availability generation and new bookings

No retroactive mutation is allowed.

---

## 5. Entity Lifecycle States

Entities exist in one of three states:

### 5.1 Draft

* Newly created
* Never used in bookings
* Fully editable
* Can be deleted permanently

### 5.2 Active

* Available for booking
* Counts toward plan limits
* Editable (with forward-only rule application)

### 5.3 Retired (Inactive)

* No longer selectable for new bookings
* Still referenced by historical bookings
* Does **not** count toward plan limits
* Can be reactivated by tenant if needed

---

## 6. Delete vs Retire Rules

### 6.1 Hard Delete (Permanent)

Allowed **only if**:

* Entity has zero bookings bookings ever

Effect:

* Row removed from database
* Images removed from storage

### 6.2 Retire (Soft Delete)

Required if:

* Entity has one or more bookings

Effect:

* `is_active = false`
* Hidden from booking UI
* Preserved for history and reporting

The UI must never present “Delete” when only “Retire” is valid.

---

## 7. Plan Limits & Quotas

Plan limits apply to **Active entities only**.

* Active services count toward service quota
* Active staff count toward staff quota
* Active resources count toward resource quota

Retired entities:

* Do not block growth
* Do not force tenants to duplicate endlessly

This prevents quota pressure from corrupting data hygiene.

---

## 8. Duplication & Correction Strategy

Tenants must never be forced to delete to fix mistakes.

Approved correction methods:

* Rename entity
* Replace image
* Retire incorrect entity and create a new one

Optional advanced tools (Phase 1+):

* Merge duplicates (future associations only)
* Alias / alternate display names

Historical bookings always remain untouched.

---

## 9. Images & Assets Policy

Images are **non-authoritative assets**.

Rules:

* Images can be uploaded, replaced, or removed at any time
* Image deletion must never block entity actions
* Image storage keys are independent of entity lifecycle

Deleting an image:

* Clears reference
* Does not affect bookings or entity validity

---

## 10. Data Hygiene & Retention

### Automatic Cleanup

* Draft or retired entities with zero bookings may be auto-purged after a grace period

### Permanent Retention

* Any entity referenced by a booking is retained indefinitely
* Archival (cold storage) may be introduced in later phases

---

## 11. UX & Transparency Requirements

The system must clearly communicate:

* Why deletion is blocked
* When an entity is retired
* Whether changes affect future bookings only

Default views:

* Show Active entities only
* Toggle to show Retired entities

No silent failures. No ambiguous states.

---

## 12. Phase Alignment

### Phase 0 – Trust Foundation

* Immutable booking history
* Clear lifecycle rules
* No destructive ambiguity

### Phase 1 – Commercial Readiness

* Tenant self-correction without support
* Predictable quotas
* Clean, scalable data model

---

## Final Rule

**If an action can compromise historical truth, it is not allowed.**
Everything else must be designed to be flexible, explicit, and reversible.

This protocol is the backbone of BookFlow’s reliability guarantee.
