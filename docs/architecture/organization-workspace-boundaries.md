# N=2/org=1 onboarding/access workspace boundaries

**Status:** Shared onboarding/access protocols complete; no organization runtime behavior

This architecture establishes explicit package and deployable boundaries before
moving any implementation. The first implementation slice enrolls two
independently keyed installations into exactly one organization and verifies
their access and revocation state. It is the N=2 onboarding/access slice, not
full parity with the experimental ingest-and-receipt pilot. A
multi-organization ECHO control plane is a later phase.

## Product axes

`N` and organization count are independent:

```text
current       N=1, local installation, no central dependency
next          N=2, org=1, one organization-scoped authority
later         N>=2, org>=2, multi-organization control plane
```

N=2 is the first trust test, not a permanent two-person limit. Adding more
people inside the same organization uses the same membership and installation
relationships. Supporting a second organization introduces tenancy and must be
an explicit architecture change.

## Repository ownership

```text
src/                              employee-machine product
  core/                           organization-agnostic processing
  product/organization/           local enrollment/client/access state

packages/                         contracts shared across trust boundaries
  federation-protocol/            canonicalization and signature primitives
  organization-protocol/          signed organization facts
  organization-api/               future transport-contract boundary

services/
  organization-authority/         one centrally hosted org=1 deployable

src/experimental/n2/              frozen until full experimental-pilot parity
```

The root package remains the local Echo Brain product. Workspaces are built by
`tsconfig.workspaces.json`; the existing local build remains separate. The root
product does not yet import workspace packages because its exact artifact
closure must learn how to stage them first.

## Dependency direction

```text
federation-protocol
        ↑
organization-protocol
        ↑
organization-api
      ↗   ↖
local       organization-authority
product     service
```

- Protocol packages never import product, service, database, cloud, or UI code.
- Local product and central service never import one another.
- Cross-workspace imports use declared package exports, never relative paths.
- Stable code never imports `src/experimental/n2`.
- Signed trust documents and ordinary HTTP DTOs remain different contracts.

The dedicated federation protocol package is required because the experimental
N=2 code currently reaches into local federation canonicalization and signing
primitives. Extracting the pure behavior prevents the future server from
depending on laptop-product implementation or duplicating security-sensitive
logic.

## Central service layers

```text
domain        pure organization and access rules
application   commands, queries, and transaction-sized ports
adapters      persistence, signing, and authentication implementations
presentation  transport and presentation implementations
composition   configuration and concrete wiring
```

Dependencies point inward. Routes and pages call application use cases and
never query persistence directly. Domain and application code know no vendor,
database, transport framework, environment variable, or UI detail.

The first service is bound to one organization and contains no
multi-organization tenancy, global operator role, billing, or
cross-organization query behavior. Organization bootstrap and administrative
transport details remain deferred. Authority private keys live behind the
signing port and are never stored in organization state or browser state.

## Planned persistence boundary

The scaffold creates no migration or table. Central authority persistence and
installation-local organization state remain separate ownership boundaries.
Their exact records, tables, counts, indexes, transactions, migrations, and
storage providers are deferred. The existing N=1 database remains unchanged.

The central side will eventually persist the authority facts required by the
accepted org=1 onboarding/access behavior. The local side will eventually
persist the minimum evidence needed to pin and verify that authority and its
enrollment result. The domain model and persistence mapping are not selected by
this scaffold.

Event ingest, batch receipts, meetings, decisions, reasoning state, embeddings,
and organization knowledge are outside the onboarding slice.

## Promotion sequence

1. **Complete:** establish workspaces, build references, manifests, import
   fences, and test ownership without runtime behavior.
2. **Complete:** promote federation primitives with golden byte/signature
   fixtures and compatibility tests against the current product behavior.
3. **Complete:** promote the self-contained authority descriptor, enrollment
   request, enrollment receipt, and fresh installation access-state protocol
   with schemas and frozen fixtures.
4. **Next:** add workspace-package artifact staging, then implement the
   single-organization authority and local enrollment client. The client must
   atomically retain each verified access-state high-watermark before treating
   an active lease as permission; missing or corrupt retained state fails
   closed and requires recovery or re-enrollment. It must persist the authority
   descriptor and its independently authenticated pin as separate trust inputs,
   then reconstruct the process-local pinned-authority handle on every start.
5. Run the live N=2/org=1 onboarding, access-state, and revocation gate.
6. Place the Brain above the verified federation permission gate and run the
   separate N=2 reasoning test.
7. Promote organization ingest and batch receipts, then pass their live parity
   gate before claiming full parity with the experimental pilot.

The experimental implementation remains reference evidence through the
onboarding/access slice and until the later ingest-and-receipt parity gate
passes. Compatibility code may depend from experimental to stable; the reverse
direction is forbidden.
