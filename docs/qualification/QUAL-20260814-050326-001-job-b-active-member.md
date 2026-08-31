---
schema_version: 1
id: QUAL-20260814-050326-001
kind: qualification
title: Job B active-member readable-search proof
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-IDENTITY-ACCESS
  - CMP-PERMISSIONS
  - CMP-OPERATIONS-RELEASE
created_at: 2026-08-14
reviewed_at: 2026-08-14
reviewed_ref: add08da02e98c6f3c6aaad71a07141c95887c93d
run_status: completed
result: passed
stop_reason: not-applicable
source_commit: add08da02e98c6f3c6aaad71a07141c95887c93d
artifact_digest: sha256:414d70abcffd6f402ed498152138eeef0cca7d627c8eedb37286382b60408d64
configuration_identity: opaque:CONFIG-JOB-B-ACTIVE-001
state_identity: sha256:2b472bbacc9ebe64eec8ac200deeadad304139a275fa4912b22a9517b4139c55
started_at: not-recorded
completed_at: 2026-08-14T05:03:26.089Z
matrix_id: QMAT-JOB-B-ACTIVE-MEMBER-001
matrix_version: 1
assertion_ids:
  - JOB-B-ACTIVE-001
  - JOB-B-ACTIVE-002
  - JOB-B-ACTIVE-003
  - JOB-B-ACTIVE-004
  - JOB-B-ACTIVE-005
  - JOB-B-ACTIVE-006
  - JOB-B-ACTIVE-007
evidence_ids:
  - EVID-JOB-B-ACTIVE-MEMBER-001
---

# Job B active-member readable-search proof

## Scope and exact identities

This founder-live run proved the everyday path from a schema-V3 approval,
through append and strict-head rejection, to a stopped readable-generation
rebuild and signed reads by an active owner and a different active employee
installation.

The Authority source is the `source_commit` above. Its exact image is the
`artifact_digest` above. The split Mac product candidate remained source
`d43d344c85eabd1531fb68343ac6ca1944155c70` with artifact digest
`sha256:5194aa8026c2c5d4c9af29b5ad29e9add695edda938f71ef09f53087c116050e`.
The cross-machine reader remained source
`a132c35aa9399876cc633c727d2c820af506bcf4` with artifact digest
`sha256:38d3149f4412d7c50335b8165703137ab25162aed1e107713aaea2c62fcda9bc`.
The opaque configuration and exact readable-generation identity resolve only
through `EVID-JOB-B-ACTIVE-MEMBER-001`.

## Assertion results

| Assertion | Outcome | Evidence |
| --- | --- | --- |
| `JOB-B-ACTIVE-001` | passed | `EVID-JOB-B-ACTIVE-MEMBER-001` |
| `JOB-B-ACTIVE-002` | passed | `EVID-JOB-B-ACTIVE-MEMBER-001` |
| `JOB-B-ACTIVE-003` | passed | `EVID-JOB-B-ACTIVE-MEMBER-001` |
| `JOB-B-ACTIVE-004` | passed | `EVID-JOB-B-ACTIVE-MEMBER-001` |
| `JOB-B-ACTIVE-005` | passed | `EVID-JOB-B-ACTIVE-MEMBER-001` |
| `JOB-B-ACTIVE-006` | passed | `EVID-JOB-B-ACTIVE-MEMBER-001` |
| `JOB-B-ACTIVE-007` | passed | `EVID-JOB-B-ACTIVE-MEMBER-001` |

## Non-claims and follow-up

The employee membership used here already existed when the content was
approved. This run therefore does not prove access by a genuinely
later-admitted member or denial after revocation. It also does not claim the
full founder-live acceptance plan, client-live qualification, or release.
