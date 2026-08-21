# ECHO Brain

ECHO Brain is now a server-owned meeting intelligence system with a thin
Person client.

The organization Authority owns identity, policy, meeting processing,
records, retrieval, and integrations. A person's machine owns only a private
login session and sends authenticated requests to that Authority.

## Minimum V1 boundary

### Person machine

The only shipped machine product is `@echo-brain/person-client` in
`src/product/person-client`.

It can:

- begin Google OIDC login and install or refresh a Person session;
- read recent decisions and searchable organization content;
- manage the signed-in member's meeting exclusions; and
- bind the signed-in identity to Slack.

It does not run meeting processing, hold Granola or Slack service
credentials, manage a LaunchAgent, keep a local product database, write a
JSONL outbox, use installation signing keys or leases, or receive fleet update
directives.

Person session state is stored below
`~/.local/share/echo-brain/person/` with a `0700` directory and `0600` files.
Tokens are never printed by successful commands.

### Organization server

`@echo-brain/organization-authority` is the deployable service. It composes:

- external OIDC Person identity and rotating sessions;
- organization authorization and audit;
- meeting-source, decision-processing, approval, and Slack delivery adapters;
- the append-only organization record; and
- recent-decision and readable-search projections.

The server still preserves historical schema migrations and the V1
installation/enrollment data needed by record and approval compatibility.
Those compatibility paths remain server-side only until their surviving
bindings are re-keyed to Person identities. The retired machine runtime is not
kept in the repository as a second product.

## Repository layout

```text
packages/                         Shared protocol and HTTP contracts
services/organization-authority/ Deployable Authority and processing runtime
services/organization-control-plane/
services/organization-record/
services/organization-retrieval/
src/product/person-client/       Standalone Person CLI package
deploy/organization-authority/   Container and EC2 deployment assets
tests/                            Cross-workspace architecture/integration tests
```

## Development

The supported toolchain is Node `22.22.1` and npm `10.9.4`.

```bash
npm ci
npm run check
```

Useful focused commands:

```bash
npm run test:person
npm run test:authority
npm run test:protocols
npm run test:integration
npm run check:boundary
```

`npm run check` performs boundary and documentation checks, TypeScript
checking, linting, and the complete active test suite.

## Person client artifact

Build all workspaces:

```bash
npm run build
```

Create the standalone offline-installable Person tarball from a clean commit:

```bash
mkdir -p /absolute/path/to/artifacts
npm run pack:person-client -- /absolute/path/to/artifacts
```

The packer includes only the Person client and its three public protocol/API
dependencies. CI installs that exact tarball offline on macOS arm64 and checks
version, help, and absent-session behavior.

Installed CLI shape:

```text
echo-brain person <command> [options]
```

## Authority deployment

The production container is built from
`deploy/organization-authority/Dockerfile`. It does not copy or build the
Person client source. The EC2 deployment and rollback procedure is documented
in [deploy/organization-authority/AWS-EC2.md](deploy/organization-authority/AWS-EC2.md).

The public descriptor health endpoint is:

```text
GET /v1/authority-descriptor
```

Live meeting processing remains disabled until an administrator installs an
explicit processing-source configuration binding. Identity/session testing
does not enable meeting ingestion by itself.

## Design records

- [Organization-operated server core](docs/decisions/ADR-0001-organization-operated-server-core.md)
- [External OIDC Person sessions](docs/decisions/ADR-0002-external-oidc-person-sessions.md)
- [Workspace boundaries](docs/architecture/organization-workspace-boundaries.md)
- [Product runtime boundary](docs/architecture/product-runtime.md)

Historical migrations and qualification evidence are intentionally retained.
They describe deployed state and verification history, not additional shipped
products.
