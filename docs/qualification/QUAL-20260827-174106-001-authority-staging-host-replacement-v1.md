---
schema_version: 1
id: QUAL-20260827-174106-001
kind: qualification
title: Authority staging host-replacement V1 qualification
component_ids:
  - CMP-OPERATIONS-RELEASE
created_at: 2026-08-27
reviewed_at: 2026-08-27
reviewed_ref: f0d2f95214246501bfcca59b156a30105fce947d
run_status: completed
result: passed
stop_reason: not-applicable
source_commit: f0d2f95214246501bfcca59b156a30105fce947d
artifact_digest: sha256:f6cd665fe3dcb6c1dde41fbc7b035fd226ccc85d6054ace85fc883231238ad1a
configuration_identity: opaque:AUTHORITY-STAGING-SLOT-20260827-001
state_identity: opaque:RETAINED-CLEAN-DATA-20260827-001
started_at: 2026-08-27T16:58:33Z
completed_at: 2026-08-27T18:02:47Z
matrix_id: QMAT-AUTHORITY-STAGING-HOST-REPLACEMENT-V1-001
matrix_version: 1
assertion_ids:
  - STAGINGV1-001
  - STAGINGV1-002
  - STAGINGV1-003
  - STAGINGV1-004
  - STAGINGV1-005
  - STAGINGV1-006
evidence_ids:
  - EVID-AUTHORITY-STAGING-FIRST-LIVE-20260827-001
  - EVID-AUTHORITY-STAGING-REHEARSALS-20260827-001
  - EVID-AUTHORITY-STAGING-DOWN-20260827-001
  - EVID-AUTHORITY-STAGING-DRIFT-20260827-001
  - EVID-AUTHORITY-STAGING-PREFLIGHT-20260827-001
---

# Authority staging host-replacement V1 qualification

## Scope, identities, and preconditions

The first-live phase passed before the replacement rehearsals. Its accepted
release was `clean-v1-staging-20260827-004`, sourced from
`825707b4a5356d3e3a1baf2c75aee6484ba426d9`. The later lifecycle controller
revision was `f0d2f95214246501bfcca59b156a30105fce947d`.

The public report records the controller source as its source identity and the
accepted Authority image digest as its artifact identity. First-live is a
separately sourced precondition tied to the accepted release source above.
`started_at` is the first qualifying CloudFormation operation timestamp and
`completed_at` is the final qualifying descriptor-probe completion timestamp.

## Results

| Assertion | Outcome | Evidence |
| --- | --- | --- |
| `STAGINGV1-001` | passed | `EVID-AUTHORITY-STAGING-FIRST-LIVE-20260827-001` |
| `STAGINGV1-002` | passed | `EVID-AUTHORITY-STAGING-REHEARSALS-20260827-001` |
| `STAGINGV1-003` | passed | `EVID-AUTHORITY-STAGING-REHEARSALS-20260827-001` |
| `STAGINGV1-004` | passed | `EVID-AUTHORITY-STAGING-DOWN-20260827-001` |
| `STAGINGV1-005` | passed | `EVID-AUTHORITY-STAGING-DRIFT-20260827-001` |
| `STAGINGV1-006` | passed | `EVID-AUTHORITY-STAGING-PREFLIGHT-20260827-001` |

The three AWS-authoritative lifecycle elapsed measurements were 245.630
seconds, 272.446 seconds, and 236.185 seconds. Each interval starts at the
stack-level CloudFormation `UPDATE_IN_PROGRESS` event for the reviewed `up`
and ends at SSM `ExecutionEndDateTime` for the successful
public-versus-direct-in-container descriptor probe, after source equality,
explicit accepted-release resume, and terminal-green proof. All are below the
10-minute threshold.

Closure verification passed all five focused staging architecture suites (102
tests) and `npm run check` (99 test files and 862 tests).

## Deviations, follow-up, and sanitized evidence

The POSIX `sh` `pipefail` failure was discovered before any CloudFormation
execute. It was corrected and tested, and one successful byte-identical
pre-commit shakedown followed. That shakedown is excluded so all three
qualifying replacement cycles postdate and map exactly to the committed
controller source.

The evidence-index rows name exact SHA-256 digests for the sanitized
founder-private receipts. This report makes no snapshot-restore claim, does not
close GAP-01 or issue #20, and does not claim GAP-04 closure.
