# Organization workspace boundaries

**Status:** Current

The repository contains eighteen workspaces: eight neutral packages, eight
provider workspaces under seven provider folders, the Authority service, and
the Person client. The root package only orchestrates workspaces.

`packages/` owns inward contracts and reusable implementations. `services/`
owns deployable processes and their lifecycle. `providers/<provider>/` owns
that provider's wire formats, credentials, persistence translations, model
vocabulary, command/UI fragments, tests, and runtime assets. Slack has separate
client and server workspaces because the Person artifact must remain free of
Authority code and native SQLite.

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
imports. Runtime asset references obey the same direction. Native Swift and the
Explorer deployment have explicit source assemblies shared by their builders
and the same architecture gate. There is no provider-name registry, symbol-based
traversal or exception mechanism.

## Product and build boundaries

The Person tarball contains the client, federation/protocol/API and the Slack
client fragment. It includes public versioned data exports and contains no
Authority, processing, server provider or SQLite dependency. Its dedicated build
compiles these five workspaces. The Authority image contains its fourteen-workspace
dependency closure and the required frozen SQL/provider assets.

The architecture suite compiles all eight neutral packages in an isolated tree
with no provider, Person, service or prebuilt workspace output available.
External dependencies remain installed; workspace symlinks point only into the
isolated tree. Full source tests and the existing native/offline artifact checks
exercise the composed products. No additional CI job is needed.

Neutral package tests may import neutral workspace code, their own test
fixtures, and shared neutral test support. The test-layer architecture check
uses the module-reference parser to enforce this across every `packages/*/test`
root and shared support, including type imports and re-exports. Provider-specific
contract tests live with their provider; tests that combine a provider with
Authority transports live with the composing service. Generic processing and
record tests retain independent fixture implementations and signed protocol
helpers without importing a provider or application workspace.

The native account shell consumes generic v3 tool status and an injected UI
interface. Slack owns its actions and retained v2 disconnect decoder. The v2
HTTP contract remains provider-owned for installed clients; v3 admits up to
32 independently identified tools without imposing a provider's identity grammar.

`product/source-boundary.v1.json` declares bootstrap modules, provider folders,
source assemblies and retired roots. The legacy machine runtime remains absent.

## Authority layers

Routes call application use cases rather than SQLite. The service owns one
organization, Person identity and sessions, authorization, and process lifecycle.
Provider bundles receive explicit state/action/transport ports. The listener stays
loopback-only behind the trusted reverse proxy. Stopped-state setup selects the
concrete product profile, while provider verification, identity SQL, credential
interpretation and source admission proofs stay in their provider folders.

## Persistence ownership

The server uses separate databases with explicit responsibilities:

- `authority.sqlite` owns Authority metadata, principals, memberships,
  Person/OIDC identity and sessions, authorization/audit state, integration
  anchors, retained V1 enrollment/access compatibility, and bounded pre-record
  processing state including raw meeting and decision documents;
- the control-plane database owns verified provider identity, opaque
  connection handles, adapter bindings, grants, and integration audit;
- `record-log.sqlite` is the append-only organization record;
- `record-derived.sqlite` is rebuilt deterministically from that log; and
- retrieval generations are immutable projections built from record state.

The Authority database stores bounded pre-record meeting and decision content,
but no embeddings and no canonical approved organization-record truth. The
record and retrieval files are separate even though one Authority process
composes them.

Processing state, source configuration bindings, pending approvals, delivery
receipts, replay checkpoints, and singleton execution locks are server-owned.
No corresponding mutable state exists in the Person client.

## Compatibility boundary

Historical migrations remain immutable. V1 installation enrollment, access
state, record-ingest, and approval binding code remains server-side while
surviving record/Slack operations still resolve those identities. It can be
retired only after additive Person-based writer and approval bindings replace
those call sites and existing rows are drained or preserved as read-only
history.

The machine fleet-update API is different: no deployed server component calls
it and no current machine artifact consumes it, so its application and HTTP
surface is retired. Migration `0004` and historical rows remain for schema
compatibility; server deployment evidence does not masquerade as a fleet
receipt.

## Deployment boundary

The Authority runs as one process with one persistent volume. Build and
runtime closure are enforced by the Dockerfile and architecture tests. A
multi-replica deployment requires a later persistence/coordination design and
is outside minimum V1.

See [Person client architecture](person-client-architecture.md),
[meeting processing core and adapters](meeting-processing-core-and-adapters.md), and
[Identity and onboarding](identity-and-onboarding.md) for the adjacent
boundaries.
