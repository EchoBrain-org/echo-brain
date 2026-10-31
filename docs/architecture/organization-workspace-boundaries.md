# Organization workspace boundaries

**Status:** Current

The root `package.json` workspace list is the source of truth: eight neutral
packages, the provider workspaces under `providers/`, the Authority service,
and the Person client. The root package only orchestrates workspaces.

`packages/` owns inward contracts and reusable implementations. `services/`
owns deployable processes and their lifecycle. `providers/<provider>/` owns
that provider's wire formats, credentials, persistence translations, model
vocabulary, command/UI fragments, tests, and runtime assets. Slack, Jira and
Confluence have separate client and server workspaces because the Person
artifact must remain free of Authority code and native SQLite.

## Dependency direction

Neutral modules can import other neutral modules. A neutral library cannot
import a composing application. Providers depend inward on neutral public
exports; they cannot import another provider or the Authority service.
Explicit bootstrap modules select implementations and inject ports. Neutral
modules cannot import bootstrap modules. Cross-workspace imports use explicit
public exports, and the complete workspace graph must remain acyclic.
Declared runtime dependencies, including optional and peer dependencies, obey
the same direction and cycle rules even when no source module imports them.
Application manifests may declare the providers selected by their bootstrap
modules; ordinary source modules still obey their narrower layer rules.

- `organization-processing` owns processing contracts, the bounded cycle, generic
  LLM prompt/grounding behavior, and processing state.
- `organization-authority-kernel` owns reusable Authority contracts, rules,
  telemetry, state verification, SQLite baseline access, and bundle ports,
  plus the agentic research loop and answer composition that Ask, impact
  checks and sweeps share, and the audited live-evidence boundary.
- Federation/API/protocol, control-plane, record and retrieval retain their
  existing responsibilities. Record has no runtime dependency on protocol.
- The Authority and Person composition modules select provider implementations.
  The deployed Authority selects its product profile. OpenRouter is the default
  LLM transport. The staging profile can also select a host-installed personal
  Claude account for one membership's research and final answer writer, using
  the Anthropic transport in `providers/openrouter/src/claude-research/`.
  Housing this second upstream in the OpenRouter workspace is provider-ownership
  debt; the folder-based import checks cannot detect that semantic distinction.

The registry is
[`tools/workspace-source-boundaries.v1.json`](../../tools/workspace-source-boundaries.v1.json).
Every production module has an owner. The gate follows whole modules, including
unused re-exports, namespace/side-effect imports, type queries and literal dynamic
imports. Runtime asset references obey the same direction. The native Swift
app, its assemblies and the JavaScript source assembly of the retired Journey
Explorer are gone; the gate rejects any Swift source under `product/` or
`providers/`.
There is no provider-name registry, symbol-based
traversal or exception mechanism.

## Product and build boundaries

The Person tarball contains the client, federation/protocol/API and the Slack,
Jira and Confluence client fragments. It includes public versioned data exports and
contains no Authority, processing, server provider or SQLite dependency. Its
dedicated build (`tools/build.mjs --person-client`) compiles only these
workspaces. The Authority image contains the workspace dependency closure and
frozen SQL/provider assets that `deploy/organization-authority/Dockerfile`
copies into its runtime stage. The Electron
desktop app in `product/echo-desktop` is not a root workspace and imports no
workspace internals. It bundles public neutral exports from `organization-api`
and `federation-protocol` for validation and view construction, and loads the
built Person client package at run time.

The architecture suite compiles all eight neutral packages in an isolated tree
with no provider, Person, service or prebuilt workspace output available.
External dependencies remain installed; workspace symlinks point only into the
isolated tree. This isolated compile runs inside the architecture suite and
needs no CI job of its own. Full source tests and the offline kit and artifact
checks exercise the Person tarball and the Authority image. The root suite does
not reach `product/echo-desktop`; the separate `desktop-app` CI job runs it on
native macOS arm64 and Linux x64 runners: typecheck, unit tests, Playwright
suite, packaging with its release leak check, and packaged smoke. The Linux leg
also installs and smokes the deb.

Neutral package tests may import neutral workspace code, their own test
fixtures, and shared neutral test support. The test-layer architecture check
uses the module-reference parser to enforce this across every `packages/*/test`
root and shared support, including type imports and re-exports. Provider-specific
contract tests live with their provider; tests that combine a provider with
Authority transports live with the composing service. The same check holds
each `providers/*/test` root to neutral packages, the shared provider library
and its own provider folder. Generic processing and
record tests retain independent fixture implementations and signed protocol
helpers without importing a provider or application workspace.

The Person client consumes generic v4 tool status. The v3 tool-status route
and Slack's v2 route are retired (ADR-0048). Slack owns its commands and keeps
its v2 shape for its disconnect reply and the v4 list. v4 admits up to 32
independently identified tools without imposing a provider's identity grammar.

`product/source-boundary.v1.json` declares bootstrap modules, provider folders,
source assemblies and retired roots. The legacy machine runtime remains absent.
Its former product graph fields must remain empty: active products are checked
through their registered workspace boundaries. The gate retains source
tombstones and provider ownership without maintaining a second graph walker
for the retired runtime.

## Authority layers

Presentation routes (`src/presentation/`) never open SQLite: the layer rules
in `services/organization-authority/source-boundary.v1.json` allow them no
`better-sqlite3` import and no Authority adapter or composition module. They
call application use cases, or
Person services hosted in `src/composition/` through injected interfaces. Several of those composition
modules hold use-case logic with direct SQLite access, which the composition
layer rule allows; the
[composition README](../../services/organization-authority/src/composition/README.md#use-case-services-with-direct-sqlite-access)
lists them, and a new module must not join that list quietly. The service owns one
organization, Person identity and sessions, authorization, and process lifecycle.
Provider bundles receive explicit state/action/transport ports. The listener stays
loopback-only behind the trusted reverse proxy. Stopped-state setup selects the
current OpenRouter/Slack profile without an organization meeting source. Its
manifest, readiness checks and finalization require Slack; setup is not a
swappable provider port. Another
profile requires a versioned bootstrap design alongside the runtime selection.
Provider verification, identity SQL, credential interpretation and source
admission proofs stay in their provider folders.

The synchronous approval-state port crosses between two handles on
`authority.sqlite`. Both connection owners guard against calls inside an open
transaction. Each authority operation commits before the other owner runs. The
provider's stable approval fence uses its own authority handle and the separate
control-plane database, without calling back through the state port. The
file-backed ordering regression verifies lock refusal and committed visibility;
existing delivery, restart and terminal-approval integration tests cover the
composed workflow.

## Persistence ownership

The server uses separate databases with explicit responsibilities:

- `authority.sqlite` owns Authority metadata, principals, memberships,
  Person/OIDC identity and sessions, authorization/audit state, integration
  anchors, bounded pre-record processing state including raw meeting and
  decision documents, and immutable source custody under
  [ADR-0014](../decisions/ADR-0014-unified-source-ingestion-and-document-custody.md):
  Person originals and admitted source revisions. Custody grants no read;
- the control-plane database owns verified provider identity, opaque
  connection handles, Person identity links, and private approval evidence;
- `record-log.sqlite` is the append-only organization record;
- retrieval generations are immutable projections built from record state; and
- provider-owned and operational sidecars sit beside them in the state
  directory. None is a V2 root-manifest role:
  - `granola-person-connections.sqlite` holds Granola Person connection
    handles. The Authority service opens it on every start and checks its
    lineage binding.
  - `confluence-person-connections.sqlite` holds the gated Confluence
    live-evidence connections. Offline recovery verification refuses a backup
    that contains it; the operator revokes and reconnects after a restore.
  - When selected, the gated Jira runtime and the staging connector rehearsal
    keep provider-owned Jira connection state in
    `jira-person-connections.sqlite`; the staging restore wrapper retains the
    rehearsal copy. As with every person provider's file, the Authority
    creates it private (0600) and will not start with one other users can
    read.
  - `extraction-attempts.sqlite` is the paid-extraction ledger and durable
    spend history. Keep it with backups and never delete it to clear a
    [held extraction](../../deploy/organization-authority/README.md#inspect-and-retry-a-held-extraction).
  - `staging-synthetic-meetings.sqlite` (staging only) holds custom synthetic
    meeting submissions; retain it with the Authority state on restore.

The V2 root manifest binds six roles: Authority, control plane, record log,
and retrieval facts, lexical, and content. Each database carries a V1 database
manifest and its stable role application ID.

The Authority database stores bounded pre-record meeting and decision content,
but no embeddings and no canonical approved organization-record truth. The
record and retrieval files are separate even though one Authority process
composes them.

Processing state, source configuration bindings, pending approvals, approval
receipts, replay checkpoints, and singleton execution locks are server-owned.
No corresponding mutable state exists in the Person client.

## Deployment boundary

The Authority runs as one process with one persistent volume. Build and
runtime closure are enforced by the Dockerfile and architecture tests. A
multi-replica deployment requires a later persistence/coordination design and
is outside minimum V1.

See [Person client architecture](person-client-architecture.md),
[meeting processing core and adapters](meeting-processing-core-and-adapters.md), and
[Identity and onboarding](identity-and-onboarding.md) for the adjacent
boundaries.
