# Federation module layout

This directory keeps the stable product/composition boundaries at the root and
groups implementation details by capability. The root is intentionally not a
general-purpose home for new files.

## Root boundaries

- `index.ts` is the only federation barrel exported by the product package.
- `contracts.ts` owns the shared signed and persisted data contracts.
- `runtime-wiring.ts` is the composition root.
- `approval-capture.ts`, `identity-lineage-store.ts`, `record-projector.ts`,
  `export-bundle.ts`, `independent-copy-store.ts`, and
  `legacy-classification.ts` are stable capability facades.
- `cutover-fence.ts` and `build-identity.ts` are bootstrap-owned root anchors;
  `attributing-core-state-store.ts`, `attribution-store.ts`, and
  `outbox-store.ts` are records-owned root anchors; `artifact-evidence.ts` is
  runtime-owned; and `schema-validation.ts` is foundation-owned. They remain at
  the root because qualification or installed-resource resolution depends on
  their location.

## Capability folders

- `foundation/`: canonical JSON, identifiers, immutable documents, and signing.
- `identity/`: identity bundles, manifests, connections, policies, credentials,
  provider identity, and lineage internals.
- `bootstrap/`: founder enrollment, bootstrap sessions, challenge handling, and
  seed-readiness checks.
- `approval/`: approval candidate/publication support and actor resolution.
- `records/`: attribution/projection decorators, snapshots, drafts, and approval
  group invariants.
- `export/`: export artifact material and offline verification.
- `independent-copy/`: protected-copy documents, local evidence, history, and
  macOS volume inspection.
- `legacy/`: pre-cutover evidence, deterministic classification, and reports.

## Dependency rule

Lower-level folders must not import higher-level orchestration:

```text
foundation <- identity <- bootstrap
foundation + identity + bootstrap <- approval <- records
foundation + identity + records <- export <- independent-copy
foundation <- legacy
all capabilities <- runtime-wiring
```

Internal modules import the specific file they need. `index.ts` retains its
existing subfolder exports for package compatibility; do not add new internal
helpers to that public surface. Do not add subfolder barrels. Add a new root
file only when it is a package boundary, composition boundary, or verified
physical path anchor.
