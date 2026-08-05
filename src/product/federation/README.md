# Federation module layout

This directory keeps the retained local identity trust layer: the founder
identity/cutover detector and the fail-closed refusals built on it. The
founder-provenance product surface that once lived here (approval capture,
attribution, signed outbox and record projection, export bundles, protected
independent copies, legacy classification, and the bootstrap ceremony that
created them) is retired and deleted. The root is intentionally not a
general-purpose home for new files.

## Root boundaries

- `source-boundary.v1.json` is the executable allowlist for this stable local
  trust layer; organization and service implementation edges are forbidden. Its
  entry points are the three modules the product actually enters through:
  `bootstrap/identity-check.ts`, `cutover-fence.ts`, and
  `identity/active-identity-bundle-store.ts`. There is no federation barrel;
  callers import the specific file they need.
- `contracts.ts` owns only the product-specific persisted contracts required to
  read and validate historical founder bootstrap trust state, and re-exports
  portable integrity/key types from `@echo-brain/federation-protocol`. The
  retired source/processor attribution, approval metadata, record-envelope, and
  export type graph and its five unused JSON schemas are deleted. The product
  store does not produce or schema-validate those full wire formats; the Slack
  adapter still has a narrow opaque legacy-presentation parser, which is a
  separate adapter cleanup boundary.
- `cutover-fence.ts` and `build-identity.ts` are bootstrap-owned root anchors,
  and `schema-validation.ts` with its `schema-validator.ts` Ajv backend is
  foundation-owned.

`cutover-fence.ts` holds the founder identity/cutover detector and the one
shared retirement gate, `assertFounderProvenanceRetired`. Nothing in this build
creates founder identity or cutover material: the low-level authoring APIs --
the bootstrap commit and cutover-guard writers, the writable session-store
APIs, provider observation/capture, challenge issue/poll, and credential-guard
creation -- are deleted, and production is detection- and validation-only.
Tests manufacture residue by copying the fixed, signed historical fixture
bytes under `tests/product/federation/fixtures/retired-founder-state/`; the
gate is still written to detect residue however it arrived, not to assume it
cannot exist.

That gate is observational only: it uses `lstat`/`readdir`/path existence and
deliberately avoids `inspectFounderCutoverFence`, `requiresFounderFederation`,
and `FounderBootstrapSessionStore`, all of which recover interrupted writes by
rename/unlink. Refusing must not mutate forensic founder state. The validating,
recovering inspection stays available to the backup downgrade guard, the
identity check, and legacy diagnostics.

The gate covers *product work*: every entry point that starts the runtime or
begins a cycle calls it before creating a directory, resolving adapters,
resolving credentials, contacting a provider or the organization Authority,
reading or mutating approvals, or invoking a caller-supplied callback. Those
entry points are `prepareProductComposition` (at construction *and* at the
start of every cycle), `DecisionNodeStore`, and one early dispatch policy in
the CLI. A custom identity check, approval capture, or approval store cannot
resume the retired mode through them.

It deliberately does not gate the diagnosis, preservation, and quiescing
commands -- `identity-check`, `validate-config`, general `status`,
`backup`/`restore`, and `service stop`/`status`/`uninstall`. Several of those
write; the line is product work, not writes. `src/product/cli.ts` owns the exact
policy and the top-level `README.md` states it.

Two honest limits. This is a fail-closed gate on trusted in-process callers, not
a sandbox: a caller-supplied implementation that ignores the documented seams
and writes to the state root itself is outside its reach. And a background access-lease
renewal started by an already-running composition can continue until that
composition closes, though every new processing cycle is gated.

An uninspectable state path -- a symlink, a non-directory, or one whose adjacent
guard or entries cannot be read -- is refused on its own terms rather than
assumed clean; no caller relies on a later validator. `DecisionNodeStore` also
keeps its own refusal for a federated node with no capture implementation; never
satisfy that one with a permissive or no-op capture object -- it distinguishes
`undefined` on purpose.

## Capability folders

- `foundation/`: compatibility exports for portable protocol primitives and
  the machine-owned installation signer surface. Key lifecycle implementations
  live under `src/product/machine/`, which imports
  `@echo-brain/federation-protocol` directly rather than through these shims.
- `identity/`: identity bundles, manifests, connections, policies, credentials,
  and provider identity.
- `bootstrap/`: historical validation of stored bootstrap sessions (reading,
  exact-shape/signature/transition checks, and commit-plan reconstruction for
  cross-checking old residue) plus the identity/seed readiness checks. The
  mutation primitives that once wrote these documents are deleted.

Installation-side organization orchestration lives in the sibling
`src/product/organization/` module, and central organization-admin bootstrap is
the supported enrollment path. Portable canonicalization, identifiers,
signature validation, installation-key descriptor validation, and generic
signed documents are owned by `@echo-brain/federation-protocol`. Product
foundation files preserve the retained reader/verification imports while
delegating those operations to that package. Private-key creation, inspection,
deletion, and signing remain machine-local product responsibilities.

## Dependency rule

Lower-level folders must not import higher-level orchestration:

```text
foundation <- identity <- bootstrap
```

Internal modules import the specific file they need. Do not add subfolder
barrels. Add a new root file only when it is a package boundary, composition
boundary, or verified physical path anchor.
