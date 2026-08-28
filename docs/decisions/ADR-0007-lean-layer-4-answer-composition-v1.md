---
schema_version: 1
id: ADR-0007
kind: decision
title: Lean Layer 4 answer composition V1
component_ids:
  - CMP-ADAPTERS
  - CMP-PERMISSIONS
  - CMP-IDENTITY-ACCESS
  - CMP-CENTRAL-ORGANIZATION
created_at: 2026-08-23
reviewed_at: 2026-08-23
reviewed_ref: fe78f2c7e11cffaa4b00ec699dfe71f97edfa986
status: accepted
supersedes: []
superseded_by: []
updates:
  - ADR-0006
---

# ADR-0007: Lean Layer 4 answer composition V1

## Context

[Issue #59](https://github.com/EchoBrain-org/echo-brain/issues/59) is the
first bounded answer-composition capability. A single Layer 3 search of the
verbatim question is insufficient for terminology mismatch and multi-part
questions. It must improve retrieval intent without giving a model, provider,
or service identity any independent read authority.

ADR-0006 deliberately excluded Layer 4 until this narrower contract was
accepted. It continues to govern the clean current-only lineage, V4 canonical
bytes, record and retrieval contracts, Person authentication, content policy,
and the single immutable read-audit table.

## Decision

Lean V1 authorizes exactly one request-shaped path:

1. One authenticated Person asks one question.
2. One planner model call proposes no more than three focused queries; the
   application places the original question first.
3. Planner failure or malformed planner output terminates the request before
   retrieval, answer composition, or audit; there is no literal-query fallback.
4. Layer 3 executes that one batch under the authenticated Person's derived
   scope, with one exact Layer 2 generation and one Layer 1 record head.
5. If the batch contains usable atoms, one answer model call receives only
   those released atoms. An empty batch returns a fixed insufficient-evidence
   answer without a pointless model call.
6. Each returned citation is an atom reference from that exact released set.

The planner's queries are untrusted search intent. They do not carry, choose,
or widen the caller identity, membership, policy, segment, generation, record
head, or release decision. Layer 4 does not read Layer 1, Layer 2, record
storage, retrieval storage, or an Authority database directly. Layer 3
authenticates, pins the snapshot, performs retrieval, applies policy, makes
the final release decision, and supplies the release-bounded atoms.

The existing immutable Person read-audit table is the only audit storage.
An answer-composition row may use its existing constrained discriminator and
prompt and answer hashes. No new audit table, trace store, retention product,
or compatibility schema is authorized.

OpenRouter requests must require support for every requested parameter and
exclude providers that advertise data collection. This does not grant the
provider any identity or read authority; it receives only the atoms Layer 3
released for the authenticated Person's request.

## Explicit exclusions

This decision does not authorize agents, tools, memory, cross-request context
accumulation, iterative or self-directed retrieval, vector or hybrid search,
reranking, streaming, a user interface, a new workspace or package, or a
change to V4 canonical bytes. It does not authorize a model to call arbitrary
services, perform a second retrieval under another scope, or cite any atom not
released in the request.

If the one released batch is insufficient, the answer must say so. A later
decision and evidence from real question evaluations are required before
adding a retrieval refinement round or changing Layer 2 retrieval behavior.

## Consequences and verification

The implementation has a bounded, at-most-two-call model budget and one
permission-aware retrieval snapshot per request. Layer 4 may choose search
phrases but cannot become a privileged retrieval path. Architecture tests keep
the actual Layer 1 through Layer 3 read and search modules model-free, forbid
Layer 4 imports of lower-layer record, retrieval, or storage modules, and
limit `answer_composition` handling to the declared answer path and its single
audit writer. Boundary rules keep the prospective answer-composition source
root narrow.

Acceptance authorizes implementation only. It is not a release, deployment,
qualification result, or claim that model answers are complete or semantically
correct. The mechanically enforceable claim is narrower: the cited atom IDs
are a subset of the exact atoms Layer 3 released to that authenticated Person
for that request.
