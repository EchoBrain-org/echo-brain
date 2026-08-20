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
reviewed_at: 2026-08-14
reviewed_ref: 83819a57fd8635384d14d3cc8d591e8f76ad1260
decision_ids:
  - ADR-0002
  - ADR-0003
  - ADR-0004
  - ADR-0005
invariant_ids:
  - INV-IDENTITY-001
  - INV-IDENTITY-002
  - INV-IDENTITY-003
  - INV-IDENTITY-004
  - INV-IDENTITY-005
  - INV-PERMISSIONS-014
failure_pattern_ids:
  - FP-ADAPTERS-001
  - FP-IDENTITY-001
  - FP-IDENTITY-002
  - FP-IDENTITY-003
  - FP-IDENTITY-004
qualification_ids:
  - QMAT-ADAPTERS-001
  - QMAT-JOB-B-ACTIVE-MEMBER-001
  - QUAL-20260814-050326-001
  - QMAT-READABLE-SEARCH-MINIMUM-V1-001
  - QUAL-20260814-194049-001
  - QMAT-PERSON-CLIENT-FOUNDATION-V1-001
  - QUAL-20260819-193536-001
---

# Identity and access

## Responsibility

This cross-cutting domain establishes who a human is and whether the caller
currently has organization access. It includes Authority pinning, Person
sessions, principals, memberships, provider identity links, expiry, and
revocation. Historical installation enrollment and access state remain as
server compatibility until record and approval bindings are re-keyed.

It does not decide which particular organization content a caller may read;
that belongs to [permissions](permissions.md).

## Authority split

- The Person client owns only its private Authority-issued session credential
  pair and no installation or organization/provider credential.
- The central Authority owns organization principals, memberships,
  enrollments, grants, and current signed access state.
- The control plane owns verified provider identity and its binding to central
  principal and membership IDs.
- External providers remain authoritative for their own workspace, app, bot,
  and user identities at verification time.

## Current references

- [Identity and onboarding](../architecture/identity-and-onboarding.md)
- [Organization control plane](../architecture/organization-control-plane.md)
- Person-client boundary: [`src/product/person-client/`](../../src/product/person-client)
- Authority: [`services/organization-authority/`](../../services/organization-authority)
- Control plane: [`services/organization-control-plane/`](../../services/organization-control-plane)

Identity documents must state the authoritative source for every identifier,
nullability, required scope, time and revocation behavior, migration path, and
rollback boundary.
