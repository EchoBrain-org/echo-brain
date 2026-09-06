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
| `slack_approval_channel_id` in identity-link onboarding | initial-owner Slack identity-link channel | Existing onboarding files and operator flags carry the field. Add a versioned field and read both during a bounded migration; the channel is not an approval destination. |
| `assigned_owner` fields and `private-owner` approval-surface IDs | assigned reviewer and private reviewer approval | Pending approvals freeze these fields and IDs into signed or persisted commitments. Change only with a versioned pending-approval schema and deterministic conversion or expiry plan. |
| `organization_tool` tables and contracts | organization integration connection | Database schema, hashes, and public contracts use the old noun. A schema migration must preserve connection identity and immutable audit links. |
| `member-exclusion` wire kinds and HTTP paths | meeting-ingestion exclusion | Current source files, symbols, and parsers use the responsibility name. The serialized kinds and paths remain versioned protocol and require a versioned migration before their spelling can change. |
| `layer4` evaluator fixture and result JSON | answer-composition evaluation | Checked-in corpora and machine-readable evaluator output use these keys. A schema-version increment and dual reader are required. |
| `authority-development-key.v1.json` | Organization Authority signing key | Existing state directories and recovery checks depend on the filename. A key-file migration must preserve permissions, identity, and rollback behavior. |
| `authority_provider_human_action_reproofs` table and its `currentness_reproof_sha256` field | human-action revalidation | The persisted table and digest field are part of the Authority baseline and immutable-row lineage. Keep these exact identifiers until a versioned schema migration preserves existing rows, references, triggers, and digest inputs. Outside compatibility-bound SQL references, active source symbols, diagnostics, and tests use `revalidation`. |
| `authority-current-host-recovery-v1` template, stack, tags, and validation assets | Authority root-volume recovery floor | These names identify deployed CloudFormation resources and pinned validation inputs. Introduce a versioned replacement and explicit stack transition before changing them; current runbooks describe the protected responsibility instead. |
| `authority-recovery-helper-v1` template and `echo-authority-recovery-helper-bundle-v1` manifest kind | recovery-volume inspection host and verifier bundle | The deployed template, bootstrap contract, and machine-readable bundle format share these identifiers. A clearer source alias does not change the V1 reader; rename them only with a V2 format and infrastructure migration. |
| `authority_live_source_*`, `authority_live_approval_outbox_v2`, `authority_live_approval_delivery_quarantines_v1`, and `authority_live_v4_receipts_v2` SQL identifiers | admitted meeting-processing state | Existing Authority state, immutable triggers, queries, baseline digests, and recovery checks depend on these exact identifiers. Rename them only through a versioned database and state-lineage migration. The frozen source asset is `authority-meeting-processing-v3.sql`; the additive quarantine companion is `authority-approval-delivery-quarantine-v4.sql`. |
| `echo-clean-person-*`, `echo-clean-layer4-*`, `echo-clean-live-*`, `echo-clean-{granola,llm,slack}-*`, `clean-readable-search-*`, and `echo-clean-v4-layer1-*` machine-readable kinds | responsibility-specific Person, answer-composition, Authority lifecycle, provider, readable-search, and record kinds | HTTP clients, persisted manifests, digests, logs, metrics, and checked fixtures consume these values. A replacement requires versioned producers and readers plus an observability migration where event kinds are involved. |
| Authority `clean-{reset,person,live,granola-source}-main` files and `clean-v1` deployment paths | Authority state bootstrap, Person administration, service lifecycle, meeting-source admission, and deployment | Installed scripts, container commands, and host paths call these names. The legacy `echo-organization-authority-*clean*` alias binaries were retired on 2026-09-06 once nothing called them; retire the `-main` file names and deployed paths only through a bounded release migration. |
