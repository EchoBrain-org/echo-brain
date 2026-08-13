---
schema_version: 1
id: CMP-IDENTITY-ACCESS
kind: component
title: Identity and access
owners:
  - unassigned
component_ids:
  - CMP-IDENTITY-ACCESS
created_at: 2026-08-13
reviewed_at: 2026-08-13
reviewed_ref: 808ac89eaf3e8eba529b356bd80d4509b9a2a293
invariant_ids:
  - INV-IDENTITY-001
  - INV-IDENTITY-002
  - INV-IDENTITY-003
  - INV-IDENTITY-004
  - INV-PERMISSIONS-014
failure_pattern_ids:
  - FP-IDENTITY-001
  - FP-IDENTITY-002
  - FP-IDENTITY-003
  - FP-IDENTITY-004
---

# Identity and access

## Responsibility

This cross-cutting domain establishes who a device or human is and whether the
installation currently has organization access. It includes installation
identity, Authority pinning, enrollment, principals, memberships, provider
identity links, signed access leases, renewal, expiry, and revocation.

It does not decide which particular organization content a caller may read;
that belongs to [permissions](permissions.md).

## Authority split

- The Mac owns its installation key and locally accepted high-watermarks.
- The central Authority owns organization principals, memberships,
  enrollments, grants, and current signed access state.
- The control plane owns verified provider identity and its binding to central
  principal and membership IDs.
- External providers remain authoritative for their own workspace, app, bot,
  and user identities at verification time.

## Current references

- [Identity and onboarding](../architecture/identity-and-onboarding.md)
- [Organization control plane](../architecture/organization-control-plane.md)
- Local boundary: [`src/product/organization/`](../../src/product/organization)
- Authority: [`services/organization-authority/`](../../services/organization-authority)
- Control plane: [`services/organization-control-plane/`](../../services/organization-control-plane)

Identity documents must state the authoritative source for every identifier,
nullability, required scope, time and revocation behavior, migration path, and
rollback boundary.
