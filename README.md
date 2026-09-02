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
- deterministic, permission-aware record reads and cited answers.

The server starts only from the seven byte-pinned baseline schemas. Historical
migration runners and compatibility APIs are not shipped. Released retrieval
is the sole content-release boundary. The answer-composition generation path is one
synchronous Person `ask` path: one bounded plan, one released-retrieval batch,
at most one answer call, and
citations limited to that request's released atoms. It has no agents, tools,
memory, streaming, or direct record or retrieval-store access.

## Repository layout

```text
packages/                         Linked reusable modules and shared contracts
services/organization-authority/ Deployable Authority and processing service
packages/organization-control-plane/ Linked Authority control-plane module
packages/organization-record/        Linked Authority record module
packages/organization-retrieval/     Linked Authority retrieval module
src/product/person-client/       Standalone Person CLI package
deploy/organization-authority/   Container and EC2 deployment assets
tests/                            Cross-workspace architecture and Person tests
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
npm run test:meeting-processing-core
npm run test:reference-meeting-processing
npm run test:architecture
npm run check:architecture-boundaries
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
The current `clean-v1` compatibility profile uses `compose.clean-v1.yaml`
locally and `compose.clean-v1.ec2.yaml` for the EC2 host shape. The accepted
release and update workflows are documented under `deploy/release/`.

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

### AWS staging slot

The staging controller holds one fixed Cloudflare edge and retained EBS data
volume around a disposable EC2 host. Its initial host onboarding and three
retained-state host-replacement cycles have passed qualification; this does not
claim a snapshot restore, GAP-01/#20 closure, or GAP-04 closure. The
[staging sprint specification](docs/product/2026-08-26-disposable-authority-staging-sprint-v1.md)
owns the recovery and safety boundaries. The [assertion
matrix](docs/qualification/authority-staging-host-replacement-v1-matrix.md) and
[qualification report](docs/qualification/QUAL-20260827-174106-001-authority-staging-host-replacement-v1.md)
own the passed assertions and exact-run evidence.

| Command     | Purpose                                                                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slot-init` | Creates or repairs the retained AWS boundary, then creates or verifies its Cloudflare tunnel, ingress, DNS record, and connector-token deposit.                                    |
| `up`        | Creates a disposable host and attaches the retained data volume. `--require-authority` additionally gates a retained-volume restart on the independently pinned public descriptor. |
| `down`      | Stops the host safely and removes only disposable host resources. The edge and retained volume remain.                                                                             |
| `status`    | Reads AWS, host, and public-descriptor observations separately. An edge observation alone is never proof that the host or Authority is ready.                                      |

Prerequisites: an `echo-prod` IAM Identity Center session, `asm-exec`, the
exact ARM64 Ubuntu AMI ID, and the ECR repository. Use neither `aws login` nor
an AWS account-root session. Never SSH or open an interactive root shell on a
staging host: the controller uses bounded SSM Run Command operations only.

Copy the committed input outside the checkout and replace each placeholder
with the reviewed staging values. The hostname must be in the selected
Cloudflare zone. A single `operationId` identifies one reviewed plan and its
execute: do not change it between those two commands. Set a new `operationId`
before each later `slot-init`, `up`, or `down` plan.

```bash
install -d -m 0700 /absolute/private/authority-staging
cp deploy/organization-authority/authority-staging-v1.example.json \
  /absolute/private/authority-staging/input.json
chmod 0600 /absolute/private/authority-staging/input.json

aws sso login --profile echo-prod
```

Create the restricted Cloudflare management token once with Tunnel Edit for the
staging account and DNS Edit for the staging zone, and store it in the reviewed
JSON secret shape `{"cloudflare_api_token":"<entered out of band>"}`. Never
paste its value into a command or repository file.
Export only its dynamic reference: the controller re-executes under `asm-exec`
and does not accept raw tokens. It pins AWS and `asm-exec` subprocesses to
`echo-prod` and removes ambient static credential overrides.

```bash
# Plan first. This does not resolve the Cloudflare management token.
npm run authority:staging -- slot-init \
  --input /absolute/private/authority-staging/input.json

export ECHO_CLOUDFLARE_API_TOKEN='{{resolve:secretsmanager:EXACT_SECRET_ARN:SecretString:cloudflare_api_token}}'

# Review this plan, then execute it with the unchanged operationId.
npm run authority:staging -- slot-init \
  --input /absolute/private/authority-staging/input.json --execute
```

After `slot-init` is ready, set a new `operationId`, build the immutable host
bundle from the clean commit, and add the resulting `hostSetup` object to the
private input using the digest from its generated manifest:

```json
"hostSetup": {
  "path": "/absolute/private/authority-staging/host-setup.tar.gz",
  "key": "authority-staging/host-setup.tar.gz",
  "sha256": "<64-character manifest archive_sha256>"
}
```

```bash
npm run bundle:authority-staging-host -- \
  --source-root "$PWD" \
  --output /absolute/private/authority-staging/host-setup.tar.gz
```

```bash
# First host only: review, then execute the visible blank-volume initialization.
npm run authority:staging -- up \
  --input /absolute/private/authority-staging/input.json \
  --initialize-blank-data-volume
npm run authority:staging -- up \
  --input /absolute/private/authority-staging/input.json \
  --initialize-blank-data-volume --execute

# Set a new operationId before this separate plan and execute.
npm run authority:staging -- down \
  --input /absolute/private/authority-staging/input.json
npm run authority:staging -- down \
  --input /absolute/private/authority-staging/input.json --execute

# After down, set another new operationId. Later up omits initialization.
npm run authority:staging -- up \
  --input /absolute/private/authority-staging/input.json
npm run authority:staging -- up \
  --input /absolute/private/authority-staging/input.json \
  --require-authority --execute

# Read only. In healthy state, this also checks the Cloudflare edge.
npm run authority:staging -- status \
  --input /absolute/private/authority-staging/input.json
```

The first `up` intentionally omits `--require-authority`: a fresh volume has
not been onboarded yet. After the first accepted release reaches terminal green,
a human must copy the independently trusted Authority `authority_pin_sha256`
(the accepted bootstrap evidence names the same `sha256:` digest
`authority_descriptor_sha256`) into the private lifecycle input:

```json
"authorityPinSha256": "sha256:<64-lowercase-hex-characters>"
```

Do not obtain that pin from the public endpoint being checked. With the pin in
place, use `--require-authority` for every retained-volume restart. It refuses
before AWS work if the pin is absent and treats a structurally valid descriptor
with a different pin as a failure. `status` exposes `authority_serving` and
`authority_accepted` separately; it is green only when the descriptor matches
the pin. Its `authority_unpinned` and `authority_pin_mismatch` states are not
green. If a required execute returns a failed machine-readable verification
receipt, preserve the operation ID and repeat the same
`up --execute --require-authority` command. While `StagingHostReady=true`, that
retry is probe-only (`verification_only: true`): it does not upload a bundle,
create or execute CloudFormation work, issue SSM work, or change the edge. Use
`status` to distinguish `host_enabled`, `host_ready`, and `authority_serving`;
none substitutes for the other.

When `status` finds `StagingHostReady=false`, it returns `host_down` with
`edge_checked: false` before resolving a Cloudflare token or querying the edge:
edge readiness is unknown in that receipt because it cannot make a stopped host
or Authority ready.

Until the first `up` reaches ready, every reviewed retry must use a new
`operationId` and retain `--initialize-blank-data-volume`. That flag permits
the marker-bound completion of an interrupted blank-volume initialization; it
does not permit reformatting a volume that already has a filesystem. Omit the
flag only after the first host has reached ready.

The initial token creation, SNS email confirmation, provider applications,
initial-owner login, observability deployment, and first canary remain explicit human
steps. V1 is single-operator: never run overlapping lifecycle commands for this
slot from different terminals or machines. For failed-create, rollback, mount,
and recovery procedures, follow the full staging specification rather than
deleting or renaming the stack.

### Initial host onboarding input transfer

Do not SSH, copy credentials into a terminal, or open a root shell. The first
staging onboarding input moves through one short-lived, KMS-encrypted and
versioned transfer bucket. The host receives permission for only the exact
object version during one bounded SSM command, with a 15-minute IAM expiry as
a backstop that starts when the plan is made. Execute refuses a grant with less
than eight minutes left for CloudFormation plus the 300-second Run Command
plugin timeout. The controller polls for a terminal SSM result for up to six
minutes, cancels on local timeout, and waits up to two more minutes for terminal
cancellation before it permits any cleanup. It verifies the archive digest,
accepts exactly the nine established regular input files, including
`slack-signing-secret`, runs `doctor` and
`prepare` without exposing their output, then revokes the host permission and
permanently deletes that exact S3 version. The private local archive and receipt
are removed only after both remote cleanup steps are proved.

Before it sends the SSM command, the controller atomically records an
`ssm_submitting` receipt; immediately after SSM returns an exact command ID it
atomically advances it to `ssm_submitted`. A receipt with a command ID always
reconciles that exact invocation before cleanup: only the fixed success marker
advances it to `remote_prepared`; a proved terminal non-success may be cleaned
as an unproved onboarding outcome. Never retry by creating a second SSM command
for the same receipt.

If SSM accepted the send but the command-ID receipt write is lost, the retained
`ssm_submitting` receipt has no ID to reconcile. Cleanup is deliberately
quarantined until `max(access_expires_at, submission_started_at + 10 minutes) + 2 minutes`:
the IAM grant has expired, the 300-second SendCommand delivery
window and 300-second RunShellScript limit have both elapsed from the actual
pre-send timestamp, and the extra two minutes cover clock skew and final
propagation. Before that exact time, cleanup refuses to revoke or delete. After
quarantine cleanup, the outcome is still unproved: inspect retained Authority
state before deciding whether a fresh operation is safe; it never reports
`prepared`.

Create a private controller input outside the checkout. Its `privateInputDir`
must contain exactly the nine mode-`0600` files accepted by
`onboard-clean-v1.sh`; `archiveDir` must be an existing mode-`0700` directory
outside the checkout. No secret values belong in this controller JSON.

Before a transfer `plan`, run the read-only local preflight. It reads metadata
only, makes no AWS call, and exits `2` until every required file is a private
non-empty regular file, the aggregate is within the 40 MiB limit, and no extra
leaves are present. It reports an unexpected-file count rather than filenames
and the exact bytes over the aggregate limit when one applies.
The controller then pins AWS calls to the `echo-prod` SSO profile and removes
inherited credential, endpoint, proxy, and CA overrides before archive upload.

```json
{
  "region": "us-west-2",
  "operationId": "onboarding-<new-unique-operation-id>",
  "stackName": "<existing-staging-stack-name>",
  "privateInputDir": "/absolute/private/staging-onboarding-input",
  "archiveDir": "/absolute/private/staging-onboarding-transfer"
}
```

```bash
# Do this before an AWS transfer call or archive creation.
npm run authority:staging-onboarding-transfer -- preflight \
  --input /absolute/private/staging-onboarding-transfer/input.json

# Builds and verifies the deterministic private archive, uploads one exact
# object version, and creates a reviewable IAM-grant-only change set.
npm run authority:staging-onboarding-transfer -- plan \
  --input /absolute/private/staging-onboarding-transfer/input.json

# Review the change set named in the private receipt, then execute exactly it.
# This runs only a bounded SSM command, never an interactive root session.
npm run authority:staging-onboarding-transfer -- execute \
  --receipt /absolute/private/staging-onboarding-transfer/onboarding-transfer-<operation-id>.json
```

If `execute` exits nonzero with `onboarding_transfer_failed_cleaned`, the
transfer outcome was not proved and all temporary material was removed: inspect
the retained Authority state before deciding whether a fresh operation is safe.
If it reports `cleanup_required`, do not create
another input archive. Preserve the private receipt and archive and retry only
the bounded cleanup after the stack is again stable:

```bash
npm run authority:staging-onboarding-transfer -- cleanup \
  --receipt /absolute/private/staging-onboarding-transfer/onboarding-transfer-<operation-id>.json
```

Cleanup first proves that the temporary policy is absent, then proves that the
exact object key has no versions, delete markers, or multipart uploads. It
removes local recovery material only after those proofs succeed.
If a successful `doctor` and `prepare` reached the host before cleanup stalled,
the private receipt is marked `remote_prepared`; its later `cleanup` returns
`prepared_cleaned`. Do not run transfer again: continue with the established
`onboard-clean-v1.sh resume` flow.

An uncertain `PutObject` is also a `cleanup_required` condition. In that case
the private receipt is deliberately retained in `uploading` state without a
trusted object version. Run only the same `cleanup` command: it first proves
the temporary grant is absent, then adopts a sole version only if its SHA-256
metadata and KMS key exactly match the private receipt. Only that proved-owned
version is deleted and absence is rechecked. A different, multiple, marked, or
multipart object is a collision: it is never deleted by this controller.
Do not reuse the operation ID until cleanup has proved absence.

The first `slot-init` must use this template. No staging slot exists before this
rollout; deliberately, there is no controller path for upgrading an older slot
before a credential transfer.

## Design records

- [Organization-operated server core](docs/decisions/ADR-0001-organization-operated-server-core.md)
- [External OIDC Person sessions](docs/decisions/ADR-0002-external-oidc-person-sessions.md)
- [ECHO-hosted Authority by default](docs/decisions/ADR-0008-echo-hosted-authority-by-default.md)
- [Retained Authority data-volume boundary](docs/decisions/ADR-0009-retained-authority-data-volume-boundary.md)
- [Workspace boundaries](docs/architecture/organization-workspace-boundaries.md)
- [Person client architecture](docs/architecture/person-client-architecture.md)

Typed ADR, RFC, invariant, and qualification evidence remains as design and
verification history. Historical executable migrations are intentionally not
part of the current product.
