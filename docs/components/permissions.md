---
schema_version: 1
id: CMP-PERMISSIONS
kind: component
title: Permissions
owners:
  - unassigned
component_ids:
  - CMP-PERMISSIONS
created_at: 2026-08-13
reviewed_at: 2026-08-14
reviewed_ref: 83819a57fd8635384d14d3cc8d591e8f76ad1260
decision_ids:
  - ADR-0002
  - ADR-0003
  - ADR-0004
invariant_ids:
  - INV-ADAPTERS-002
  - INV-IDENTITY-005
  - INV-PERMISSIONS-013
  - INV-PERMISSIONS-014
  - INV-IDENTITY-003
failure_pattern_ids:
  - FP-ADAPTERS-002
  - FP-PERMISSIONS-001
  - FP-IDENTITY-003
qualification_ids:
  - QMAT-ADAPTERS-001
  - QMAT-JOB-A-STOPPED-001
  - QUAL-20260813-174902-001
  - QMAT-JOB-B-ACTIVE-MEMBER-001
  - QUAL-20260814-050326-001
  - QMAT-READABLE-SEARCH-MINIMUM-V1-001
  - QUAL-20260814-194049-001
---

# Permissions

## Responsibility

Permissions determine whether a specific actor may perform an action or
receive particular organization information. The domain crosses local frozen
approval state, provider action evidence, central membership, record
admission, derived facts, retrieval scope, final authorization checks, and
audit.

Identity answers who the actor is. Permission answers what that actor may do
with a particular action or content boundary.

## Current references

- [Organization permission architecture](../product/2026-08-09-organization-permission-architecture.md)
- [Permission pilot V1](../product/2026-08-10-permission-pilot-v1-contract.md)
- [Invariant registry](../product/2026-08-11-architecture-invariant-registry.md)
- [Reviewer permission V1](../product/2026-08-11-reviewer-permission-v1-log-facts-design.md)
- [Permission-aware searchable Layer 2](../product/2026-08-11-trusted-permission-aware-searchable-layer-2-design.md)

## Documentation rule

Permission claims must name their enforcement scope. A bounded pilot or one
retrieval operation is not evidence of a globally enforced permission system.
Every served path must link its invariant, enforcement point, denial behavior,
audit evidence, and qualification case.
