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
  product/machine/                installation and operating-system ports
  product/storage/                installation-owned database policy
  product/federation/             stable local trust and permission gate
  product/organization/           local enrollment/client/access state

packages/                         contracts shared across trust boundaries
  federation-protocol/            canonicalization and signature primitives
  organization-protocol/          signed organization facts
  organization-api/               transport DTOs and signed API commands

services/
  organization-authority/         one centrally hosted org=1 deployable
  organization-admin-edge/        authenticated administrator HTTPS edge

src/experimental/n2/              frozen, separately compiled/tested reference
```

The root package remains the local Echo Brain product. Workspaces are built by
`tsconfig.workspaces.json`. Its artifact now compiles and packs the three shared
workspace packages from the exact materialized source commit as bundled npm
dependencies. The central authority is deliberately not bundled into the
employee-machine product. It has a separate exact-commit release boundary under
`release/organization-authority/`, with its own artifact manifest, tarball, and
checksum. The administrator edge is a third exact deployable under
`release/organization-admin-edge/`; it is bundled into neither the employee
artifact nor the authority artifact and packages no runtime certificate,
private key, client CA, proxy credential, configuration, log, or supervisor
state.

The stable TypeScript build excludes `src/experimental/`, and the product
builder copies no experimental migration, schema, or SQL asset into `dist/`.
The frozen pilot is compiled, linted, and behavior-tested through its own
TypeScript, ESLint, and Vitest lanes. Its tests live under
`tests/experimental/n2/`, not in stable product qualification. Repository-wide
dependency hygiene still applies to every checked-in source file. The separate
`experimental-n2.yml` workflow reports regressions without blocking the stable
release gate.

## Dependency direction

```text
federation-protocol
        ↑
organization-protocol
        ↑
organization-api
      ↗          ↑             ↖
local      organization-    organization-
product    authority        admin-edge
```

- Protocol packages never import product, service, database, cloud, or UI code.
- Local product and central service never import one another.
- The administrator edge may depend on shared API/protocol contracts but never
  on authority implementation, persistence, or product code.
- Cross-workspace imports use declared package exports, never relative paths.
- Stable code never imports `src/experimental/n2`.
- Signed trust documents and ordinary HTTP DTOs remain different contracts.

The federation protocol package is the single implementation owner for
canonicalization, identifiers, descriptor validation, and signature profiles.
Product compatibility modules delegate to it; neither the laptop nor the
authority service carries a second security-sensitive implementation. The
private-key lifecycle remains a machine port because protocol packages handle
public facts, not operating-system key custody.

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

## Administrator edge boundary

The administrator edge is a provider-neutral transport and authentication
boundary for exactly one configured administrator HTTPS origin. It is not an
authorization service or a second authority presentation layer:

```text
administrator browser
  -- TLS server authentication + mandatory client certificate
  -- explicit client-SPKI SHA-256 allowlist
  --> organization-admin-edge
        -- sanitized bounded HTTP
        -- trusted proxy token + derived cid_ identity
        --> bare loopback organization-authority origin

employee invitation
  --> separately configured employee_authority_base_url
      (never proxied by the administrator edge)
```

Both successful client-certificate chain validation and an explicit configured
SPKI pin match are mandatory. Network or source-IP allowlists are optional
defense in depth and never replace those checks. The edge accepts one canonical
public HTTPS origin and requires the TLS SNI and HTTP `Host`/`:authority` to
match it exactly. The upstream target is one bare `http://127.0.0.1:<port>` or
`http://[::1]:<port>` origin; DNS names, redirects, fallback origins, paths,
queries, fragments, and remote authority hops are forbidden.

The public route policy is a method-and-canonical-path allowlist for the
server-rendered console. `GET /admin/edge-config` is answered locally with only
the configured `employee_authority_base_url`. It is deployment metadata,
equivalent to the administrator CLI's explicit employee authority URL, and is
not an authority decision. The edge never forwards that route and never
exposes `/v1/enrollments`, `/v1/access-leases`,
`/_echo/runtime-status`, administrator JSON APIs, arbitrary `/admin` prefixes,
upgrades, or tunnels. Membership, grant registration, administrator credential
verification, browser sessions, CSRF, and revocation remain authority-owned.

Before forwarding, the edge rejects ambiguous duplicate security or framing
headers, strips caller-supplied ECHO proxy/authenticated-client headers,
forwarding metadata, hop-by-hop headers, and every header named by
`Connection`, then injects exactly one trusted-proxy authorization header and
one canonical privacy-preserving client identity derived from the authenticated
certificate. It preserves the configured public host for the authority's
HTTPS `Origin`/`Host` check. Bodies, targets, header counts and bytes, connection
lifetimes, and upstream deadlines are bounded. Ambiguous
`Content-Length`/`Transfer-Encoding`, incomplete bodies, noncanonical targets,
and automatic mutation retries fail closed before the authority.

Runtime configuration, the TLS certificate chain and private key, the client
CA bundle, the authority proxy token, logs, and supervisor state live outside
the immutable edge artifact. Every referenced runtime file is a canonical
owner-controlled private regular file. The operator procedures and exact
configuration outline are in the
[administrator edge runbook](../runbooks/organization-admin-edge.md).

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
the exact recorded artifact bytes. Building the administrator edge artifact or
proving it with local certificates remains development evidence: it neither
deploys a production endpoint nor closes `P5-NET-001`.

## Promotion sequence

1. **Complete:** establish workspaces, build references, manifests, import
   fences, and test ownership without runtime behavior.
2. **Complete:** promote federation primitives with golden byte/signature
   fixtures, cut the product over to that implementation, and remove the
   temporary parity implementation/tests.
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
   promoted or edited into qualification evidence. The separate administrator
   edge may be built and tested locally during this step, but only later
   production deployment evidence can satisfy `P5-NET-001`.
6. Place the Brain above the verified federation permission gate and run the
   separate N=2 reasoning test.
7. Promote organization ingest and batch receipts, then pass their live parity
   gate before claiming full parity with the experimental pilot.

The experimental implementation remains reference evidence through the
onboarding/access slice and until the later ingest-and-receipt parity gate
passes. Compatibility code may depend from experimental to stable; the reverse
direction is forbidden.
