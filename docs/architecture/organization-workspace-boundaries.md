# Organization workspace boundaries

**Status:** Current

The repository contains eight workspaces. The root package is private
workspace orchestration only: it has no executable, runtime export, product
database, or packable application.

## Workspace graph

```text
federation-protocol
  -> organization-protocol
  -> organization-api
  -> person-client

federation-protocol
  -> organization-record
  -> organization-retrieval

organization-control-plane ─┐
organization-record ────────┼-> organization-authority
organization-retrieval ─────┤
organization-api/protocol ──┘
```

- Protocol packages contain signed documents, canonicalization, identifiers,
  and HTTP DTOs; they import no product or service implementation.
- The Person client depends only on federation, organization protocol, and
  organization API.
- `organization-control-plane` owns provider connections and grants and has no
  workspace dependency.
- `organization-record` and `organization-retrieval` depend only on federation
  canonicalization.
- The Authority is the sole composition root across server workspaces.
- Cross-workspace imports use declared package exports.

The checked registry is
[`tools/workspace-source-boundaries.v1.json`](../../tools/workspace-source-boundaries.v1.json).
Each workspace owns every TypeScript file below its source root, and every
owned production file must match exactly one layer rule.

## Product split

There are two operational artifacts:

```text
Person tarball       -> src/product/person-client
Authority container -> services/organization-authority + server dependencies
```

The Authority image does not copy Person source. The Person packer builds only
its three dependency workspaces and the client. The legacy root machine
runtime, local SQLite state, installation signer, LaunchAgent, JSONL outbox,
and fleet updater are removed.

`product/source-boundary.v1.json` is now a retirement fence. Its entry-point
closure is intentionally empty and its removed-root list prevents the old
machine product from silently reappearing outside the Person workspace.

## Authority layers

```text
domain        pure organization and access rules
application   commands, queries, and transaction ports
adapters      SQLite, signing, credentials, OIDC, private files
presentation  JSON routes and explicit provider ingress
composition   configuration and concrete wiring
processing    meeting core, adapters, admitted-meeting cycle, replay, and durability
```

Routes call application use cases rather than SQLite. The service is bound to
one organization and contains no tenant registry, billing, or cross-org query.
The built-in listener stays loopback-only behind the trusted reverse proxy.

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
