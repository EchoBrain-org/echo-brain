# One-organization workspace boundaries

The near-term topology is one organization with any practical number of
employees and installations. A second organization is a later tenancy change,
not a dormant branch.

## Repository ownership

```text
src/
  core/                         vendor-neutral decision pipeline
  adapters/                     source, processor, approval, delivery
  product/machine/              installation key and OS ports
  product/federation/           local identity and signed records
  product/organization/         enrollment client and access state

packages/
  federation-protocol/          canonical signatures and identifiers
  organization-protocol/        signed organization facts
  organization-api/             HTTP request/response contracts

services/
  organization-authority/       one centrally hosted organization
```

The root package is the employee product. The authority is a separate
workspace and deployment. They share only the three protocol/API packages and
never import one another.

## Dependency direction

```text
federation-protocol
        ↑
organization-protocol
        ↑
organization-api
      ↗          ↖
product      authority
```

- Protocol packages do not import product, service, database, or UI code.
- Cross-workspace imports use package exports.
- Signed trust documents and ordinary HTTP DTOs remain separate contracts.
- Private-key lifecycle stays behind signer ports; protocol packages know only
  public descriptors and signatures.

Checked source-boundary manifests enforce this graph.

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
- Local state owns the authority pin, enrollment evidence, and the access
  high-watermark alongside the meeting-to-decision product state.

The employee client stores its exact signed request before sending a grant and
atomically commits verified access state before returning `permitted: true`.
The authority stores no meeting, decision, reasoning, or embedding data.

## Deployment

The authority runs as one process with one persistent SQLite volume. The
portable one-machine deployment is documented in
[`deploy/organization-authority`](../../deploy/organization-authority/README.md).
Multi-replica operation requires a later persistence and coordination design.
