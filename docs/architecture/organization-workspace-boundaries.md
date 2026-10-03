# Organization workspace boundaries

**Status:** Current

The root `package.json` workspace list is the source of truth: eight neutral
packages, the provider workspaces under `providers/`, the Authority service,
and the Person client. The root package only orchestrates workspaces.

`packages/` owns inward contracts and reusable implementations. `services/`
owns deployable processes and their lifecycle. `providers/<provider>/` owns
that provider's wire formats, credentials, persistence translations, model
vocabulary, command/UI fragments, tests, and runtime assets. Slack and Jira
have separate client and server workspaces because the Person artifact must
remain free of Authority code and native SQLite.

## Dependency direction

Neutral modules can import other neutral modules. A neutral library cannot
import a composing application. Providers depend inward on neutral public
exports; they cannot import another provider or the Authority service.
Explicit bootstrap modules select implementations and inject ports. Neutral
modules cannot import bootstrap modules. Cross-workspace imports use explicit
public exports, and the complete workspace graph must remain acyclic.

- `organization-processing` owns processing contracts, the bounded cycle, generic
  LLM prompt/grounding behavior, and processing state.
- `organization-authority-kernel` owns reusable Authority contracts, rules,
  telemetry, state verification, SQLite baseline access, and bundle ports.
- Federation/API/protocol, control-plane, record and retrieval retain their
  existing responsibilities. Record has no runtime dependency on protocol.
- The Authority and Person composition modules select provider implementations.
  The deployed Authority selects its product profile; it does not ship unused
  OpenAI, Anthropic or Ollama transports.

The registry is
[`tools/workspace-source-boundaries.v1.json`](../../tools/workspace-source-boundaries.v1.json).
Every production module has an owner. The gate follows whole modules, including
unused re-exports, namespace/side-effect imports, type queries and literal dynamic
imports. Runtime asset references obey the same direction. The Explorer
deployment has an explicit source assembly shared by its builder and the same
architecture gate. Deployment JavaScript has exact external and builtin import
allowlists shared by the gate and builder, with computed imports and loader
acquisition rejected. The native Swift app and its assemblies are retired; the
gate rejects any Swift source under `product/` or `providers/`.
There is no provider-name registry, symbol-based
traversal or exception mechanism.

## Product and build boundaries

The Person tarball contains the client, federation/protocol/API and the Slack
and Jira client fragments. It includes public versioned data exports and
contains no Authority, processing, server provider or SQLite dependency. Its
dedicated build (`tools/build.mjs --person-client`) compiles only these
workspaces. The Authority image contains the workspace dependency closure and
frozen SQL/provider assets that `deploy/organization-authority/Dockerfile`
copies into its runtime stage. The Electron
desktop app in `product/echo-desktop` is not a root workspace and imports no
workspace source; it loads the built Person client package at run time.

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
Authority transports live with the composing service. Generic processing and
record tests retain independent fixture implementations and signed protocol
helpers without importing a provider or application workspace.

The Person client consumes generic v4 tool status; v3 remains for older
clients. Slack owns its commands and retained v2 disconnect decoder. The v2
HTTP contract remains provider-owned for installed clients; v3 and v4 admit up
to 32 independently identified tools without imposing a provider's identity
grammar.

`product/source-boundary.v1.json` declares bootstrap modules, provider folders,
source assemblies and retired roots. The legacy machine runtime remains absent.
Its former product graph fields must remain empty: active products are checked
through their registered workspace boundaries. The gate retains source
tombstones and provider ownership without maintaining a second graph walker
for the retired runtime.

## Authority layers

Routes call application use cases rather than SQLite. The service owns one
organization, Person identity and sessions, authorization, and process lifecycle.
Provider bundles receive explicit state/action/transport ports. The listener stays
loopback-only behind the trusted reverse proxy. Stopped-state setup selects the
fixed V1 Granola/OpenRouter/Slack profile. Its manifest, readiness checks and
finalization require Slack; setup is not a swappable provider port. Another
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
  Person originals and admitted source revisions, including opt-in retained
  context captures. Custody grants no read;
- the control-plane database owns verified provider identity, opaque
  connection handles, Person identity links, and private approval evidence;
- `record-log.sqlite` is the append-only organization record;
- retrieval generations are immutable projections built from record state; and
- when selected, the gated Jira runtime and the staging connector rehearsal keep
  provider-owned Jira connection state in `jira-person-connections.sqlite`. It
  is not a manifest role; the staging restore wrapper retains the rehearsal
  copy as a sidecar.

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
