# Product runtime architecture

**Status:** Current

The product runtime is the local host around the core. It chooses adapters,
owns durable state and approval authority, refuses retired founder residue,
enforces current organization access, and manages lifecycle. It does not
redefine canonical records or provider behavior.

## Composition

```text
versioned configuration
  -> configuration and factory preflight
  -> retired-founder residue refusal and local-state validation
  -> current organization access authorization
  -> adapter construction and configuration validation
  -> provider health
  -> durable state and approval authority
  -> core cycle
```

One installation may have multiple meeting sources and delivery surfaces, but
uses one processor selection and one approval authority for a given runtime.
Approval and delivery remain independently configured. One-shot and supervised
execution use the same composition.

## State authority

One explicit private local state root is the installation's authority for
mutable runtime state. External preservation procedures must treat it as one
unit. The runtime does not infer an ambient Echo home. Where a retired founder
profile left its external cutover guard, that guard sits beside the state root
rather than inside it and must be preserved with the root.

Control configuration remains outside restored state. Credentials are
referenced and resolved by the host; secrets never enter canonical records.
Every approval entry point shares one durable append-only approval history.

## Lifecycle and safety

- Only one active runtime operates on a state root.
- Runtime and maintenance operations are mutually exclusive.
- Retired founder residue is refused before provider contact and re-checked at
  every processing cycle.
- An installation pinned to an organization authority proves current signed
  access before adapter construction; denial fails startup closed.
- Adapter health is checked before cycle work.
- Provider operations are bounded and cancellable.
- Unknown external outcomes never become fabricated success.

## Diagnostic composition

Full `doctor` uses the same adapter factory inputs and the same authenticated
organization-state classifier as runtime composition. Pure presentation ports
are always supplied; authority-bearing ports are supplied only after one
query-only SQLite snapshot proves a connected enrollment and its installation
signer. Diagnostics must not invent a stand-in capability merely to make
adapter validation pass. The inspection runs no migrations and makes no
logical product-state writes, although SQLite may use its private WAL
coordination files. `--local-only` deliberately skips organization and adapter
composition. Provider health remains a reachability check, not proof that a
future runtime authorization will succeed.

## Identity modes

Central organization-admin bootstrap is the one supported v1 path. Local use
without an organization enrollment is rehearsal-grade and cannot be promoted
retroactively.

The local founder-provenance cutover mode is retired and its implementation is
deleted: nothing creates, reads, validates, or recovers founder identity,
bootstrap-session, or cutover material. What survives is one presence-only
detector in `src/product/retired-founder-provenance.ts` -- old state is never
parsed, and residue is detected however it arrived rather than assumed
impossible.

Identity cutover was irreversible, so a state root that still carries that
material is detected and refused rather than downgraded. No product-work
command, runtime start, or new processing cycle can resume on it. One shared
gate in `retired-founder-provenance.ts` is called by `prepareProductComposition` (at
construction and at the start of every cycle), `DecisionNodeStore`, and the
CLI before any directory creation, adapter resolution, credential work,
provider or Authority contact, approval read or mutation, or caller-supplied
callback, so an injected approval store or callback cannot resume the retired
mode.
The gate is observational only, so refusing never mutates forensic founder
state. It is a fail-closed gate on trusted in-process callers, not a sandbox:
caller-supplied implementation that bypasses the documented seams and writes
to the state root directly is outside what it can prevent. One narrow carve-out: a
background access-lease renewal started by an already-running composition can
continue until that composition is closed, but every new processing cycle is
gated.

The CLI applies this as one early dispatch policy, as soon as the state path is
known. `bootstrap`, `init`, `reconfigure`, `doctor`, every
`organization` action (including `status`, which opens and migrates writable
SQLite), `approvals`, `run-once`, `service-run`, and `service
install`/`start`/`restart` are refused before any operator, probe, lock,
directory, credential, database, network, or injected callback. The exceptions
are the inspect/quiesce commands -- `validate-config`, general `status`, and
`service stop`/`status`/`uninstall`.

This build exposes no backup or restore command. A fenced profile can only be
stopped and preserved through a separately reviewed out-of-band procedure that
does not mutate or reinterpret its state. `service stop` is not durable across
login, so after preservation the operator uses `service uninstall` with the old
config to remove its LaunchAgent. Recovery then uses `bootstrap` on a
founder-residue-free new config and state path with the administrator-issued
invitation and Authority PIN. That one command provisions the credentials,
initializes, and enrolls the new installation; fresh central bootstrap is the
only forward path. The decision
store's federation capture port is deleted. New approval nodes always store
local metadata; a historical node with an own `requested.metadata.federation`
field is refused on every read or mutation, while similarly named fields in
publication references or resolution metadata remain opaque.

## Internal Live release artifacts

`tools/internal-live-release.mjs` and the release workflow produce and verify
Internal Live artifacts. The product CLI does not apply those releases, back up
state, or restore state. Clean-machine bootstrap and the requirement for a
separately reviewed enrolled-machine maintenance procedure are documented in
the root [README](../../README.md).

## Product boundary

The current product is one user-owned local installation. It is not a central
organization database, identity provider, distributed scheduler, or plugin
platform. Multi-user enrollment and organization access wrap that local
boundary: they gate the runtime without replacing the core or rewriting local
history.
