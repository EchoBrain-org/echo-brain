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
- list approved records and search currently indexed organization content;
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
- deterministic, permission-aware record reads.

The server starts only from the seven byte-pinned clean baselines. Historical
migration runners and compatibility APIs are not shipped. Layer 3 is the sole
release boundary; no Layer 4 product or runtime is present.

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

Build the production container from `deploy/organization-authority/Dockerfile`.
Clean operation uses `compose.clean-v1.yaml` locally and
`compose.clean-v1.ec2.yaml` for the EC2 host shape. The accepted release and
update workflows are documented under `deploy/release/`.

### Local Authority exercise

For a disposable, local-only Authority exercise, use the committed harness. It
creates synthetic state outside the checkout, uses a distinct Compose project,
and binds two high loopback ports. It does not read deployment state, a release
record, or any provider credential.

```bash
npm run authority:local -- up
npm run authority:local -- reset
npm run authority:local -- down
```

`up` prints the local HTTPS origin and the path to Caddy's generated local root
certificate. It verifies that origin with the built `PersonAuthorityClient`,
using Caddy's local root certificate through `NODE_EXTRA_CA_CERTS`. `up` is
repeatable with complete tool-owned synthetic state.
`reset` is the only destructive command: it stops that one project and replaces
only its synthetic state. `down` removes that project's containers, network,
and generated Docker volumes but retains its synthetic bind-mounted state.

Choose a different owned state directory or high loopback ports before the
first run when needed:

```bash
ECHO_LOCAL_AUTHORITY_HTTP_PORT=45678 \
ECHO_LOCAL_AUTHORITY_HTTPS_PORT=45679 \
npm run authority:local -- up --state-dir /absolute/path/outside/this/repository
```

The packaged Person client requires HTTPS. Do not treat `curl --insecure` as a
client trust test. Use the local Caddy CA printed by `up`, for example:

```bash
export NODE_EXTRA_CA_CERTS="$(npm run --silent authority:local -- ca-path)"
# Run the built or packaged Person client against the HTTPS origin printed by up.
```

The harness uses the base Compose profile plus a generated local overlay. It
never uses `compose.clean-v1.ec2.yaml`, and it never changes the byte-bound
deployment profile or its 80/443 bindings.

The state directory is a same-user local development boundary, not a defense
against another process running as your account. The harness checks ownership,
modes, regular-file types, and symlink-free generated/state paths immediately
before destructive or Docker lifecycle actions. Do not run it concurrently
with another process that can alter the same state directory.

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
- [ECHO-hosted Authority by default](docs/decisions/ADR-0008-echo-hosted-authority-by-default.md)
- [Retained Authority data-volume boundary](docs/decisions/ADR-0009-retained-authority-data-volume-boundary.md)
- [Workspace boundaries](docs/architecture/organization-workspace-boundaries.md)
- [Product runtime boundary](docs/architecture/product-runtime.md)

Typed ADR, RFC, invariant, and qualification evidence remains as design and
verification history. Historical executable migrations are intentionally not
part of the clean product.
