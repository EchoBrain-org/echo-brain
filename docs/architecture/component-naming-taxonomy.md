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
- Capability or layer names may supplement a responsibility when they remove
  ambiguity, but must not replace it. Prefer `answer composition` over
  `Layer 4` in navigation; retain the layer number only where it defines a
  protocol or invariant.

## Guarded component indexes

The Organization Authority source boundary declares a small
`component_index_contract`: its canonical composition, runtime, lifecycle,
HTTP, processing-cycle, answer-composition, and readable-search entry points;
the exact retired paths they replace; and frozen compatibility facades. The
architecture-boundary check verifies those facts. It deliberately does not ban
words across the repository: historical and compatibility vocabulary remains
valid where its contract requires it.

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
| `person-member-exclusion` API contracts | meeting-ingestion exclusion | Wire kinds and client/server request parsers are public protocol. Introduce versioned request kinds before retiring the compatibility names. |
| `new-lineage-*` and `clean-*-v1` public workspace barrels | responsibility-specific Authority, control-plane, record, and retrieval APIs | Package export paths are consumed across workspaces and encode compatibility closure. Add responsibility-named exports, migrate consumers, then retire aliases in a major compatibility change. |
| `layer4` evaluator fixture and result JSON | answer-composition evaluation | Checked-in corpora and machine-readable evaluator output use these keys. A schema-version increment and dual reader are required. |
| `authority-development-key.v1.json` | Organization Authority signing key | Existing state directories and recovery checks depend on the filename. A key-file migration must preserve permissions, identity, and rollback behavior. |
