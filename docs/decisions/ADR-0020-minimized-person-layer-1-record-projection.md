---
schema_version: 1
id: ADR-0020
kind: decision
title: Minimized Person Layer 1 record projection
component_ids:
  - CMP-PERMISSIONS
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-PERSON-CLIENT
created_at: 2026-09-27
reviewed_at: 2026-09-27
reviewed_ref: 83c8eb63aed78ba760678294ecf7fef863743e06
status: proposed
supersedes: []
superseded_by: []
updates:
  - ADR-0012
  - ADR-0017
---

# ADR-0020: Minimized Person Layer 1 record projection

## Disposition

Proposed for the repository owner's decision. Nothing in this record is
implemented. `reviewed_ref` identifies the source examined. The
characterization test
`services/organization-authority/test/person-record-read-disclosure.test.ts`
states the proposed target as two expected-failure cases against the current
route.

## Context and options

`GET /v1/person/records` serves both the Layer 1 list and the exact-digest
read. It releases each authorized record as `position`, `approval_id`,
`record_sha256` and `envelope` (`person-record-read-route.ts`, `asResponse`).
`envelope` is the complete signed V4 envelope, parsed from
`organization_record_log.canonical_envelope` and returned whole
(`person-record-reader-v1.ts`). The record authorization is correct: a reader
receives only records admitted by a current member-readable,
restricted-reviewer or project-audience fact. The defect is what an authorized
record also says about records, projects and people the reader cannot see.

The characterization fixture appends three real signed Slack V2 approvals:
position 1 to two projects, position 2 as the owner's Only me record, and
position 3 to one project. The reader is an employee with a grant on the shared
project only. That reader receives positions 3 and 1, and the response also
carries:

| Field | Location | Disclosure |
| --- | --- | --- |
| `position` 3 and 1 | list item | exactly one hidden append between them |
| `predecessor_position` 2, `predecessor_record_sha256` | envelope body | the hidden record's position and digest |
| `audience_project_ids`, `association_project_ids` | resolution ref and policy consequence | the ID of a project the reader is not a member of |
| `final_approver`, `current_slack_identity_link` | resolution ref | internal approver principal and membership IDs and the approver's Slack user ID |
| `audit_sequence` 3 and 1 | resolution ref | a second global counter, over every private approval outcome |
| `transcript_source` with `share_transcript` false | resolution ref and policy consequence | coordinates of a retained transcript that was not released |
| `source_provenance`, `approved_payload.source` | envelope body | provider adapter instance and external meeting coordinates |

Rejections also consume record-log positions and audit sequences, so these
gaps count rejected approvals as well as records hidden by policy.

This contradicts accepted decisions. ADR-0013 limits project discovery to
current active project members, and it keeps hidden counts and audience
rosters out of project-context results. ADR-0017 brought project audiences to
approved records, and its trace says hidden records expose no title, project
list or count (INV-03 and INV-04). ADR-0012 removed the global append
position, head digest and hidden counts from search and Ask, but Layer 1 was
outside its scope and still returns them. INV-PERMISSIONS-015 makes Layer 3 the
release boundary. Passing the signed envelope through lets the envelope
schema, not a Layer 3 decision, choose the released fields, so a field added to
a future envelope version becomes public by default.

At `reviewed_ref`, the clients use the envelope as follows:

- No Person client, CLI or desktop code verifies an envelope signature,
  recomputes a record digest or checks the predecessor chain. None of that code
  imports an `organization-protocol` verifier. The only client signature check
  is on signed client updates.
- The Person client (`authority-client.ts`, `validatePersonRecordList`)
  requires `position` to be a strictly decreasing positive integer and passes
  the envelope through. `person records` prints the result.
- The desktop host (`product/echo-desktop/src/host/views.ts`, `recordView`)
  reads `envelope.record_sha256`, `body.event.kind`, `body.event.policy_id` and
  `body.event.approved_snapshot.approved_payload.brief`. It checks only that
  `position` is at least 1.
- `person transcript` takes the approval ID and source coordinates from
  command flags. ADR-0017 tells the reader to copy them from the readable
  record, which in practice means the printed envelope.
- Nothing pages by `position`. The route accepts only `limit` and an exact
  `record_sha256`.

A reader who cannot see every record cannot check the predecessor chain in any
case. The chain fields therefore add no verification value for a partial
reader. At most, a reader could verify the signature on each record, and no
client does that today.

Two options were considered:

- **(a) Accept the exposure** as the cost of client-verifiable signed
  envelopes. Keep the V1 shape and record the disclosure as an accepted update
  to ADR-0017. The lifecycle rules forbid rewriting ADR-0017's trace in place.
  This keeps a capability no client uses. It contradicts ADR-0013 and ADR-0017
  for every future project record, and it leaves future envelope fields public
  by default.
- **(b) Return a minimized Layer 1 projection.** Release only the fields that
  clients use and that each reader is entitled to. No client-side verification
  is lost, because none exists.

## Decision and consequences

Proposed: adopt (b).

Layer 1 releases a server-built projection, not the signed envelope. The route
keeps its path, authentication, release recheck and audit. The response
becomes a new versioned kind, `echo-clean-person-record-list-v2`, and follows
ADR-0012: one current shape, with no parallel V1 serialization and no owner
bypass. Each item is an allowlist:

- `approval_id` and `record_sha256`, unchanged. These remain the record's
  identity for exact reads, citations and transcript reads.
- `policy_id` and the approved `brief` from
  `event.approved_snapshot.approved_payload`. Every current V4 record-input
  codec carries both in the same place.
- `audience_project_ids` and `association_project_ids`, each intersected with
  the reader's current grants. These are the grants captured and rechecked by
  the existing release fence. Both come from the append-atomic project fact
  and association tables, not from provider-specific envelope parsing. Both
  lists stay separate, because audience and association are different facts.
- `transcript`: the exact source coordinates, but only when a matching
  transcript grant row exists. Otherwise `transcript` is `null`.
- `source_metadata`, as today: an optional approver display name that the
  server resolves from the full stored envelope.

The projection drops `position`, the envelope, every predecessor field,
`audit_sequence`, approver principal and membership IDs, provider identity
links and subject IDs, command, candidate, card and proof digests, source and
processor provenance, and signatures. Order is newest first, as the array
order already is. A new field is released only by amending this allowlist.

Consequences:

- Exact reads, citations and transcript reads keep working. Transcript
  coordinates become visible only where they are usable.
- The desktop reads `policy_id` and `brief` from the item. The top-level
  `record_sha256` check replaces `envelope.record_sha256`.
- The Person client validates the new exact shape. Order checks rely on
  response order, not on `position`.
- Signed envelopes, receipts and the record log are unchanged. Signed-envelope
  inspection remains server-side operator evidence, as ADR-0012 already
  requires for qualification.
- Out of scope: client-verifiable projections, such as a signed per-reader
  projection or selective-disclosure commitments. They need their own ADR if
  a client ever needs to verify offline.

## Migration, rollback, and evidence

There is no database migration. The projection is computed at read time from
existing immutable rows and facts. The server, Person client and desktop
change together. An old client fails closed on the new kind until the matching
client is installed, as ADR-0012 requires, and the change goes through a
coordinated candidate and release review. Rollback is a code revert with no
data change.

Implementation must:

- remove `.fails` from both characterization cases;
- add negative disclosure tests for non-member project IDs, log coordinates,
  audit sequence, provider subject IDs and ungranted transcript coordinates,
  each with owner and employee readers;
- update the route, Authority runtime, Person client and desktop fixtures that
  currently pin the envelope passthrough; and
- expand the INV-PERMISSIONS-015 enforcement scope to name the minimized
  Layer 1 projection.

If the owner chooses (a), a separate accepted ADR records the disclosure as an
update to ADR-0017, and the expected-failure cases become explicit
accepted-exposure pins.
