# BookFlow Data Retention & Compliance Policy

**Status:** Authoritative  
**Applies to:** All tenant and platform data  
**Last updated:** 2026-01-26

## Purpose
This document defines how BookFlow retains, protects, and disposes of data in a compliant and auditable manner.

## Data Categories
- **Operational data:** bookings, schedules, services
- **Financial data:** invoices, payments, subscriptions
- **User data:** users, tenant_users
- **Audit data:** ledger entries, logs

## Retention Principles
- Retain only what is necessary
- Preserve audit-critical data
- Prefer soft delete over hard delete

## Retention Rules
- Bookings & ledger: retained indefinitely for audit
- Invoices & payments: retained per financial compliance norms
- Users & tenants: soft-deleted, retained for audit
- Logs: retained per provider limits

## Deletion Handling
- Soft delete is default
- Hard delete only via governed workflows (Tenant Purge)
- No automatic destruction of audit data

## Tenant Requests
- Data export supported at platform discretion
- Deletion requests handled via soft delete unless legally required otherwise

## Compliance Scope
- Designed to be compatible with GDPR-style principles
- No tenant data shared between tenants
- Access controlled at platform level

## PR-C Requirement
Retention rules must be documented and reviewed before production release.
