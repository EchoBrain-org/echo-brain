# N=2/org=1 onboarding/access workspace boundaries

**Status:** Phase 4 runtime complete; Phase 5 one-machine rehearsal available;
physical N=2/org=1 gate pending

This architecture establishes explicit package and deployable boundaries before
moving any implementation. The first implementation slice enrolls two
independently keyed installations into exactly one organization and verifies
their access and revocation state. It is the N=2 onboarding/access slice, not
full parity with the experimental ingest-and-receipt pilot. A
multi-organization ECHO control plane is a later phase.

## Product axes

`N` and organization count are independent:

```text
default       N=1, local installation, no central dependency
candidate     N=2, org=1, one organization-scoped authority
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
  organization-api/               transport DTOs and signed API commands

services/
  organization-authority/         one centrally hosted org=1 deployable

src/experimental/n2/              frozen until full experimental-pilot parity
```

The root package remains the local Echo Brain product. Workspaces are built by
`tsconfig.workspaces.json`. Its artifact now compiles and packs the three shared
workspace packages from the exact materialized source commit as bundled npm
dependencies. The central authority is deliberately not bundled into the
employee-machine product. It has a separate exact-commit release boundary under
`release/organization-authority/`, with its own artifact manifest, tarball, and
checksum.

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

The service is bound to one organization and contains no
multi-organization tenancy, global operator role, billing, or
cross-organization query behavior. Its built-in bounded JSON/HTTP presentation
binds only to loopback behind a TLS terminator. Authority private keys live
behind the signing port and are never stored in authority domain rows or
browser state. The included file signer is development-only and requires an
explicit opt-in; a hosted production signer remains a deployment decision.

## Persistence boundary

Central authority persistence and installation-local organization state are
separate ownership boundaries:

- The central SQLite database has eight authority-owned tables: metadata,
  principals, memberships, digest-only grants, enrollments, immutable access
  states, access-command idempotency, and an append-only audit log.
- The installation SQLite database retains its ten prior product tables and
  adds three installation-owned tables: the write-once authority pin,
  enrollment evidence, and the atomic access-state high-watermark. It now has
  thirteen tables in N=2-capable builds; N=1 operation does not populate the
  three organization tables.

The local client writes its exact signed request before sending a grant. It
commits the verified access document, sequence/hash pointer, and trusted-clock
high-watermark in one transaction before returning `permitted: true`. Missing,
corrupt, expired, rolled-back, or post-revocation state fails closed.

Event ingest, batch receipts, meetings, decisions, reasoning state, embeddings,
and organization knowledge are outside the onboarding slice.

## Phase 5 evidence boundary

The [one-machine rehearsal](../runbooks/phase5-one-machine-rehearsal.md) builds
the employee and authority artifacts from one commit and installs two isolated
employee copies plus the authority on a `darwin/x64` host. Its closed evidence
vector has 23 passing checks and five visibly blocked physical/target checks.
A valid report is always `rehearsal_passed` with `phase5_gate: incomplete`; the
unsupported-host acknowledgement is permission to rehearse, not a platform
waiver.

The rehearsal tooling is an operator and qualification boundary, not a runtime
dependency of either deployable. Its loopback authenticated edges model the
identity-injection contract but do not claim production TLS. Final Phase 5
requires two physical `darwin/arm64` installations, Secure Enclave keys, a real
authenticated TLS terminator, and an independent authority-pin handoff using
the exact recorded artifact bytes.

## Promotion sequence

1. **Complete:** establish workspaces, build references, manifests, import
   fences, and test ownership without runtime behavior.
2. **Complete:** promote federation primitives with golden byte/signature
   fixtures and compatibility tests against the current product behavior.
3. **Complete:** promote the self-contained authority descriptor, enrollment
   request, enrollment receipt, and fresh installation access-state protocol
   with schemas and frozen fixtures.
4. **Complete:** add workspace-package artifact staging, then implement the
   single-organization authority and local enrollment client. The client must
   atomically retain each verified access-state high-watermark before treating
   an active lease as permission; missing or corrupt retained state fails
   closed and requires recovery or re-enrollment. It must persist the authority
   descriptor and its independently authenticated pin as separate trust inputs,
   then reconstruct the process-local pinned-authority handle on every start.
5. **In progress:** the exact-artifact one-machine N=2/org=1 rehearsal covers
   every locally provable onboarding, access-state, restart, corruption, and
   revocation check. The phase completes only after the remaining five checks
   pass on two physical target machines; the one-machine report cannot be
   promoted or edited into qualification evidence.
6. Place the Brain above the verified federation permission gate and run the
   separate N=2 reasoning test.
7. Promote organization ingest and batch receipts, then pass their live parity
   gate before claiming full parity with the experimental pilot.

The experimental implementation remains reference evidence through the
onboarding/access slice and until the later ingest-and-receipt parity gate
passes. Compatibility code may depend from experimental to stable; the reverse
direction is forbidden.
