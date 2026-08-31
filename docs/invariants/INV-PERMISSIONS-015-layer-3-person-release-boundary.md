---
schema_version: 1
id: INV-PERMISSIONS-015
kind: invariant
title: Layer 3 is the sole Authority content-release boundary
component_ids:
  - CMP-PERMISSIONS
  - CMP-IDENTITY-ACCESS
  - CMP-ORGANIZATION-AUTHORITY
created_at: 2026-08-22
reviewed_at: 2026-08-23
reviewed_ref: fe78f2c7e11cffaa4b00ec699dfe71f97edfa986
decision_ids:
  - ADR-0006
  - ADR-0007
normative: MUST
enforcement_status: partial
enforcement_scope: Clean V1 current-Person Layer 1 listing and Layer 2 exact-generation search release, plus the Layer 4 request-local release and citation boundary
---

# INV-PERMISSIONS-015: Layer 3 is the sole Authority content-release boundary

## Rule, scope, and rationale

Layer 3 MUST be the sole Authority content-release boundary. No consumer above
Layer 3 may read Layer 1 records or Layer 2 retrieval generations directly.
Layer 4 is only a Layer 3 client: it has no privileged or lower-latency path to
either lower layer, record storage, retrieval storage, or an Authority
database.

A model, agent, adapter, service, or provider identity has no read authority.
It may read only under an authenticated Person principal's scope, with that
Person's active organization membership. An agent has no membership and MUST
never be granted one. Any synthesized answer may cite only atom references
that Layer 3 actually released to that exact caller in that exact request; it
MUST NOT re-retrieve under a different scope, accumulate atoms across requests,
or cite an atom that was not released. A model may propose bounded query text,
but Layer 3 MUST derive all identity and policy facts and execute every query
in the one request under one authenticated Person and one pinned snapshot.

Layer 2 holds content across all policy segments. A consumer that reads it
directly can see every restricted-reviewer record in the organization. This is
the confused-deputy failure that a latency shortcut would create. The rule
prevents provenance, execution identity, provider custody, or service
possession from being mistaken for human permission. It covers clean V1 Layer 1
listing, Layer 2 search, and the single composed Layer 4 `ask` path. It does not
authorize any additional Layer 4 execution path.

## Enforcement and failure behavior

The Authority authenticates and resolves the Person, checks current membership
and the exact content policy, binds Layer 2 to an exact generation and record
head, rechecks the caller at the release fence, commits the minimized response
digest, and only then returns the audited bytes. Missing, stale, mismatched, or
non-Person authority MUST release no content. Search construction MUST NOT be
triggered by a query. Layer 4 is limited to one plan, one Layer 3 batch, and at
most one answer call; it receives no lower-layer handles and may pass citations
only after checking that they are a subset of the batch release. Planner or
answer-model failure, malformed model output, or an invalid citation MUST stop
the request without releasing an answer.

## Verification and change procedure

Focused Authority, retrieval, Person-client, architecture, and clean-runtime
integration tests verify the two policy branches, exact-caller scope, final
fence, audit digest, metadata, rejection non-disclosure, model-free Layer 1
through Layer 3 read closures, bounded Layer 4 calls, one request snapshot,
request-local citation subsets, and answer-audit rows. The source boundary
keeps the Layer 4 root narrow and rejects direct lower-layer imports.
Enforcement remains partial until an exact deployed artifact completes the
two-Person live rehearsal. Any new release path requires an accepted ADR,
explicit enforcement expansion, and negative disclosure tests.
