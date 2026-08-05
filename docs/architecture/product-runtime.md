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

Central organization-admin bootstrap is the one supported v1 path. Local use
without an organization enrollment is rehearsal-grade and cannot be promoted
retroactively.

The local founder-provenance cutover mode is retired: no supported command or
runtime path creates founder identity or cutover material, and the attribution,
signed projection, outbox, and protected independent-copy implementations behind
it are deleted. The low-level `commitFounderBootstrap`,
`commitFounderCutoverGuard`, and writable bootstrap-session APIs still compile,
so the product detects residue however it arrived rather than assuming it cannot
exist.

Identity cutover was irreversible, so a state root that still carries that
material is detected and refused rather than downgraded. No product-work
command, runtime start, or new processing cycle can resume on it. One shared
gate in `cutover-fence.ts` is called by `prepareProductComposition` (at
construction and at the start of every cycle), `startProductRuntime`,
`DecisionNodeStore`, and the CLI before any directory creation, component or
adapter resolution, credential work, provider or Authority contact, approval
read or mutation, or caller-supplied callback, so a custom identity check,
approval capture, approval store, or runtime cannot resume the retired mode.
The gate is observational only, so refusing never mutates forensic founder
state. It is a fail-closed gate on trusted in-process callers, not a sandbox:
an injected component that bypasses the documented seams and writes to the
state root directly is outside what it can prevent. One narrow carve-out: a
background access-lease renewal started by an already-running composition can
continue until that composition is closed, but every new processing cycle is
gated.

The CLI applies this as one early dispatch policy, as soon as the state path is
known. `bootstrap`, `init`, `reconfigure`, `doctor`, `update`, every
`organization` action (including `status`, which opens and migrates writable
SQLite), `approvals`, `run-once`, `service-run`, and `service
install`/`start`/`restart` are refused before any operator, probe, lock,
directory, credential, database, network, or injected callback. The exceptions
are the diagnose/preserve/quiesce commands -- `validate-config`, general
`status`, `identity-check`, `backup`, `restore`, and `service
stop`/`status`/`uninstall` -- not a claim that they never write.

Recovery is not a restore. The cutover is irreversible and a backup stays bound
to its originating state path, so a backup of a retired profile is preservation
for that profile and never a way to cross the fence. Because `backup` refuses
while the service is loaded, the executable order is: `service stop`, `backup`,
then `bootstrap` onto a founder-residue-free new config and state path with the
administrator-issued invitation and Authority PIN. That one command provisions
the credentials, initializes, and enrolls the new installation. The extension
seams -- the decision store's federation capture port and the persisted
document contracts under `schemas/product/` -- are retained.

## Product boundary

The current product is one user-owned local installation. It is not a central
organization database, identity provider, distributed scheduler, or plugin
platform. Multi-user enrollment and organization access wrap that local
boundary: they gate the runtime without replacing the core or rewriting local
history.
