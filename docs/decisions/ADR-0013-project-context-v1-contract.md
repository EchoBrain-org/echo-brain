---
schema_version: 1
id: ADR-0013
kind: decision
title: Project context V1 contract
component_ids:
  - CMP-PERMISSIONS
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-IDENTITY-ACCESS
  - CMP-PERSON-CLIENT
  - CMP-PROTOCOLS-CRYPTO
created_at: 2026-09-21
reviewed_at: 2026-09-21
reviewed_ref: 9f28656b4cc39731ae593dd86825ac51b7978cb2
status: accepted
supersedes: []
superseded_by: []
updates:
  - ADR-0006
  - ADR-0007
  - ADR-0012
---

# ADR-0013: Project context V1 contract

## Disposition

The founder accepted the minimum-V1 policy defaults on 2026-09-21 while
directing PC-00 implementation. This accepts the project-context contract
design only. It does not state that its codecs, ports, persistence, routes,
CLI, native UI, schema, reset/reseed, staging candidate, or production release
exists or is approved.

`reviewed_ref` identifies the starting desktop/UI worktree examined when the
contract was selected. It is not an implementation claim for this decision.
PC-00 may add codecs and application/repository interfaces. PC-01 through
PC-06 remain responsible for persistence, authorization behavior, routes,
clients, integration proof, and separately authorized environment work.

## Context

The current Person upload path preserves an authenticated member's original
text with an immutable `only_me` or `team` selection. It supports immediate
authorized read/search and optional later search enrichment, but it has no
project identity, project membership, project audience, project-scoped feed,
or original-to-project association. The installed Projects UI labels those
controls unavailable rather than fabricating a server capability.

Association, audience, and retrieval scope are different facts. An association
only says where an original appears. An audience decides who may read it.
Retrieval scope selects candidates and cannot override source audience. Prior
planning left membership tenure, history, lead departure, association cardinality
and uploader/removal policy open. Those choices must be closed before a fresh
schema and parallel client/server implementation can safely begin.

The current original upload path is not a meeting source and does not create a
decision candidate, Slack approval, signed record, or Ask evidence. Its worker
shares an Authority lifecycle with meeting processing but the source custody,
processing and publication contracts remain distinct.

## Decision

V1 introduces one project-context capability for Person-uploaded text originals.
The founder explicitly accepted these minimum-V1 defaults:

- Any active organization member can create a project and becomes its first
  lead. Project discovery is limited to current active project members.
- A project member can read prior associated context after joining, but every
  original still passes its own current immutable-audience authorization.
- Leads manage project membership.
- One original has zero or one project association. A private original remains
  private after association.

PC-00 selects the following reviewable mechanics to implement those defaults:

- Project grants bind the exact organization, principal, and membership tenure.
  A rejoined person receives a new project grant rather than inheriting one.
- Projects may have multiple leads. A voluntary last-lead removal or demotion
  conflicts. Organization membership revocation always wins, even when it
  leaves a project leadless; no owner or private-content bypass is created.
- A second association conflicts; the caller explicitly dissociates before
  associating another project. Association never copies, moves, or rewrites the
  source.
- An upload has an immutable `only_me`, `team`, or `project` audience. A
  `project` audience names exactly one audience project. Its mandatory root
  `project_id` association coordinate is independently a project ID or `null`.
  It may equal the audience project, but never changes the audience decision.
- The uploader may associate an original only when it can currently read the
  original and is an active member of the target project. The uploader or an
  active target-project lead may remove an association only when it can
  currently read that original. These rules prevent hidden-original enumeration.
- An uploader removed from an audience project loses content access through
  that project. Its existing account-scoped receipt remains minimally readable
  without revealing original content.

The new public wire families are `/v1/person/projects` and
`/v2/person/updates`. The existing `/v1/person/updates` codecs remain
byte-for-byte strict and reject project fields. Fresh runtime data is selected
for this sprint: there is no migration/backfill, legacy database compatibility,
or V1 reinterpretation requirement. Ordinary startup must still verify the
new exact schema and must never reset state implicitly.

Project authorization is server-owned. It uses the existing Person session and
current organization membership plus a private project authorization snapshot.
Admission and release recheck the current project/source authorization before
bytes are returned, then commit the minimized audit witness. The snapshot or
authorization revision is never a session claim or public response field.
Inaccessible and nonexistent original/project coordinates share a
non-disclosing public result. Public results also omit hidden counts, audience
rosters and any globally changing authorization token.

Enrichment is eligible only while the uploader's organization tenure remains
active and, for a project audience, while the uploader remains an active member
of that audience project. Eligibility is rechecked before model handoff. It
cannot change original bytes, audience, project association, membership or
leadership. No new worker, scheduler, model policy, provider contract, or
meeting/approval flow is authorized.

## Constraints and non-goals

This decision defines the direct original upload/read/search project boundary;
it does not extend Layer 1/2/3 approved-record retrieval or Layer 4 Ask.
Project-scoped Ask, original evidence/citations, approved-record association,
named readers, unread counts, audience edits, withdrawal, automatic routing,
and binary attachments require later accepted designs. A project cannot be
encoded into a global Ask question as a substitute.

`INV-PERMISSIONS-015` continues to govern approved-record and Ask release
paths. V1's original read/search extension adds no bypass to those layers. It
must preserve the existing original-upload path's equivalent requirements:
current authenticated Person authorization, non-disclosing denial, final
authorization fence, and minimized release audit. PC-02 and PC-06 must make
that expansion explicit in implementation and negative disclosure proof; this
decision does not change the invariant's normative wording or enforcement
status.

The full frozen object shapes, error behavior, port boundary and required
fixtures are in the [PC-00 contract](../product/2026-09-21-project-context-v1-contract.md).
The [sprint](../product/2026-09-21-project-context-sprint-v1.md) assigns the
remaining file ownership and integration gates.

## Consequences and proof

PC-00 codecs must reject unknown fields and invalid audience combinations. V2
replay identity includes title, text, audience and root association coordinate;
matching retries reconcile one receipt and any semantic change conflicts. PC-01
must reject cross-organization relationships and preserve the selected new-data
semantics across restart. PC-02 must prove project removal between candidate
selection and release withholds all original metadata and bytes. PC-03 through
PC-05 must expose only the strict fixture-backed public contract. `projects
list` is the sole capability probe: only its `404 not_found` renders “Not live
yet.” An unmatched individual route or uncertain mutation is not proof that no
mutation occurred and cannot trigger a project-to-team fallback.

PC-06 must prove overlapping/disjoint projects, current-tenure rejoin, private
association, cross-project misuse, last-lead behavior, replay/restart, optional
enrichment failure, no disclosure on denied reads/search/feed, and matched
server/client artifacts. Its reset/reseed work is separate from this design
decision and requires the existing operator lane.
