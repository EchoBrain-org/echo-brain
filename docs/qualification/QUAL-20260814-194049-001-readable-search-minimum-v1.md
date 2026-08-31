---
schema_version: 1
id: QUAL-20260814-194049-001
kind: qualification
title: Readable-search Layers 1-3 minimum-V1 founder-live qualification
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-IDENTITY-ACCESS
  - CMP-PERMISSIONS
  - CMP-OPERATIONS-RELEASE
created_at: 2026-08-14
reviewed_at: 2026-08-14
reviewed_ref: 83819a57fd8635384d14d3cc8d591e8f76ad1260
run_status: completed
result: passed
stop_reason: not-applicable
source_commit: 83819a57fd8635384d14d3cc8d591e8f76ad1260
artifact_digest: sha256:846e3eba4342e83852405ee48e3574e43be0bac24067453ae00c79c41920b8da
configuration_identity: opaque:CONFIG-LAYER-123-MINIMUM-V1-001
state_identity: sha256:dbabe02ea7de06d154b8b4f0f488353672a71d2f5384b91e493de5ce3b2fa0b1
started_at: 2026-08-14T16:59:27.000Z
completed_at: 2026-08-14T19:40:49.456Z
matrix_id: QMAT-READABLE-SEARCH-MINIMUM-V1-001
matrix_version: 1
assertion_ids:
  - RSMV1-001
  - RSMV1-002
  - RSMV1-003
  - RSMV1-004
  - RSMV1-005
  - RSMV1-006
  - RSMV1-007
  - RSMV1-008
  - RSMV1-009
  - RSMV1-010
  - RSMV1-011
  - RSMV1-012
  - RSMV1-013
  - RSMV1-014
  - RSMV1-015
  - RSMV1-016
  - RSMV1-017
  - RSMV1-018
evidence_ids:
  - EVID-LAYER-123-MINIMUM-V1-001
---

# Readable-search Layers 1-3 minimum-V1 founder-live qualification

## Scope and exact identities

This run qualifies the minimum-V1 permission-aware lexical readable-search
path across canonical Layer 1 records and policy facts, immutable Layer 2
generations, and Layer 3 current-Person authorization, final fencing, and
minimized audit.

The exact source and Authority image are recorded in front matter. Both live
reader profiles on the Mac used product package `0.1.0-internal.6` built from
the same source,
with package digest
`sha256:a77d45b77143cee866e274bca400590f59dc751a3934979f0f295c5cfb14b7cc`.
The qualified generation is the `state_identity` above, with manifest
`sha256:862fe959a6996f2fad99b151bea18bf0cdf971c77e7f07be097653d82f9f7a30`
at record head position 4 and record hash
`sha256:407a4ca9d42cf7efa65925c3b02ec986193f61b382463f65eee72ffd61c1558b`.
The temporal Person states and exact configuration bindings resolve only
through `EVID-LAYER-123-MINIMUM-V1-001`.

This matrix intentionally combines three proof modes. Exact-source CI run
`31820922331` proves the source and boundary rows; the stopped checkpoint,
rebuild, exact-version archive, and no-network restored-copy chain proves the
restore row; and the deployed founder-live run proves the operational reader
row. A passed result does not mean every assertion was exercised live.

## Assertion results

| Assertion | Outcome | Proof mode | Evidence |
| --- | --- | --- | --- |
| `RSMV1-001` | passed | exact-source CI | `EVID-LAYER-123-MINIMUM-V1-001` |
| `RSMV1-002` | passed | exact-source CI | `EVID-LAYER-123-MINIMUM-V1-001` |
| `RSMV1-003` | passed | exact-source CI | `EVID-LAYER-123-MINIMUM-V1-001` |
| `RSMV1-004` | passed | exact-source CI plus later-member and revocation live evidence | `EVID-LAYER-123-MINIMUM-V1-001` |
| `RSMV1-005` | passed | exact-source CI plus live pre-retrieval denial audit | `EVID-LAYER-123-MINIMUM-V1-001` |
| `RSMV1-006` | passed | exact-source CI plus scoped live reads | `EVID-LAYER-123-MINIMUM-V1-001` |
| `RSMV1-007` | passed | exact-source CI | `EVID-LAYER-123-MINIMUM-V1-001` |
| `RSMV1-008` | passed | exact-source CI | `EVID-LAYER-123-MINIMUM-V1-001` |
| `RSMV1-009` | passed | exact-source CI | `EVID-LAYER-123-MINIMUM-V1-001` |
| `RSMV1-010` | passed | exact-source CI plus stopped verifier and restored-copy evidence | `EVID-LAYER-123-MINIMUM-V1-001` |
| `RSMV1-011` | passed | exact-source CI | `EVID-LAYER-123-MINIMUM-V1-001` |
| `RSMV1-012` | passed | exact-source CI plus no-network restored-copy drill | `EVID-LAYER-123-MINIMUM-V1-001` |
| `RSMV1-013` | passed | exact-source CI plus live revocation fence | `EVID-LAYER-123-MINIMUM-V1-001` |
| `RSMV1-014` | passed | exact-source CI plus minimized live audits and no-store edge probes | `EVID-LAYER-123-MINIMUM-V1-001` |
| `RSMV1-015` | passed | ordered stopped checkpoint, exact-version verification, restore drill, and cutover reconciliation | `EVID-LAYER-123-MINIMUM-V1-001` |
| `RSMV1-016` | passed | exact-source CI boundary suite | `EVID-LAYER-123-MINIMUM-V1-001` |
| `RSMV1-017` | passed | exact-source CI plus exact-image cutover | `EVID-LAYER-123-MINIMUM-V1-001` |
| `RSMV1-018` | passed | exact-source CI plus stopped rebuild and deployed founder-live lifecycle | `EVID-LAYER-123-MINIMUM-V1-001` |

## Founder-live result

The exact owner/reviewer installation read one real
`restricted-reviewer-v1` item and, in a separate signed request, one real
`organization-member-readable-v1` item. Both central audits bind the response
to the exact generation, manifest, and record head without retaining query,
term, text, or segment fields.

A distinct principal, membership, enrollment, and installation created after
the organization-readable record was approved read only the organization
policy result. Revoking that temporary membership caused its next signed read
to return the fixed no-store denial before any retrieval scope or result was
recorded, while the primary owner remained readable.

The restore qualification comes from the complete ordered evidence chain.
The frozen restore-drill receipt was deliberately emitted before external
exact-version verification and therefore retained a pending restore flag; the
later operator verification and cutover reconciliation close that gate
without rewriting the frozen receipt.

## Non-claims

- `RSMV1-011` is exact-source and CI tested. This run did not execute a new
  exact-`83819a5` live append-to-stale-head cycle.
- The later member did not issue a matching reviewer-term negative query
  before revocation. Reviewer-segment noninterference is established by the
  exact-source physical-isolation tests plus the live organization-only
  result, not by a separate live empty-result probe.
- The temporary identity was logically separate but used the same human
  operator, Mac, Granola account, and Slack account. It was intentionally not
  Slack-linked.
- The no-network restore was an isolated recovery drill, not a production
  rollback after functional traffic.
- The live profiles used foreground commands; their LaunchAgents were not
  part of this founder-live run.
- The qualification is founder-live minimum V1 only. It is not client-live,
  customer-released, a generic ACL or ReBAC system, vector search, a latency
  guarantee, a timing-side-channel guarantee, or broad retrieval-quality
  evidence.
- This documentation-only record does not create a new binary live candidate.
