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
