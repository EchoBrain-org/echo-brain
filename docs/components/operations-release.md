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
reviewed_at: 2026-08-13
reviewed_ref: 808ac89eaf3e8eba529b356bd80d4509b9a2a293
invariant_ids:
  - INV-IDENTITY-004
  - INV-RELEASE-001
  - INV-OPERATIONS-001
decision_ids: []
failure_pattern_ids:
  - FP-IDENTITY-004
  - FP-RELEASE-001
  - FP-OPERATIONS-001
runbook_ids: []
qualification_ids:
  - QUAL-20260813-174902-001
issue_urls: []
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
