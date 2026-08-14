---
schema_version: 1
id: CMP-OPERATIONS-RELEASE
kind: component
title: Operations and release
owners:
  - unassigned
component_ids:
  - CMP-OPERATIONS-RELEASE
created_at: 2026-08-13
reviewed_at: 2026-08-14
reviewed_ref: 83819a57fd8635384d14d3cc8d591e8f76ad1260
invariant_ids:
  - INV-IDENTITY-004
  - INV-RELEASE-001
  - INV-OPERATIONS-001
failure_pattern_ids:
  - FP-IDENTITY-004
  - FP-RELEASE-001
  - FP-OPERATIONS-001
qualification_ids:
  - QUAL-20260813-174902-001
  - QMAT-JOB-B-ACTIVE-MEMBER-001
  - QUAL-20260814-050326-001
  - QMAT-READABLE-SEARCH-MINIMUM-V1-001
  - QUAL-20260814-194049-001
---

# Operations and release

## Responsibility

This component owns the procedures and automation that turn source into a
tested artifact, deploy compatible product and Authority generations, operate
them, preserve backups, recover state, and record qualification evidence.

Primary roots are `.github/`, `tools/`, and `deploy/` plus the lifecycle and
update code under `src/product/`.

## Claim boundaries

Keep these claims separate:

- source implemented;
- merged;
- artifact built;
- CI tested;
- deployed;
- founder-live qualified;
- client-live qualified; and
- released.

An exact artifact or state change invalidates any qualification evidence whose
identity no longer matches.

## Current references

- [Operations records](../operations/README.md)
- [Qualification and evidence](../qualification/README.md)
- [`deploy/organization-authority/`](../../deploy/organization-authority)
- [`tools/`](../../tools)
- [GitHub workflows](../../.github/workflows)

Operational documents must name prerequisites, permissions, expected evidence,
stop conditions, rollback, and the last date the exact procedure was tested.
