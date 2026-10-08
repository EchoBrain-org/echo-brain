# Component naming taxonomy

**Status:** Normative

Names are part of ECHO's architecture contract. People and coding agents use
them as indexes, so a component name must identify a durable responsibility,
not the first provider, operator, environment, or sprint that happened to use
it.

## Naming rules

- Name components for their domain responsibility: `Person client`,
  `Organization Authority`, `meeting processing core`, and `processing
  adapters`.
- Put provider names only at integration edges that actually implement that
  provider, such as a Granola meeting-source adapter or Slack approval surface.
  Provider-neutral orchestration, storage, and contracts must not inherit a
  provider name.
- Put environment names such as `local`, `staging`, or `production` only on
  deployment, credential, network, or security boundaries whose behavior
  truly differs by environment. Do not use an environment as a product role.
- Use exact role nouns. `Person client` means the installed client;
  `Organization Authority` means the organization-owned server authority;
  `meeting owner`, `reviewer`, and `organization member` mean distinct actors.
  Do not substitute `founder`, `user`, or `runtime` when a narrower role or
  responsibility is known.
- Use verbs consistently: `create` constructs a new value or adapter without
  acquiring durable resources; `open` acquires or restores an existing
  resource and returns its lifecycle handle; `start` begins a long-lived
  service or background activity; `run` executes a bounded command, cycle, or
  evaluation and returns when it is complete.
- Use architectural nouns consistently. An `adapter` translates an external
  provider or storage boundary; an `engine` owns a cohesive algorithm such as
  building and searching an index; a `service` exposes a domain capability; a
  `workflow` coordinates a bounded use case; a `runtime` owns opened resources
  and lifecycle; a `bundle` supplies related ports or factories to a runtime;
  and a `composition root` is the one place that selects concrete providers.
  Do not call a barrel, algorithm, or data contract a runtime merely because
  production code imports it.
- Capability or layer names may supplement a responsibility when they remove
  ambiguity, but must not replace it. Prefer `answer composition` over
  `Layer 4` in navigation; retain the layer number only where it defines a
  protocol or invariant.

## Workspace taxonomy

- `services/` contains independently deployable processes and the source that
  owns their lifecycle. A service is an operational artifact, not a convenient
  container for every server-side module.
- `packages/` contains linked reusable modules, server libraries, and shared
  contracts. A package may be part of an Authority image without becoming an
  independently deployable service.
- `src/product/` contains shipped machine product. Its workspaces are the
  installable end-user artifacts and remain separate from server libraries and
  service lifecycle ownership.

Accordingly, `organization-control-plane`, `organization-record`, and
`organization-retrieval` are linked packages. The Organization Authority is
the process that composes and deploys them; the Person client is the shipped
machine product.

## Guarded component indexes

Every registered workspace source boundary declares a small
`component_index_contract`. Protocol workspaces anchor their public contract;
product, package, and service workspaces anchor the few canonical components
that a person or coding agent should use to enter the architecture. Each
contract
also lists exact retired source paths and any frozen compatibility facades.
The architecture-boundary check requires the index, verifies its exports and
facade targets, and rejects a reintroduced retired path.

The index is intentionally selective. It does not enumerate every source file
or ban vocabulary across the repository. Historical, wire, persisted, and
compatibility names remain valid where their contract requires them.

## Compatibility and history

Persisted schema kinds, wire fields, event names, database values, release
formats, CLI flags, and other compatibility identifiers are frozen unless a
versioned migration explicitly changes them. A clearer source symbol does not
authorize rewriting stored `clean-v1` artifacts.

Historical ADRs, qualification reports, sprint plans, and evidence describe
the names and commands that existed when they were written. Keep their
filenames and titles intact. Current indexes, component pages, tests, tools,
and new records use the current taxonomy and link to history rather than
turning history into the navigation layer.

## Compatibility-migration ledger

The repository-wide naming audit found the following misleading identifiers
that cannot be replaced safely by a source-only rename. New code must use the
target vocabulary around them and must not copy the legacy term into another
component.

| Compatibility-bound name | Target vocabulary | Why migration or versioning is required |
| --- | --- | --- |
| `clean-founder` setup command, public binary, manifest status, and persisted kinds | Organization Authority administration and initial-owner setup | Operator scripts, package binaries, persisted manifests, and status parsers share this contract. Replace them together with a versioned setup format and compatibility reader. |
| `clean-v1` release, runtime profile, and state namespace | Organization Authority release, deployment profile, and state lineage | Release records are digested and deployed paths are durable. A new vocabulary requires a new release/profile schema and an explicit state transition. |
| `echo-staging-synthetic-private-dm-canary-receipt-v1` receipt kind, the `staging-private-dm-canary` command and the `slack_approved` release-authorization field | staging release canary and its approval confirmation | The deploy scripts, host runner and persisted receipts parse these values. The canary now stages a proposal on the owner's synthetic personal source and either approval surface satisfies it, but a rename needs versioned deploy tooling and receipt readers released together. |
| `organization_tool` tables and contracts | organization integration connection | Database schema, hashes, and public contracts use the old noun. A schema migration must preserve connection identity and immutable audit links. |
| `layer4` evaluator fixture and result JSON | answer-composition evaluation | Checked-in corpora and machine-readable evaluator output use these keys. A schema-version increment and dual reader are required. |
| `authority-development-key.v1.json` | Organization Authority signing key | Existing state directories and recovery checks depend on the filename. A key-file migration must preserve permissions, identity, and rollback behavior. |
| `authority-current-host-recovery-v1` template, stack, tags, and validation assets | Authority root-volume recovery floor | These names identify deployed CloudFormation resources and pinned validation inputs. Introduce a versioned replacement and explicit stack transition before changing them; current runbooks describe the protected responsibility instead. |
| `authority-recovery-helper-v1` template and `echo-authority-recovery-helper-bundle-v1` manifest kind | recovery-volume inspection host and verifier bundle | The deployed template, bootstrap contract, and machine-readable bundle format share these identifiers. A clearer source alias does not change the V1 reader; rename them only with a V2 format and infrastructure migration. |
| `authority_live_source_*`, `authority_live_approval_outbox_v2`, and `authority_approval_decisions_v1` SQL identifiers | admitted meeting-processing state | Existing Authority state, immutable triggers, queries, baseline digests, and recovery checks depend on these exact identifiers. Rename them only through a versioned database and state-lineage migration. The only frozen asset is `packages/organization-authority-kernel/baselines/authority-baseline-v12.sql`, which accepts fresh initialization only; earlier baselines and converters remain in Git history. |
| `echo-clean-person-*`, `echo-clean-layer4-*`, `echo-clean-live-*`, `echo-clean-{granola,llm,slack}-*`, `clean-readable-search-*`, and `echo-clean-v4-layer1-*` machine-readable kinds | responsibility-specific Person, answer-composition, Authority lifecycle, provider, readable-search, and record kinds | HTTP clients, persisted manifests, digests, logs, metrics, and checked fixtures consume these values. A replacement requires versioned producers and readers plus an observability migration where event kinds are involved. |
| Authority `clean-{reset,live}-main` files and `clean-v1` deployment paths | Authority state bootstrap, service lifecycle, and deployment | Installed scripts, container commands, and host paths call these names. The legacy `echo-organization-authority-*clean*` alias binaries were retired on 2026-09-06 once nothing called them, and the uncalled `clean-person-main` and `clean-granola-source-main` entry files later; retire the remaining `-main` file names and deployed paths only through a bounded release migration. |
