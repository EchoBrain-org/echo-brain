---
schema_version: 1
id: QMAT-JOB-B-ACTIVE-MEMBER-001
kind: qualification-matrix
title: Job B active-member readable-search matrix
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-IDENTITY-ACCESS
  - CMP-PERMISSIONS
  - CMP-OPERATIONS-RELEASE
created_at: 2026-08-14
reviewed_at: 2026-08-14
reviewed_ref: 83819a57fd8635384d14d3cc8d591e8f76ad1260
matrix_version: 1
assertion_ids:
  - JOB-B-ACTIVE-001
  - JOB-B-ACTIVE-002
  - JOB-B-ACTIVE-003
  - JOB-B-ACTIVE-004
  - JOB-B-ACTIVE-005
  - JOB-B-ACTIVE-006
  - JOB-B-ACTIVE-007
qualification_ids:
  - QUAL-20260814-050326-001
---

# Job B active-member readable-search matrix V1

This matrix covers the everyday permission-aware retrieval path for content
approved as organization-member-readable and callers whose owner or employee
membership is currently active.

| Assertion ID | Assertion |
| --- | --- |
| `JOB-B-ACTIVE-001` | A schema-V3 approval appends one organization-member-readable record and its exact policy facts. |
| `JOB-B-ACTIVE-002` | Before a rebuild, readable search rejects the advanced record head with a no-store unavailable response. |
| `JOB-B-ACTIVE-003` | A stopped rebuild and verifier bind one readable generation to the exact advanced record head. |
| `JOB-B-ACTIVE-004` | The approving active owner can retrieve the approved item through the signed readable-search path. |
| `JOB-B-ACTIVE-005` | A different active employee installation can retrieve the same policy-scoped item. |
| `JOB-B-ACTIVE-006` | Central query audit binds the employee allow to the exact generation, record head, result count, and policy ID. |
| `JOB-B-ACTIVE-007` | The split product and Authority candidate identities, private topology, public recovery, and no-store probes remain exact. |

This V1 matrix does not cover a membership created after approval or denial
after membership revocation. Those require a temporary test identity and a
separate qualification run; this matrix and its immutable report do not inherit
that broader scope.
