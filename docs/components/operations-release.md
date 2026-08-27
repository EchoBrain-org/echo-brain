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
reviewed_at: 2026-08-27
reviewed_ref: f0d2f95214246501bfcca59b156a30105fce947d
decision_ids:
  - ADR-0004
  - ADR-0006
  - ADR-0008
  - ADR-0009
invariant_ids:
  - INV-IDENTITY-004
  - INV-RELEASE-001
  - INV-OPERATIONS-001
failure_pattern_ids:
  - FP-IDENTITY-004
  - FP-RELEASE-001
  - FP-OPERATIONS-001
runbook_ids:
  - RB-OPERATIONS-001
  - RB-OPERATIONS-002
  - RB-OPERATIONS-003
qualification_ids:
  - QMAT-JOB-A-STOPPED-001
  - QUAL-20260813-174902-001
  - QMAT-JOB-B-ACTIVE-MEMBER-001
  - QUAL-20260814-050326-001
  - QMAT-READABLE-SEARCH-MINIMUM-V1-001
  - QUAL-20260814-194049-001
  - QMAT-PERSON-CLIENT-FOUNDATION-V1-001
  - QUAL-20260819-193536-001
  - QMAT-CI-EFFICIENCY-V1-001
  - QUAL-20260826-034420-001
  - QMAT-AUTHORITY-STAGING-HOST-REPLACEMENT-V1-001
  - QUAL-20260827-174106-001
---

# Operations and release

## Responsibility

This component owns the procedures and automation that turn source into a
tested artifact, deploy compatible product and Authority generations, operate
them, preserve backups, recover state, and record qualification evidence.

Primary roots are `.github/`, `tools/`, and `deploy/`. The Person artifact has
no lifecycle daemon or fleet updater; the Authority uses the server deployment
and rollback procedure.

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
- [Minimal Authority observability runbook](../operations/RB-OPERATIONS-001-authority-observability.md)
- [Current Authority recovery-floor runbook](../operations/RB-OPERATIONS-002-authority-recovery-floor.md)
- [Canonical source and immutable clean-beta release runbook](../operations/RB-OPERATIONS-003-protect-canonical-source-and-releases.md)
- [Qualification and evidence](../qualification/README.md)
- [`deploy/organization-authority/`](../../deploy/organization-authority)
- [`tools/`](../../tools)
- [GitHub workflows](../../.github/workflows)

Operational documents must name prerequisites, permissions, expected evidence,
stop conditions, rollback, and the last date the exact procedure was tested.
The current-host recovery floor additionally requires private evidence that the
live source EBS volume is encrypted, account-owned, and backed by an enabled,
usable source key whose manager is recorded as either AWS or CUSTOMER. EBS
recovery points inherit that source encryption; a backup vault does not
independently re-encrypt them. The current same-account AWS-managed key blocks
future cross-account copying, while a customer-managed-key migration belongs to
the later data-volume/foundation decision. The recovery template cannot
establish these live facts. Its qualifying backup stop/start is a durable,
script-managed transaction with external backup acknowledgement and
accepted-tuple/public-descriptor restart proof; it has not yet been rehearsed.
