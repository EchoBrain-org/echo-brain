# Documentation

Code and schemas are authoritative for exact fields and behavior. These files
cover only current architecture and near-term product direction.

Start with the primary map:

- [One-organization boundaries](architecture/organization-workspace-boundaries.md)
  — the whole repository: which workspace owns what, how those workspaces
  depend on each other, which capabilities are out of pilot scope, and which
  manifests enforce the graph.

The rest are subordinate deep-dives into one part of that map:

- [Core and adapters](architecture/core-and-adapters.md) — the `src/`
  capability contract: tool-neutral core, replaceable adapters, and the rules
  a new adapter must satisfy.
- [Product runtime](architecture/product-runtime.md) — the local host around
  the core: composition, durable state, lifecycle, and safety.
- [Identity and onboarding](architecture/identity-and-onboarding.md)
  — installation identity, organization enrollment and access, and provider
  identity linking.
- [Organization control plane](architecture/organization-control-plane.md) —
  the customer-owned Slack connection, the identity link, and the action-time
  permission path.

[Organization brain direction](product/org-brain-direction.md) is stated
direction rather than current implementation and is labelled as such.
[Org decision record: append and derive](product/2026-08-07-org-decision-record-append-derive-design.md)
is the approved design for that direction's append/derive half — implemented
in 0.1.0-internal.6.
[Organization permission architecture](product/2026-08-09-organization-permission-architecture.md)
is the approved permission skeleton — pillars, trust ladder, invariants —
that retrieve-side feature specs instantiate; approved but not yet
implemented.

Historical proposals, ceremonies, evidence reports, and implementation diaries
belong in Git history rather than the active tree; approved-but-unimplemented
designs live in `docs/product/` until implemented or superseded. Commit
`8be5151` removed that machinery; read it with `git show 8be5151^:<path>` for
`provenance/`, `docs/decisions/`, `docs/runbooks/`,
`services/organization-admin-edge/`, `release/`, `native/macos/`,
`schemas/product/qualification-*.json`, and the removed `tools/` entries
`phase5/`, `product/`, `release/`, `organization-admin-edge/`,
`organization-authority/`, `audit-pinned-extraction.mjs`,
`check-provenance.mjs`, `check-successor-provenance.mjs`,
`check-dependencies.mjs`, and `verify-artifact.mjs`. Commit `1d9892c`
subsequently removed `src/product/federation/` and the remaining
`schemas/product/*.json`; read those with `git show 1d9892c^:<path>`.
