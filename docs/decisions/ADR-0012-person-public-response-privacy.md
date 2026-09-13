---
schema_version: 1
id: ADR-0012
kind: decision
title: Person public response privacy and internal release witnesses
component_ids:
  - CMP-PERMISSIONS
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-IDENTITY-ACCESS
created_at: 2026-09-13
reviewed_at: 2026-09-13
reviewed_ref: 7e49c3dea153b3860bd468546ac9d55fcd0da19b
status: proposed
supersedes: []
superseded_by: []
updates:
  - ADR-0006
  - ADR-0007
---

# ADR-0012: Person public response privacy and internal release witnesses

## Disposition

Proposed for explicit contract review. The Person contract sprint authorizes
implementation and offline proof of this proposal, not acceptance or release.
ADR-0006 remains accepted and its historical rationale is unchanged. Accepting
this proposal would replace only its requirement to publish global generation
and record-head identity in ordinary Person search/Ask responses. Its exact
internal freshness, authorization and audit requirements remain in force.

## Replacement contract

Use one current V2 search/Ask response shape, on the existing routes, for every
Person. Search returns schema/kind and authorized items; Ask returns schema/kind,
answer, authorized citations and the optional bounded authorship outcome. Neither
returns generation ID, global append position, global head digest, hidden counts,
or an opaque substitute that changes with hidden activity. No owner-only bypass
or caller-selectable scope is introduced. Authorized record/atom references
remain available for citations and exact authorized reads.

The server pins and retains generation, manifest, retrieval contract and exact
record head in its existing route-local release witness. Layer 4 obtains those
facts from that witness, never from a public projection. Final Person and snapshot
revalidation is unchanged. The existing audit writer commits the canonical bytes
actually returned; answer auditing separately retains the exact internal release
witness. There is no database migration, new evidence endpoint or audit store.

Server, TypeScript client, Swift decoder and repository evaluation consumers
change together. The minimum matching Person client is the first artifact that
supports `echo-clean-person-record-search-v2` and `echo-clean-person-answer-v2`;
qualification must bind its materialized source SHA and exact tarball digest,
not infer compatibility from the reused product version. Older public metadata
serialization/decoding and Ask outcome negotiation are retired, not kept as a
parallel protocol. An old client fails closed until the matching client is
installed. A coordinated candidate and explicit release review are required.

## Exact qualification without public global metadata

Offline Authority evaluations already own their fixture database, pinned
release witnesses and audit rows; compare those internal witnesses and the
exact public response digest. Live operators use existing authorized release
receipts and server-side journey/audit evidence. Employee captures contain only
public responses and their own client provenance. Bind correlated server evidence
separately under the existing operator boundary; mark serving identity or snapshot
unknown when that evidence is absent. A client SHA, owner result or globally
changing opaque token cannot substitute for serving-Authority evidence.

## Answer contract refinement

ADR-0007's one planner, one released batch and at most one answer call remain.
For model output, propose `{ "answer": null }` for abstention, with standard
insufficient-evidence text rendered by the application. Otherwise `answer` is
an object with nonempty `text` and nonempty request-local `citations`. The schema
and parser reject extra fields; the redundant model-authored status is retired.
This removes independently generated status/text/citation combinations. Malformed abstention, substantive text marked
insufficient, missing/duplicate/unreleased citations and contradictory claims
remain failures; no repair retry or outage-to-abstention conversion is authorized.

## Proof and release gate

Whole-response employee regressions include a restricted latest record and
empty results. Preserve owner/employee content controls, stale-head rejection,
final authorization, audit failure and exact returned-response digest tests.
Native decoders and exact client artifacts must pass offline checks. Decision
acceptance and exact-candidate employee repetitions plus owner controls remain
human/live qualification work before deployment.
