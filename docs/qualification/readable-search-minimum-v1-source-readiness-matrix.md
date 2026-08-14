---
schema_version: 1
id: QMAT-READABLE-SEARCH-MINIMUM-V1-001
kind: qualification-matrix
title: Readable-search minimum-V1 Layers 1-3 source-readiness matrix
component_ids:
  - CMP-CENTRAL-ORGANIZATION
  - CMP-IDENTITY-ACCESS
  - CMP-PERMISSIONS
  - CMP-OPERATIONS-RELEASE
created_at: 2026-08-14
reviewed_at: 2026-08-14
reviewed_ref: 83819a57fd8635384d14d3cc8d591e8f76ad1260
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
qualification_ids:
  - QUAL-20260814-194049-001
---

# Readable-search minimum-V1 Layers 1-3 source-readiness matrix

## Scope and non-claims

This is the reusable minimum-V1 qualification matrix for the readable-search
path across immutable Layer 1 input, rebuildable Layer 2 generation, and
serving Layer 3 authorization/audit. It records the source, focused-test, and
operational surfaces that each exact run must evidence.

The implementation and focused tests are committed at the `reviewed_ref`.
Completed exact runs are linked through `qualification_ids`; each report owns
its own outcome and non-claims. Earlier bounded reports remain immutable and do
not inherit a later run's broader scope.

Each report must name its exact source commit, artifact, configuration, state
generation, per-assertion outcome, and evidence IDs. Restore and founder-live
assertions require their own exact-run evidence; neither may be inherited from
local source inspection, focused tests, or another report.

## Matrix

| Assertion ID | Assertion | Layer | Focused source/test surface or required operational evidence |
| --- | --- | --- | --- |
| `RSMV1-001` | The exact organization-wide consequence, complete release draft, actor, card, provider evidence, semantic intent, and audit bind before append; any edit or mismatch creates neither record nor fact. | Layer 1 admission | `services/organization-authority/src/application/organization-recording-policy-activation.ts`; `services/organization-record/src/application/organization-member-policy-fact.ts`; source tests include `services/organization-record/test/organization-member-policy-fact.test.ts`. |
| `RSMV1-002` | Schema v1/pilot, reviewer v2, member-readable v3, rejection, malformed, and unknown versions never cross-classify or fall back. | Layer 1 admission | `services/organization-record/src/retrieve/retrieval-build-port.ts`; `services/organization-record/test/reviewer-derived-compatibility.test.ts`. |
| `RSMV1-003` | Every v3 record and complete text-free item-fact set co-commit; failure, duplicate mismatch, missing capability, fact tamper, or audit corruption commits neither or makes the policy unavailable. | Layer 1 admission | `services/organization-record/src/application/organization-member-policy-fact.ts`; `services/organization-record/test/organization-member-policy-fact.test.ts`. |
| `RSMV1-004` | A later/replacement active membership sees organization-member content; only the frozen exact membership sees its reviewer content; revocation removes both current paths as applicable. | Layer 3 authorization | `services/organization-authority/src/application/readable-search.ts`; `services/organization-authority/test/readable-search.test.ts`. |
| `RSMV1-005` | An invalid caller, inactive membership, missing fact, invalid scope, or empty scope opens no lexical or content handle. | Layer 3 to Layer 2 boundary | `services/organization-authority/src/application/readable-search.ts`; `services/organization-retrieval/src/serve/opaque-search.ts`; focused tests include `services/organization-authority/test/readable-search.test.ts` and `services/organization-retrieval/test/generation-serving.test.ts`. |
| `RSMV1-006` | An ordinary member opens only the organization segment; an exact reviewer may additionally open only their own reviewer segment. Global, other-reviewer, broad-derived, and raw-log access is unreachable. | Layer 2 serving | `services/organization-retrieval/src/serve/opaque-search.ts`; `services/organization-retrieval/test/generation-serving.test.ts`. |
| `RSMV1-007` | Adding, removing, or altering another reviewer's records, then publishing a complete exact-head generation for each corpus, leaves ordinary-member results, order, witnesses, and error behavior byte-identical. The expected interval before republish is only the global strict-head unavailable response; audit reveals no hidden item, tuple, partition, count, term, text, or segment identity. | Layer 2 serving and Layer 3 audit | `services/organization-retrieval/test/generation-serving.test.ts`; `services/organization-authority/test/readable-search.test.ts`. |
| `RSMV1-008` | Unicode analyzer fixtures pin tokens; matches, term frequencies, four-key ordering, ten-item cap, and empty results are deterministic across input enumeration order and full stopped rebuild. | Layer 2 build and serving | `services/organization-retrieval/src/build/generation-builder.ts`; `services/organization-retrieval/test/generation-build.test.ts`; `services/organization-retrieval/test/roots-manifests.test.ts`. |
| `RSMV1-009` | Swapped fact, content, posting, segment, manifest, policy, proof, record, analyzer, or generation material fails before text release. | Layers 1-2 binding | `services/organization-record/src/application/retrieval-policy-binding.ts`; `services/organization-retrieval/src/application/upstream-input.ts`; focused tests include `tests/architecture/readable-search-binding-conformance.test.ts`, `services/organization-retrieval/test/generation-build.test.ts`, and `services/organization-retrieval/test/generation-serving.test.ts`. |
| `RSMV1-010` | Missing, partial, corrupt, position-only head-match, wrong hash/build/runtime/analyzer/contract/root, orphan staging, and mixed segment files never serve. | Layer 2 generation admission | `services/organization-retrieval/src/application/manifests.ts`; `services/organization-retrieval/test/roots-manifests.test.ts`; `services/organization-authority/test/organization-record-rebuild-derived.test.ts`. |
| `RSMV1-011` | Any record append after publication makes search fixed-unavailable until a complete exact-head generation publishes; append remains available and never waits for Layer 2. | Layers 1-2 availability | `services/organization-authority/src/composition/readable-search.ts`; `services/organization-authority/test/readable-search-full-lifecycle.test.ts`. |
| `RSMV1-012` | Crashes throughout staging, rename, and pointer commit leave either the prior pointer or one complete new pointer; stopped rebuild reproduces logical roots/generation ID and never mutates active files. | Layer 2 operations | `services/organization-authority/src/composition/operator-state.ts`; `services/organization-authority/test/organization-record-rebuild-derived.test.ts`. |
| `RSMV1-013` | Membership, lease, installation, record-head, policy, and generation changes before final commit deny or return unavailable; changes after commit affect only the next request; audit failure sends no bytes. | Layer 3 final fence | `services/organization-authority/src/application/readable-search.ts`; `services/organization-authority/test/readable-search.test.ts`. |
| `RSMV1-014` | The exact response digest and opaque returned bindings are audited for 180 days; raw query, text, terms, scores, segments, and counts never enter audit, logs, traces, metrics, cache, or an external provider. | Layer 3 audit | `services/organization-authority/src/application/readable-search.ts`; `services/organization-authority/test/readable-search.test.ts`; `services/organization-authority/test/readable-search-http.test.ts`. |
| `RSMV1-015` | Internally consistent stale state remains offline until independently retained heads/receipts, Person state, policy facts, record head, active pointer, manifests, roots, and audit storage reconcile. | Restore operational gate | Required separate restore-reconciliation exact run with independently retained evidence. |
| `RSMV1-016` | Serving code cannot import raw databases, broad derived accessors, builders, migrations, filesystem paths, or maintenance commands; builders cannot import current Person state; fact code cannot import content/index readers. | Cross-layer source boundary | `tests/architecture/source-independence.test.ts`; `tests/architecture/readable-search-binding-conformance.test.ts`; exact boundary-suite evidence must be attached to a committed source identity. |
| `RSMV1-017` | Shadow generations cannot alter Job A behavior. The search route has one serving substrate and never unions or falls back across A/B; Job A's reviewer-recent route stays log-backed unless separately reviewed. | Layer 2/3 cutover | `services/organization-authority/src/composition/readable-search.ts`; `services/organization-authority/test/readable-search-full-lifecycle.test.ts`; source-test evidence does not authorize cutover. |
| `RSMV1-018` | A real reviewer-v2 record and a real organization-v3 record survive Authority restart and stopped generation rebuild; the exact reviewer sees both, a separately enrolled later member sees only the organization item, and no hidden segment/content access occurs. | Founder-live operational gate | Required separate founder-live exact run with explicit actor, machine, provider, and probe non-claims. |

## Required qualification sequence

1. Commit the source and run the focused Layer 1, Layer 2, Layer 3, and
   boundary suites against that exact commit.
2. Build and identify the exact artifact, configuration, and state generation;
   run the stopped build/admission and restart cases as separately recorded
   artifacts.
3. Execute the restore-reconciliation and founder-live rows in their own exact
   runs, then create immutable reports only for the assertion sets actually
   evidenced.

Passing a local focused suite is evidence for a named source assertion only.
It does not convert the matrix into a qualification report or promote any
readiness status. A linked report must distinguish source, restore, and live
proof rather than implying every row was exercised live.
