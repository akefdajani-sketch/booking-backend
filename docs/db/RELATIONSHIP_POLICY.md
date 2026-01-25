# BookFlow DB Relationship Policy (Foreign Keys)

**Status:** Authoritative  
**Applies to:** All Postgres schemas/tables used by BookFlow  
**Last updated:** 2026-01-26

## Purpose
This document defines the non-negotiable rules for database relationships (Foreign Keys) in BookFlow.
It prevents accidental data loss, enforces consistency across tenants, and supports scalability and auditability.

## Core Principles
1. **Tenant safety by design**
   - All tenant-owned tables MUST include `tenant_id`.
   - No foreign key relationship may allow cross-tenant references in practice.
2. **RESTRICT by default**
   - `ON DELETE RESTRICT` is the default for business-critical data.
   - `ON UPDATE RESTRICT` is preferred unless a strong reason exists.
3. **No silent destruction**
   - `ON DELETE CASCADE` is NOT allowed for core business entities (bookings, customers, memberships, invoices, payments).
4. **Optional relationships**
   - `ON DELETE SET NULL` is allowed only when the relationship is genuinely optional and the system behaves correctly with NULL.
5. **Join tables exception**
   - `ON DELETE CASCADE` is allowed only for “pure join tables” with no business meaning on their own (e.g., mapping tables), and must be documented as an approved exception.

## Required Artifacts
BookFlow must maintain:
- `docs/db/generated/fk_inventory_<date>.csv` (raw snapshot from the DB)
- `docs/db/FK_INVENTORY.md` (human-reviewed inventory)

## Audit & Release Gate (PR-C)
For every production release:
1. Generate a fresh FK snapshot CSV.
2. Diff the previous snapshot.
3. Review any changes to FKs, especially any `CASCADE` rules.
4. Update `FK_INVENTORY.md` (date + rationale notes).
5. If any `CASCADE` exists, it MUST be listed under “Approved Exceptions” in `FK_INVENTORY.md`.

## Approved Exceptions
Exceptions must be explicitly listed in `FK_INVENTORY.md` with:
- FK name and tables
- Delete/update rule
- Why it is safe
- Why it is necessary
- Date approved

