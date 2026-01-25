# BookFlow Access & Role Governance Policy

**Status:** Authoritative  
**Applies to:** Database, infrastructure, and admin tooling  
**Last updated:** 2026-01-26

## Purpose
This document defines access control rules to ensure security, least privilege, and auditability across BookFlow.

## Core Principles
1. Least privilege by default
2. Separation of duties
3. No shared credentials
4. Auditability of privileged actions

## Role Definitions

### Platform Owner
- Full administrative access
- Can perform Tenant Purge
- Can perform DB restore
- Access is tightly controlled

### Application Runtime
- Uses restricted DB credentials
- No schema modification rights
- No backup or restore rights

### Tenant Admin
- Access limited to tenant-scoped data
- No infrastructure or DB access

## Credential Management
- Secrets stored via environment variables / provider secret store
- Credentials rotated when required
- No secrets committed to source control

## Deletion Rules
- Users and tenants are soft-deleted
- Hard deletes only via governed workflows

## PR-C Requirement
Any change to access rules requires:
- Policy update
- Explicit approval
