---
schema_version: 1
id: QMAT-AUTHORITY-STAGING-HOST-REPLACEMENT-V1-001
kind: qualification-matrix
title: Authority staging host-replacement V1 matrix
component_ids:
  - CMP-OPERATIONS-RELEASE
created_at: 2026-08-27
reviewed_at: 2026-08-27
reviewed_ref: f0d2f95214246501bfcca59b156a30105fce947d
matrix_version: 1
assertion_ids:
  - STAGINGV1-001
  - STAGINGV1-002
  - STAGINGV1-003
  - STAGINGV1-004
  - STAGINGV1-005
  - STAGINGV1-006
---

# Authority staging host-replacement V1 matrix

## Scope and non-claims

This matrix qualifies one staging first-live onboarding and three consecutive
retained-state host replacements. It is limited to the fixed staging edge, the
replaceable host lifecycle, and the accepted clean V1 release tuple. The
underlying raw receipts remain founder-private; tracked evidence IDs and exact
digests index the sanitized receipts without publishing their locations.

It does not qualify a snapshot restore, a same-lineage restored-volume serve,
or the current-production recovery procedure. It does not close GAP-01 or
issue #20, and does not claim GAP-04 closure, image publication, or automated
release promotion.

| Assertion ID | Assertion |
| --- | --- |
| `STAGINGV1-001` | Before replacement rehearsals, a reviewed change set had created the persistent slot and enabled host; the required observability sibling reached `CREATE_COMPLETE`; its subscription was confirmed and all four alarm and OK actions targeted that destination; the accepted clean V1 staging release reached terminal green; the public HTTPS descriptor returned `200` and exactly equaled the local descriptor; and authenticated Layer 1 and Layer 2 checks passed. |
| `STAGINGV1-002` | Three consecutive retained-state `down` then fresh-host `up` rehearsals on controller revision `f0d2f95214246501bfcca59b156a30105fce947d` each completed in at most 10 minutes: 245.630 seconds, 272.446 seconds, and 236.185 seconds. The AWS-authoritative interval starts at the stack-level CloudFormation `UPDATE_IN_PROGRESS` event for the reviewed `up` and ends at SSM `ExecutionEndDateTime` for the successful public-versus-direct-in-container descriptor probe, after source equality, explicit resume, and terminal-green proof. |
| `STAGINGV1-003` | Every rehearsal used a distinct fresh host while retaining the same staging hostname, tunnel, and data volume; required no callback or DNS edit; verified input-archive hash equality; verified host-bundle `source_commit` equality with the accepted release source SHA; explicitly resumed with `restore-clean-v1-host.sh resume`; used the accepted image and runtime profile; reached terminal green; and returned public `200` equal to the direct in-container descriptor. |
| `STAGINGV1-004` | Each normal `down` removed only `StagingHost`, `StagingDataVolumeAttachment`, `StagingReadyHandle`, and `StagingReady`, while the host role and launch template were modified in place. No retained edge or data-volume resource was removed. |
| `STAGINGV1-005` | The second and third qualifying applies repeated the reviewed lifecycle boundary without an unexpected change. Final drift detection found exactly one expected cross-stack difference: `StagingHostRole` `ManagedPolicyArns/0`, owned by the observability sibling's `AuthorityDockerLogWritePolicy`; it found no unexpected drift. |
| `STAGINGV1-006` | A portability failure from `pipefail` under POSIX `sh` was detected before any CloudFormation execute, corrected and tested, and committed as `f0d2f95214246501bfcca59b156a30105fce947d`. One successful byte-identical pre-commit shakedown was excluded so all three qualifying cycles postdate and map exactly to that controller revision. |
