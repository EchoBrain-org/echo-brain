# Product runtime architecture

**Status:** Current

The product runtime is the local host around the core. It chooses adapters,
owns durable state and approval authority, enforces identity readiness, and
manages lifecycle. It does not redefine canonical records or provider behavior.

## Composition

```text
versioned configuration
  -> configuration and factory preflight
  -> local state and identity/credential-continuity gate
  -> adapter construction and configuration validation
  -> provider health
  -> durable state and approval authority
  -> optional seed-grade identity layer
  -> core cycle
```

One installation may have multiple meeting sources and delivery surfaces, but
uses one processor selection and one approval authority for a given runtime.
Approval and delivery remain independently configured. One-shot and supervised
execution use the same composition.

Runtime components declare the components they must start after. The runtime
validates that graph before anything starts, rejecting duplicate component
names, unknown or repeated dependencies, and dependency cycles, then starts
components in topological order. The ordering enumerates no product features,
so a future reasoning component can be added by composition without weakening
rollback or changing unrelated runtime tests.

## State authority

One explicit private local state root is the installation's authority and
restore unit for mutable runtime state. The runtime does not infer an ambient
Echo home. Irreversible cutover evidence and required independent copies are
separate verification witnesses and do not roll back with that root.

Control configuration remains outside restored state. Credentials are
referenced and resolved by the host; secrets never enter canonical records.
Every approval entry point shares one durable append-only approval history.

## Lifecycle and safety

- Only one active runtime operates on a state root.
- Runtime and maintenance operations are mutually exclusive.
- Identity and credential continuity are checked before provider contact.
- An installation pinned to an organization authority proves current signed
  access before adapter construction; denial fails startup closed.
- Adapter health is checked before cycle work.
- Provider operations are bounded and cancellable.
- Partial startup unwinds cleanly and shutdown is bounded.
- Unknown external outcomes never become fabricated success.

## Identity modes

Pre-cutover use is rehearsal-grade and cannot be promoted retroactively.
Identity cutover is irreversible. After cutover, strict identity checks precede
provider contact, and partial wiring cannot bypass attribution, signed
projection, or durability gates.

Federation is additive: existing processing keys, approval IDs, adapter
contracts, and delivery idempotency remain unchanged. Seed-grade delivery waits
until attribution, approval evidence, signed envelopes, the outbox, and the
protected, verified independent copy of the signed outbox are durable.

## Product boundary

The current product is one user-owned local installation. It is not a central
organization database, identity provider, distributed scheduler, or plugin
platform. Multi-user enrollment and organization access wrap that signed local
boundary: they gate the runtime without replacing the core or rewriting local
history.
