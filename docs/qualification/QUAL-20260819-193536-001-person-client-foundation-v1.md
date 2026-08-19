---
schema_version: 1
id: QUAL-20260819-193536-001
kind: qualification
title: Person-client minimum lean V1 founder-live foundation qualification
component_ids:
  - CMP-IDENTITY-ACCESS
  - CMP-OPERATIONS-RELEASE
created_at: 2026-08-19
reviewed_at: 2026-08-19
reviewed_ref: 70062802fc938441151af0e9bf4dfbc09fbb1eda
run_status: completed
result: passed
stop_reason: not-applicable
source_commit: 70062802fc938441151af0e9bf4dfbc09fbb1eda
artifact_digest: sha256:7f7b19bef6e2ab5efdc853d662a82653c453c0db33cf941c53b72d2a56183017
configuration_identity: opaque:AUTH-FOUNDATION-PRODUCTION-20260819
state_identity: opaque:PERSON-SESSION-STATE-20260819-001
started_at: 2026-08-19T19:32:54Z
completed_at: 2026-08-19T19:35:36Z
matrix_id: QMAT-PERSON-CLIENT-FOUNDATION-V1-001
matrix_version: 1
assertion_ids:
  - PCFV1-001
  - PCFV1-002
  - PCFV1-003
  - PCFV1-004
  - PCFV1-005
  - PCFV1-006
  - PCFV1-007
  - PCFV1-008
evidence_ids:
  - EVID-PERSON-CLIENT-FOUNDATION-001
---

# Person-client minimum lean V1 founder-live foundation qualification

## Scope, identities, and preconditions

The exact source and artifact in front matter were tested on the founder-live
machine with Node `22.22.1` and npm `10.9.4`. The existing default product was
not replaced. The live action was one Person session refresh; no content read,
meeting batch, product daemon, or client cutover was part of this run.

| Assertion | Outcome | Evidence |
| --- | --- | --- |
| `PCFV1-001` | passed | `EVID-PERSON-CLIENT-FOUNDATION-001` |
| `PCFV1-002` | passed | `EVID-PERSON-CLIENT-FOUNDATION-001` |
| `PCFV1-003` | passed | `EVID-PERSON-CLIENT-FOUNDATION-001` |
| `PCFV1-004` | passed | `EVID-PERSON-CLIENT-FOUNDATION-001` |
| `PCFV1-005` | passed | `EVID-PERSON-CLIENT-FOUNDATION-001` |
| `PCFV1-006` | passed | `EVID-PERSON-CLIENT-FOUNDATION-001` |
| `PCFV1-007` | passed | `EVID-PERSON-CLIENT-FOUNDATION-001` |
| `PCFV1-008` | passed | `EVID-PERSON-CLIENT-FOUNDATION-001` |

## Result and non-claims

This exact artifact is `founder-live-qualified` for the minimum lean V1 auth
and packaging foundation. It is not the default product, client-live
qualified, or released. Real meeting-batch testing remains the next distinct
stage.
