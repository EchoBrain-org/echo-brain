---
schema_version: 1
id: ADR-0028
kind: decision
title: Layer 1 holds the people directory, signed record log and source captures
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-PERMISSIONS
created_at: 2026-10-02
reviewed_at: 2026-10-02
reviewed_ref: 8998a5ac6ca71e755b2b8159bdc5eddeb405a971
status: proposed
supersedes: []
superseded_by: []
updates:
  - ADR-0006
  - ADR-0010
  - ADR-0013
  - ADR-0024
  - INV-PERMISSIONS-015
  - INV-IDENTITY-005
---

# ADR-0028: Layer 1 holds the people directory, signed record log and source captures

This is a proposal awaiting founder acceptance. The founder chose the broadened
Layer 1 on 2026-10-02. No accepted record is edited by this proposal; the
wording changes below apply only on acceptance. It changes no code, wire
schema, SQL baseline or release path.

## Context and options

Accepted records use "Layer 1" for the signed, append-only organization record:
the "canonical Layer 1 record" of
[ADR-0010](ADR-0010-disposable-related-atom-projection-v1.md), the "Layer 1
listing" of [ADR-0006](ADR-0006-permission-aware-clean-v1-completion.md), the
"Layer 1 exact read" of
[ADR-0024](ADR-0024-person-list-open-and-mine-scope.md), and "Layer 1 records"
in
[INV-PERMISSIONS-015](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md).

The [context intake foundation](../product/2026-10-01-context-intake-foundation-v1-design.md)
retains immutable source captures (`echo-context-capture-v1`) through the
[ADR-0014](ADR-0014-unified-source-ingestion-and-document-custody.md) source
custody tables, and calls them Layer 1. Without a record, the same name covers
two different things.

- **A. Keep Layer 1 narrow.** Call captures ADR-0014 source custody. Rejected
  by the founder: captures are durable organization context of the same
  standing as the directory and the record log, not a side table.
- **B. Broaden Layer 1.** Name captures as a part of Layer 1 and qualify every
  existing use that means only the signed record. Proposed.

## Decision and consequences

Logical Layer 1 is the Authority's durable, authoritative organization state.
It has three separately owned parts:

1. **The people directory** of
   [ADR-0016](ADR-0016-organization-people-directory.md): membership and
   verified identity links.
2. **The signed record log**: the append-only human-act records, including
   final approvals and their policy facts. An unqualified "Layer 1 record"
   means a record in this log.
3. **Source captures**: retained `echo-context-capture-v1` revisions admitted
   through an Authority-selected retention binding. They are immutable.

Captures are source observations, never approved facts. Their truth status is
always `source_observation`, including a decision-shaped source; only the signed
record log holds approval. Actor labels and mentions in a capture create no
person, membership or identity link. Captures change no directory entry and
append no record.

Sharing ADR-0014's custody tables does not make other custody rows captures.
Person originals keep the
[ADR-0013](ADR-0013-project-context-v1-contract.md) and
[ADR-0015](ADR-0015-global-and-project-scoped-person-ask.md) boundary, and
admitted meeting revisions keep the pending-approval boundary until a signed
record admits them.

No current path releases a capture. Layer 2 builds only from signed records,
Layer 3 releases no capture, and Layer 4 reads neither. A consumer that reads
captures, including graph projection, retrieval, the Evidence Desk or Ask,
needs its own accepted ADR and an extension of INV-PERMISSIONS-015's
enforcement scope. Retention, expiry and erasure of captures remain the open
decisions recorded in the foundation design.

[ADR-0007](ADR-0007-lean-layer-4-answer-composition-v1.md) needs no change: its
Layer 1 statements already hold for captures.

### Wording changes on acceptance

Each change qualifies "Layer 1" as the signed record log and leaves every
decision unchanged. README rule 3 protects accepted rationale. Acceptance of
this record must therefore either authorize these terminology-only edits to
ADR-0006, ADR-0010, ADR-0013 and ADR-0024, or leave those records as written
and rely on the definition above, where an unqualified "Layer 1 record" means
the signed log. The invariant edits apply in either case.

| Record | Current wording | Wording on acceptance |
| --- | --- | --- |
| ADR-0006, Decision | "permission-aware Layer 1 through Layer 3 reads" | "permission-aware Layer 1 record through Layer 3 reads" |
| ADR-0006, Decision | "Layer 1 listing and Layer 2 search" | "Layer 1 record listing and Layer 2 search" |
| ADR-0010, Context | "The canonical Layer 1 record remains the source of truth" | "The canonical signed Layer 1 record remains the source of truth" |
| ADR-0010, Decision | "a verified Layer 1 snapshot" | "a verified Layer 1 record snapshot" |
| ADR-0013, Constraints | "it does not extend Layer 1/2/3 approved-record retrieval or Layer 4 Ask." | "it does not extend Layer 1 signed-record, Layer 2 or Layer 3 approved-record retrieval or Layer 4 Ask. Person originals are not Layer 1 source captures." |
| ADR-0024, open | "Meetings go through the Layer 1 exact read" | "Meetings go through the Layer 1 exact record read" |
| ADR-0024, open | "after the meeting passes the same Layer 1 exact read" | "after the meeting passes the same Layer 1 exact record read" |
| INV-PERMISSIONS-015, `enforcement_scope` | "Current-Person Layer 1 listing" | "Current-Person Layer 1 record listing" |
| INV-PERMISSIONS-015, Rule | "No consumer above Layer 3 may read Layer 1 records or Layer 2 retrieval generations directly." | "No consumer above Layer 3 may read Layer 1 signed records, Layer 1 source captures or Layer 2 retrieval generations directly. No current path releases a Layer 1 source capture; a new one requires an accepted ADR and an extension of this enforcement scope." |
| INV-PERMISSIONS-015, Rule | "It covers clean V1 Layer 1 listing" | "It covers clean V1 Layer 1 record listing" |
| INV-PERMISSIONS-015, Enforcement | "or the Layer 1 exact read (open)" | "or the Layer 1 exact record read (open)" |
| INV-PERMISSIONS-015, Verification | "model-free Layer 1 and query-serving Layer 3 closures" | "model-free Layer 1 record and query-serving Layer 3 closures" |
| INV-IDENTITY-005, `enforcement_scope` | "two-policy Layer 1 and Layer 2 retrieval" | "two-policy Layer 1 record and Layer 2 retrieval" |
| INV-IDENTITY-005, Rule | "Once Layer 1 admits the act" | "Once the Layer 1 record log admits the act" |

On acceptance, the foundation design's "Logical Layer 1 and ownership" section
cites this record as its source, and the invariants' `decision_ids` gain
ADR-0028.

## Migration, rollback, and evidence

There is no migration. The decision is vocabulary over existing storage:
`SqliteContextCaptureStoreV1` already admits captures through
`SqliteSourceAdmissionStoreV1` into `authority_sources_v1`,
`authority_source_revisions_v1` and `authority_source_contents_v1`, and no
SQL baseline or release path changes. Rejecting this proposal restores option
A: the foundation design then names captures ADR-0014 source custody and drops
"Logical Layer 1".

Evidence is source-only: the
[shared intake tests](../../services/organization-authority/test/context-intake-v1.test.ts)
prove the capture contract and its atomic retention fence, and the architecture
boundary keeps the Layer 4 root free of lower-layer imports. Nothing is deployed
or qualified by this record.
