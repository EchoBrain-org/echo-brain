---
schema_version: 1
id: ADR-0005
kind: decision
title: Person content-policy v2 lineage
component_ids:
  - CMP-IDENTITY-ACCESS
  - CMP-PERMISSIONS
  - CMP-PROTOCOLS-CRYPTO
created_at: 2026-08-20
reviewed_at: 2026-08-20
reviewed_ref: 3c5a26bcb06853c220a93e3a93c156ea89b0ae68
status: superseded
supersedes: []
superseded_by:
  - ADR-0004
updates:
  - ADR-0002
---

# ADR-0005: Person content-policy v2 lineage

## Disposition

The founder accepted this bounded decision on 2026-08-20 after the candidate
passed the full repository gate. The reviewed commit contains the exact
candidate implementation and tests. Its complete source-file SHA-256 is
`a3e8d47deb97a8bcb876bf0ab627ce461879878a4b002fd0826ef917ac77953f`.

This decision accepts only the two Person content-policy IDs, exact consequence
bytes, closed contract bodies/selectors, and computed digests below. It does
not accept the rest of RFC-0001, ADR-0003, the clean-state reset, a new record
envelope, Person-read audit changes, live activation, compatibility deletion,
or cutover.

## Context and options

The retained `restricted-reviewer-v1` and
`organization-member-readable-v1` contracts bind installation-era
authentication and protocol versions. Editing those bytes in place would
reinterpret existing approvals and records. Keeping them as the new-lineage
contracts would also preserve installation enrollment and lease as the human
authentication root.

The accepted alternative is a versioned policy lineage. The reader sets remain
unchanged in substance; only authentication moves to current Authority Person
sessions. Old v1 bytes keep their historical meaning and cannot cross-admit as
v2.

## Decision and consequences

Accept `restricted-reviewer-person-v2` with:

- exact approving `principal_id` plus exact approving `membership_id` as its
  reader selector;
- current active membership in the record's organization and a current
  Authority Person session as read prerequisites;
- consequence digest
  `sha256:f2d87d2ca6b4892ed9ce166f67120092de639b513fd919e864c0ddf58f253594`;
  and
- contract digest
  `sha256:c0b1676ad1bd2f27d9d781605420beac2e6fd3cd18ffa69f0d18ea62fe48f043`.

Accept `organization-member-readable-person-v2` with:

- every current active owner or employee membership in the record's
  organization, including a later joiner, as its reader selector;
- a current Authority Person session as a read prerequisite;
- consequence digest
  `sha256:2a581951072720b0dfcbbf865cd90132e18421938c9d75dd1c11bb8a1fade2cf`;
  and
- contract digest
  `sha256:7a874f8b8c0bea7fd58066f93e4f4a26f6f6c05bbbdfe45bf2141f0b2f3ff5e3`.

Both contracts expose readable item kinds in the exact order `decision`,
`action`, `rationale`. A policy ID, selector, consequence digest,
authentication literal, item/order, kind, version, missing member, or extra
member substitution denies.

This decision does not make a Person Slack link an approval capability. It does
not merge approval with delivery, change main's delivery fan-out, merge the two
reader sets, or authorize Layer 4.

## Migration, rollback, and evidence

The accepted contracts remain private candidate source until the
installation-free approval, record, and read paths consume them together. They
are not exported from the public protocol package surface and do not alter the
live compatibility runtime.

Evidence at the reviewed commit:

- `packages/organization-protocol/src/person-content-policy-v2.ts` owns the
  exact bodies, consequence bytes, digest functions, and strict validator;
- `packages/organization-protocol/test/person-content-policy-v2.test.ts`
  freezes all four digests and rejects v1, selector, consequence, item-order,
  membership-order, missing, and extra-field substitutions; and
- `npm run check` passed 139 test files and 1,401 tests plus boundary,
  documentation, type checking, and lint.

Rollback before live cutover removes the private v2 candidate and its tests.
After a new-lineage record exists, these bytes are immutable; a change requires
a new policy version and ADR rather than editing this decision or relabeling
stored data.

## Lifecycle update

Superseded on 2026-08-22 by ADR-0004 for the founder-only clean lineage. The
accepted historical policy bytes and rationale above are unchanged, but the
new genesis does not implement either dual Person content-policy branch. It
uses the single current-founder read described by ADR-0004.
