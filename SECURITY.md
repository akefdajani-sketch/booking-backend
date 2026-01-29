# SECURITY.md
## Security Policy (BookFlow)

This repository is part of the BookFlow system. It is governed by `SYSTEM.md`.

### Reporting a vulnerability
If you believe you have found a security issue:
- **Do not** open a public issue with exploit details.
- Create a private report to the maintainer/team with:
  - A clear description of the issue
  - Steps to reproduce
  - Impact assessment
  - Any logs/screenshots (remove secrets)

### Supported versions
Only the **current `main` branch** (and the latest release tag) is supported for security fixes.

### High-level rules (non-negotiable)
- Never commit secrets (API keys, DB URLs, JWT secrets).
- Never expose secrets to the client bundle (`NEXT_PUBLIC_*` is public).
- Tenant isolation must be preserved (no cross-tenant reads/writes).
- Membership ledger must remain append-only (auditability).

### Secure defaults
- Use least-privilege credentials for databases and storage.
- Enable HTTPS-only in production.
- Log errors without leaking secrets or PII.
