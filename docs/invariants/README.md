# Invariant registry

An invariant is a precise rule that must or must not hold across a declared
scope. It is stronger than an implementation note and narrower than a product
vision.

The current permission catalog remains in the
[architecture invariant registry](../product/2026-08-11-architecture-invariant-registry.md)
while stable records are migrated here. Do not change its normative meaning
during migration.

## Index

| ID | Statement | Scope | Implementation | Assurance |
| --- | --- | --- | --- | --- |
| `INV-01` through `INV-12` | Permission and append/retrieval invariants | Permission system | See current registry | See current registry |
| [`INV-ADAPTERS-001`](INV-ADAPTERS-001-provider-transport.md) | Provider transport is part of the verified contract | External provider methods | partial | linked tests |
| [`INV-IDENTITY-001`](INV-IDENTITY-001-symmetric-provider-proof.md) | Provider identity proof is complete and symmetric | Provider enrollment and action-time proof | partial | linked tests and live evidence |
| [`INV-ADAPTERS-002`](INV-ADAPTERS-002-durable-external-reference.md) | External object identity is durable before verification | Consequential provider writes | partial | linked tests and live evidence |
| [`INV-RUNTIME-001`](INV-RUNTIME-001-lifecycle-owned-side-effects.md) | Durable side-effect follow-up belongs to the runtime lifecycle | Background external effects | partial | linked historical tests |
| [`INV-PERMISSIONS-013`](INV-PERMISSIONS-013-frozen-pending-contract.md) | Pending consequential work resolves under its frozen contract | Approval and diagnostics | partial | linked historical tests |
| [`INV-PERMISSIONS-014`](INV-PERMISSIONS-014-actor-not-source-owner.md) | Approval authority is independent from source custody | Bounded Slack modes | partial | live negative evidence |
| [`INV-ADAPTERS-003`](INV-ADAPTERS-003-model-execution-controls.md) | Model execution controls are explicit processing identity | Model/provider pairs | partial | linked test and live evidence |
| [`INV-ADAPTERS-004`](INV-ADAPTERS-004-source-owned-grounding.md) | Models select source-owned evidence references | Shared LLM processor | partial | linked tests and live evidence |
| [`INV-ADAPTERS-005`](INV-ADAPTERS-005-provider-semantics-at-boundary.md) | Provider semantics terminate at the adapter boundary | Active provider boundaries and canonical durable contracts | partial | boundary gate; full qualification pending |
| [`INV-IDENTITY-002`](INV-IDENTITY-002-versioned-lease-duration.md) | Access duration changes are versioned compatibility changes | Access protocol | partial | linked tests; live qualification open |
| [`INV-IDENTITY-003`](INV-IDENTITY-003-revocation-windows.md) | Central and offline revocation windows are separate claims | Access and permissions | partial | bounded tests |
| [`INV-IDENTITY-004`](INV-IDENTITY-004-provider-identity-migration.md) | Incomplete provider identity is repaired by fresh atomic proof | Provider migrations | partial | linked tests and live promotion |
| [`INV-IDENTITY-005`](INV-IDENTITY-005-adapter-to-echo-identity-chain.md) | Adapter and provider identities confer ECHO authority only through explicit links | Provider approval and Person reads | partial | linked tests; v4 end-to-end qualification open |
| [`INV-PERMISSIONS-015`](INV-PERMISSIONS-015-layer-3-person-release-boundary.md) | Layer 3 is the sole Authority content-release boundary | Clean V1 Person release and Layer 4 request boundary | partial | focused boundary and integration tests |
| [`INV-RELEASE-001`](INV-RELEASE-001-worktree-bound-artifact.md) | Artifact identity is bound to the exact source worktree | Build and release | not implemented systemically | live detection only |
| [`INV-OPERATIONS-001`](INV-OPERATIONS-001-shared-namespace-lifecycle.md) | Shared namespaces imply shared lifecycle qualification | Authority and proxy | partial | explicit restart tests |

Future component and failure records should link stable invariant IDs rather
than copy their wording.

## Required content

Each invariant records:

- one normative `MUST` or `MUST NOT` statement;
- its exact scope and non-scope;
- rationale and trust boundary;
- enforcement points;
- required failure behavior;
- verification tests and qualification evidence;
- related decisions and known failure patterns;
- owner and change procedure; and
- independent implementation and assurance status.

Use the [invariant template](../_templates/invariant.md).

An invariant cannot be marked globally implemented from one bounded pilot or
one serving path. Name the narrow enforcement scope until every relevant path
has proof.
