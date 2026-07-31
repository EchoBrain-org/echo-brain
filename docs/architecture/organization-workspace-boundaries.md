# One-organization workspace boundaries

**Status:** Current — the primary repository map

The near-term topology is one organization with any practical number of
employees and installations. A second organization is a later tenancy change,
not a dormant branch.

## Repository ownership

```text
src/
  core/                         vendor-neutral decision pipeline
  adapters/                     source, processor, approval, delivery
  product/                      CLI, runtime composition, approval, storage
  product/machine/              installation key and OS ports
  product/federation/           local identity and signed records
  product/organization/         enrollment client and access state
  infrastructure/               atomic writes, SQLite migration, file locks
  util/                         narrow shared primitives

packages/
  federation-protocol/          canonical signatures and identifiers
  organization-protocol/        signed organization facts
  organization-api/             HTTP request/response contracts

services/
  organization-authority/       one customer-hosted organization
  organization-control-plane/   customer-owned Slack connection and policy
```

The root package is the employee product. The authority is a separate
workspace and deployment. They share the three protocol/API packages and never
import one another. The authority additionally depends on the organization
control plane, which the employee product does not.

`organization-control-plane` is a library, not a service, despite its
`services/` path. It declares no `bin`, has no process entry point of its own,
opens no listener, and does not appear in
`deploy/organization-authority/compose.yaml`, whose only two containers are
`authority` and `proxy`. It is linked into the authority process and imported
solely from `services/organization-authority/src/composition`. Read
`services/` as two hosted workspaces, not as two running processes.

The remaining tracked roots support that code rather than shipping in it:
`product/` holds the root source-boundary manifest, `tools/` the build script
and the boundary checker, `schemas/` the published JSON Schemas,
`deploy/organization-authority/` the one-machine authority deployment,
`tests/` the suites mirroring the ownership above, and `docs/` this map and
its deep-dives.

## Dependency direction

```text
federation-protocol
        ↑
organization-protocol
        ↑
organization-api
      ↗          ↖
product      authority → organization-control-plane
```

- Protocol packages do not import product, service, database, or UI code.
- `organization-control-plane` is a library with no workspace dependencies of
  its own; only the authority's composition layer imports it.
- Cross-workspace imports use package exports.
- Signed trust documents and ordinary HTTP DTOs remain separate contracts.
- Private-key lifecycle stays behind signer ports; protocol packages know only
  public descriptors and signatures.

Checked source-boundary manifests enforce this graph, and they divide the tree
between them. `product/source-boundary.v1.json` governs `src/` two ways at
once. Its layer rules apply to every matching module in the worktree, reachable
or not; its entry-point closure additionally requires each reachable module to
sit inside the allowlist. The check closes the gap between the two in both
directions: a reachable module outside the allowlist is an error, and so is an
allowlisted module no entry point can reach. Every tracked module under `src/`
is therefore both allowlisted and reachable, and dead weight cannot accumulate
inside the packed artifact.
`tools/workspace-source-boundaries.v1.json` registers seven manifests that
govern `packages/*/src`, `services/*/src`, and two refinement sub-boundaries
inside `src/product` by ownership: every file under a declared `source_root`
must be owned and must match exactly one layer rule. Paths under
`src/product/federation/` and `src/product/organization/` are the intersection
of the two artifacts, and both checks must pass.

## Authority layers

```text
domain        pure organization and access rules
application   commands, queries, and transaction ports
adapters      SQLite, signing, credentials, private files
presentation  JSON routes and server-rendered admin console
composition   configuration and concrete wiring
```

Routes call application use cases and never query SQLite directly. The service
is bound to one organization and contains no tenant registry, global operator,
billing, or cross-organization query.

Employee and administrator routes share one public HTTPS origin. The built-in
listener remains loopback-only behind a standard TLS reverse proxy that strips
external proxy headers and injects the authority's trusted proxy token and a
bounded `cid_` client identity.

## Persistence

The central and local databases remain separate:

- Central state owns authority metadata, principals, memberships, digest-only
  enrollment grants, enrollments, immutable access states, idempotent lease
  commands, and audit records.
- Local state owns the authority pin, verified network route and optional
  internal CA, enrollment evidence, and the access high-watermark alongside
  the meeting-to-decision product state.
- Organization-control state references Authority IDs while owning verified
  provider identities, opaque connection handles, exact product-adapter
  bindings, direct membership grants, and integration audit. It never copies
  Authority membership state or stores provider bearer credentials or product
  content.

The employee client stores its exact signed request before sending a grant and
atomically commits verified access state before returning `permitted: true`.
Product runtime work rechecks that durable decision before adapter contact and
renews the short signed lease while running. Authority relocation changes only
the network route after the exact same pinned descriptor is proved at the new
origin.
The authority stores no meeting, decision, reasoning, or embedding data.

## Deployment

The authority runs as one process with one persistent state volume containing
the Authority and integration-policy SQLite databases. The
portable one-machine deployment is documented in
[`deploy/organization-authority`](../../deploy/organization-authority/README.md).
Multi-replica operation requires a later persistence and coordination design.

## Implemented but inactive on the pilot

Founder identity cutover has not happened, and the federation lane is dormant
because of it. `src/product/federation/` is implemented, compiled, and covered
by tests, and it is inactive on a normal installation.
`openFounderFederationRuntime` in `src/product/federation/runtime-wiring.ts`
loads the active identity bundle; with no committed bundle it takes the
`active === null` branch, returns `identityEnabled: false`, and supplies
`projectApproved` and `ensureIndependentCopy` as failing stubs. Signed
projection, the federated outbox, and independent-copy publication are
unreachable until the `identity-bootstrap` ceremony is committed. That branch,
not the active one, is the pilot's normal state.

This is not a small corner of the tree. `src/product/federation/` is roughly
20,700 lines, close to 30 percent of the repository's production TypeScript.
Read the federation half of
[identity, onboarding, and federation](identity-onboarding-and-federation.md)
as a described capability rather than as observed pilot behavior; the
onboarding and access half of that document describes what actually runs.

None of it is dead code. It compiles, it is under test, and the federated
approval capture is wired into the decision-node store in both the active and
inactive lanes, so it sits on the approval path while inert. It is not removed
because the runtime composes it unconditionally.

The bundled `llm` decision processor is a different case and is not out of
scope. The composition root registers it alongside `structured-text`, and the
top-level `README.md` documents its supported provider configuration. It is a
selectable processor that the baseline configuration happens not to select.

## Deferred product-control boundary

The current milestone stops at an organization-operated authority. It does not
implement a vendor entitlement, billing, fleet, or remote-control service.
Future product work must preserve this trust boundary:

- the organization owns authority operations, memberships, employee and
  installation revocation, private keys, database, backups, ingress, and logs;
- ECHO has no remote shell, database credential, administrator token, signing
  key, or organization audit visibility;
- a future ECHO-controlled capability, if introduced, is limited to a
  pseudonymous organization-level signed entitlement that can expire or be
  revoked without carrying employee or meeting data; and
- organization-level entitlement and organization-local employee access remain
  separate protocols and authorities.

That future entitlement is intentionally not present in the current runtime.
The authority continues to operate solely from organization-owned state and
the existing pinned enrollment/access protocol; it is not a hosting mode for a
future ECHO entitlement.

The customer-hosted organization control plane is described in
[`organization-control-plane.md`](organization-control-plane.md). Minimum V1
implements organization Slack activation and the exact signed Slack
approve/reject permission path. General employee connection discovery,
multi-tool projection, Teams, Granola, project-management tools, and broader
authorization APIs remain later milestones.
