# BookFlow SOC-2 Control Mapping (Lightweight)

**Framework:** SOC-2 Trust Services Criteria (TSC)  
**Scope:** Logical, infrastructure, and data controls  
**Status:** Internal readiness mapping  
**Last updated:** 2026-01-26

---

## CC1 — Control Environment
**Principle:** The organization demonstrates integrity, ethical values, and accountability.

**Controls:**
- Code ownership defined (`docs/CODE_OWNERSHIP.md`)
- Platform Owner authority documented
- PR-C gating required for production release

**Evidence:**
- CODE_OWNERSHIP.md
- PR-C Proof Pack

**Status:** IMPLEMENTED

---

## CC2 — Communication & Information
**Principle:** Relevant information is identified and communicated.

**Controls:**
- System policies documented
- Changes gated via PR-C
- Documentation stored in repo

**Evidence:**
- docs/db/*
- docs/security/*
- docs/ops/*

**Status:** IMPLEMENTED

---

## CC3 — Risk Assessment
**Principle:** Risks to objectives are identified and addressed.

**Controls:**
- CASCADE delete review
- Tenant isolation enforcement
- Soft delete as default
- Incident response defined

**Evidence:**
- CASCADE_REVIEW_VERDICT.md
- RELATIONSHIP_POLICY.md
- INCIDENT_RESPONSE_POLICY.md

**Status:** IMPLEMENTED

---

## CC4 — Monitoring Activities
**Principle:** Controls are monitored over time.

**Controls:**
- Provider health monitoring
- Manual review for incidents
- Rollback capability exists

**Evidence:**
- INCIDENT_EVIDENCE.md

**Status:** IMPLEMENTED

---

## CC5 — Logical & Physical Access
**Principle:** Access is restricted to authorized users.

**Controls:**
- Least-privilege DB roles
- Owner-only admin actions
- No shared credentials

**Evidence:**
- ACCESS_CONTROL_POLICY.md
- ACCESS_EVIDENCE.md

**Status:** IMPLEMENTED

---

## CC6 — Change Management
**Principle:** Changes are authorized and tested.

**Controls:**
- Git-based deployments
- PR-C gate required
- Rollback defined

**Evidence:**
- PR-C Proof Pack
- Git history

**Status:** IMPLEMENTED

---

## CC7 — System Operations
**Principle:** System operations are managed securely.

**Controls:**
- Backup & restore policies
- Incident response procedures
- Controlled tenant purge

**Evidence:**
- BACKUP_POLICY.md
- INCIDENT_RESPONSE_POLICY.md

**Status:** IMPLEMENTED

---

## CC8 — Data Integrity & Confidentiality
**Principle:** Data is accurate, complete, and protected.

**Controls:**
- FK enforcement
- Ledger immutability
- Tenant isolation
- Soft delete

**Evidence:**
- FK_INVENTORY.md
- RELATIONSHIP_POLICY.md
- DATA_RETENTION_POLICY.md

**Status:** IMPLEMENTED
