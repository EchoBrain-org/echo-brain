---
schema_version: 1
id: ADR-0010
kind: decision
title: Disposable related-atom projection V1
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-PERMISSIONS
created_at: 2026-09-01
reviewed_at: 2026-09-01
reviewed_ref: f7018e16232aa11d24f9ecc880943b0bbb8c6ea2
status: accepted
supersedes: []
superseded_by: []
updates:
  - ADR-0007
---

# ADR-0010: Disposable related-atom projection V1

## Context and options

The current retrieval generation ranks individual approved atoms. It has no
stored cross-record relationship, so a result that supplies one useful
decision cannot bring along the later decision, action, or rationale that
explains its consequence. The hand-curated retrieval spike showed that a
small, bounded adjacent-fact expansion materially improves this question
shape, but manually authored links are not a maintainable source of truth.

The canonical Layer 1 record remains the source of truth and remains
deterministic and model-free. This decision considers only a disposable Layer
2 enrichment, not a change to canonical records, policy meaning, or the
request authorization boundary.

## Decision and consequences

The Authority may, while rebuilding a fresh Layer 2 generation, asynchronously
ask the configured structured-generation provider to propose **untyped,
cross-record atom pairs**. It performs that work only after it has captured a
verified Layer 1 snapshot and before it builds and publishes the replacement
generation. It is never run by a user query.

The projector receives only the approved atom IDs, kinds, and text belonging to
one exact visibility segment. Raw transcripts, vendor payloads, live Authority
state, reader identities, and atoms from another policy segment are never
inputs. The Authority validates every proposed pair: endpoints must be distinct
approved atoms from that one segment and different records; model-supplied
supporting excerpts must exactly match their source atom text; duplicate,
self, same-record, malformed, or cross-segment pairs are rejected. The stored
generation retains only the validated endpoint pair, not a relationship label,
model rationale, or excerpt.

Layer 3 remains the only content-release boundary. After normal scoped lexical
retrieval, its answer path may select at most three decision anchors and add a
bounded set of adjacent validated atoms from that same released scope. It then
uses the existing lexical fallback. There is no model call on this query path,
and neither adjacency nor a model proposal grants visibility, binds a Person,
or widens the request-local scope.

Every relationship generation is disposable. A projection-profile, prompt, or
model change creates a new generation contract and rebuild; no migration or
preservation of previous related pairs is required. If projection, validation,
warming, or exact-head recheck fails, the replacement is not published and the
previous pointer is left untouched. Exact-head and contract fences keep serving
fail-closed until a retry builds a new complete generation rather than mutating
the published one.

## Migration, rollback, and evidence

The facts plane moves to a fresh baseline V2. Rollout therefore requires a
clean state reset and rebootstrap before starting this artifact; an existing
baseline-V1 state directory is intentionally rejected rather than migrated in
place. This follows the founder decision that current meeting and derived data
is disposable and can be regenerated.

This decision authorizes one narrow rebuild-time projection and bounded
answer-context expansion. It does not authorize typed relationships, temporal
facts, entities, same-record expansion, graph-wide traversal, graph ranking,
query-time model retrieval, vector search, semantic search, a new policy path,
or a general model/tool surface.

Implementation must prove, with focused tests, exact-segment isolation; no raw
transcript or cross-policy model input; rejection of invalid pairs; bounded
three-anchor expansion; lexical fallback; no projection on an already-current
pointer; and retention of the previous pointer after a failed projection. The
model/profile and projection-release identity must participate in the fresh
generation contract so a configuration change cannot silently reuse an older
relation graph. Acceptance is not deployment, qualification, or a claim that
the projected links are complete or semantically correct.
