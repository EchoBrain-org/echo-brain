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
  product/organization/         enrollment client and access state
  product/person-client/        installable Person-authenticated thin client
  infrastructure/               atomic writes, SQLite migration, file locks
  util/                         narrow shared primitives

packages/
  federation-protocol/          canonical signatures and identifiers
  organization-protocol/        signed organization facts
  organization-api/             HTTP request/response contracts

services/
  organization-authority/       one customer-hosted organization
  organization-control-plane/   customer-owned Slack connection and policy
  organization-record/          the organization's append-only decision log
                                and its derived graph
  organization-retrieval/       rebuildable permission-aware retrieval
                                generations
```

The shippable employee-side package is now `@echo-brain/person-client`. The
root `echo-brain` package remains a migration compatibility and test shell; it
is not a release artifact and cannot be installed offline from its tarball.
The Person client and the separately deployed Authority share only the three
protocol/API packages and never import one another's implementation. The
Authority additionally depends on the organization control plane, which the
Person client does not. `npm run pack:person-client -- /absolute/output/dir`
is the sole machine-package path: it builds from a clean commit and emits the
pinned tarball hash.

`organization-control-plane`, `organization-record`, and
`organization-retrieval` are libraries, not processes, despite their
`services/` path. None declares a `bin`, has a process entry point of its own,
or opens a listener, and none appears in
`deploy/organization-authority/compose.yaml`, whose only two containers are
`authority` and `proxy`. All three libraries are linked into the Authority
process and
imported through the Authority composition boundary. Read `services/` as four
hosted workspaces, not as four running processes.

The remaining tracked roots support that code rather than shipping in it:
`product/` holds the root source-boundary manifest, `tools/` the build script,
the boundary checker, and the internal-live release tool, `schemas/` the
published JSON Schemas,
`deploy/organization-authority/` the one-machine authority deployment,
`tests/` the suites mirroring the ownership above, and `docs/` this map and
its deep-dives.

## Dependency direction

The direct internal workspace dependencies declared in `package.json` files
are:

| Workspace | Direct internal dependencies |
| --- | --- |
| Person client | `federation-protocol`, `organization-protocol`, `organization-api` |
| root migration shell | `person-client`, `organization-authority`, all three protocol/API packages |
| `federation-protocol` | none |
| `organization-protocol` | `federation-protocol` |
| `organization-api` | `federation-protocol`, `organization-protocol` |
| `organization-authority` | all three protocol/API packages, `organization-control-plane`, `organization-record`, `organization-retrieval` |
| `organization-control-plane` | none |
| `organization-record` | `federation-protocol` |
| `organization-retrieval` | `federation-protocol` |

The package manifests and checked source-boundary manifests are authoritative;
this table is a readable projection of those files.

- Protocol packages do not import product, service, database, or UI code.
- `organization-control-plane` is a library with no workspace dependencies of
  its own; only the authority's composition layer imports it.
- `organization-record` depends on `federation-protocol` alone — one
  canonicalization, no second copy — and deliberately does not import
  `organization-protocol`: the durable signed shapes stay in the protocol
  package and the authority's composition layer adapts between them.
- `organization-retrieval` also depends on `federation-protocol` rather than
  on `organization-record`; the Authority composition layer coordinates data
  between the two libraries.
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
`tools/workspace-source-boundaries.v1.json` registers nine manifests that
govern `packages/*/src`, `services/*/src`, and two boundaries inside
`src/product` by ownership: every file under a declared `source_root` must be
owned and must match exactly one layer rule. `src/product/organization/`
remains a refinement of the root product boundary. The installable
`src/product/person-client/` workspace is delegated out of the root product
layer and closure checks; the root CLI can consume it only through its public
package export.

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
- Organization-record state is two further files in the same state directory:
  `record-log.sqlite`, the append-only log of human-approved acts and the
  truth, and `record-derived.sqlite`, the deterministic graph derived from it
  and rebuildable from it by the stopped-state `rebuild-derived` maintenance
  command, which replays the log into a fresh derived database and swaps it in
  atomically. Only the derived half is rebuildable: nothing recreates a log, so
  a state directory missing `record-log.sqlite` requires full-state restore.
  They never share a file with each other or with `authority.sqlite`,
  which is what keeps the authority's "stores no decisions" charter true at
  the database level. Both are published by
  `init-development` (and by `install-integrations` for a state directory that
  provably predates them), bound into the runtime fingerprint by file identity,
  and verified read-only by serve preflight; serve never creates them.
  Publication is proved by a durable pair that lives outside both files: the
  `authority-record-installation.v1.json` marker in the state directory and a
  record installation anchor in `authority.sqlite`. Serve refuses an unanchored
  record store, so an unanchored state provably holds no history and may be
  bootstrapped. Once anchored, serve and installation fail closed on any missing
  record file. `rebuild-derived` is the sole exception: with the existing log,
  marker, and Authority anchor all valid, it may recreate or replace only the
  derived file. A missing log, marker, or anchor requires full-state restore.
  The append chain is walked at process start and again
  at a successful stop — which is what makes a stopped state safe to back up —
  and a halted derivation is fatal at startup and after it.

The employee client stores its exact signed request before sending a grant and
atomically commits verified access state before returning `permitted: true`.
Product runtime work rechecks that durable decision before adapter contact and
renews the short signed lease while running. Authority relocation changes only
the network route after the exact same pinned descriptor is proved at the new
origin.
`authority.sqlite` stores no meeting, decision, reasoning, or embedding data.
The organization-record design hosts the org decision log in the same process
as separate database files, so that charter is a database-level claim and stays
true.

Member machines submit one signed act at a time to
`POST /v1/record-envelopes` on the existing authority listener. That route is
the single exemption to the shared 16 KiB organization API body limit — an
approved brief with verbatim evidence spans routinely exceeds it — and bounds
the canonical envelope at 256 KiB plus the exact 20-byte request wrapper before
JSON parsing; every other route keeps the shared limit unchanged.

## Deployment

The authority runs as one process with one persistent state volume containing
the Authority, integration-policy, and organization-record SQLite databases. The
portable one-machine deployment is documented in
[`deploy/organization-authority`](../../deploy/organization-authority/README.md).
Multi-replica operation requires a later persistence and coordination design.

## Retired founder-provenance surface

Founder identity cutover never happened on the pilot, and the local
founder-provenance surface built on it — roughly 20,700 lines under
`src/product/federation/`, close to 30 percent of the repository's production
TypeScript, for a lane no installation ever entered — is deleted entirely,
including every reader that could parse, validate, or recover that state.
What survives is one presence-only detector and refusal in
`src/product/retired-founder-provenance.ts`, the packaged build identity
relocated to `src/product/build-identity.ts`, and the product boundary's
`removed_internal_roots` pin. The refusal gate's runtime behavior — what it
fences, what stays reachable, and the recovery path — is documented once in
[Product runtime](product-runtime.md#identity-modes);
[Identity and onboarding](identity-and-onboarding.md) covers the live
onboarding/access surface.

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
