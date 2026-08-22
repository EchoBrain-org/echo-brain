---
schema_version: 1
id: INV-PERMISSIONS-015
kind: invariant
title: Layer 3 is the sole Authority content-release boundary
component_ids:
  - CMP-PERMISSIONS
  - CMP-IDENTITY-ACCESS
  - CMP-CENTRAL-ORGANIZATION
created_at: 2026-08-22
reviewed_at: 2026-08-22
reviewed_ref: 815c41c7549a3985d1b30573bd3aabd997cfb9b1
decision_ids:
  - ADR-0006
normative: MUST
enforcement_status: partial
enforcement_scope: Clean V1 current-Person Layer 3 record listing and exact-generation search release
---

# INV-PERMISSIONS-015: Layer 3 is the sole Authority content-release boundary

## Rule, scope, and rationale

Layer 3 MUST be the sole Authority content-release boundary. No consumer above
Layer 3 may read Layer 1 records or Layer 2 retrieval generations directly. A
future Layer 4 is only a Layer 3 client: it has no privileged or lower-latency
path to either lower layer.

A model, agent, adapter, service, or provider identity has no read authority.
It may read only under an authenticated Person principal's scope, with that
Person's active organization membership. An agent has no membership and MUST
never be granted one. Any future synthesized answer may cite only atom
references that Layer 3 actually released to that exact caller in that exact
request; it MUST NOT re-retrieve under a different scope, accumulate atoms
across requests, or cite an atom that was not released.

Layer 2 holds content across all policy segments. A consumer that reads it
directly can see every restricted-reviewer record in the organization. This is
the confused-deputy failure that a latency shortcut would create. The rule
prevents provenance, execution identity, provider custody, or service
possession from being mistaken for human permission. It covers clean V1 Layer 1
listing and Layer 2 search. It does not authorize Layer 4 execution.

## Enforcement and failure behavior

The Authority authenticates and resolves the Person, checks current membership
and the exact content policy, binds Layer 2 to an exact generation and record
head, rechecks the caller at the release fence, commits the minimized response
digest, and only then returns the audited bytes. Missing, stale, mismatched, or
non-Person authority MUST release no content. Search construction MUST NOT be
triggered by a query.

## Verification and change procedure

Focused Authority, retrieval, Person-client, architecture, and clean-runtime
integration tests verify the two policy branches, exact-caller scope, final
fence, audit digest, metadata, rejection non-disclosure, and absence of a
retrieval-to-model path. Enforcement remains partial because no future answer
composition exists to qualify the final citation clause. A Layer 4 design or a
new release path requires an accepted ADR, explicit enforcement expansion, and
negative disclosure tests before this invariant can be broadened.
