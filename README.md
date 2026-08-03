# echo-brain

`echo-brain` turns meeting material into reviewed decisions and delivers those
decisions to the places where a team works.

```text
meeting source
  -> canonical meeting
  -> decision processor
  -> explicit approval
  -> delivery surfaces
  -> durable receipts
```

The near-term product is deliberately one organization with multiple
employees. The repository contains:

- the tool-agnostic decision core;
- Granola meeting ingestion;
- deterministic and LLM decision processors;
- local and Slack approval;
- JSONL and Slack delivery;
- SQLite product state, onboarding, backup, and restore;
- one customer-hosted organization authority for enrollment and access; and
- a minimum customer-owned organization control plane for one verified
  organization Slack tool, exact provider identity links and adapter bindings,
  and direct approve/reject permission checks.

It does not contain a multi-tenant vendor control plane, billing, fleet,
multi-replica authority infrastructure, general employee tool propagation,
non-Slack organization tools, or a vendor-visible organization data plane.

## Requirements

- Node `22.22.1`
- npm `10.9.4`
- macOS arm64 for the machine-installed product and persistent service
- a compiler toolchain if `better-sqlite3` has no prebuilt binary for the
  machine

The supported machine-installable product target is macOS arm64. Its
persistent service uses a per-user LaunchAgent; the decision core and
foreground commands remain Node-based.

## Build, test, and install

```sh
npm ci
npm run check
npm pack
npm install -g ./echo-brain-0.1.0-internal.4.tgz
```

`npm run check` runs the source-boundary check, TypeScript, ESLint, and the
stable test suite. `npm pack` builds the CLI and includes its three local
protocol packages. A package built from a clean commit records that commit and
a content manifest for every npm-packed file except the manifest itself. A
dirty or untracked worktree is marked unverified and cannot supply Internal
Live artifact evidence. The manifest detects package corruption or local tampering;
it is not a publisher signature. This pre-1.0 build does not preserve
package history automatically, so retain an older installed package tree when
its previously recorded artifact identity must remain verifiable after an
upgrade.

## Internal Live releases and machine updates

Internal Live is the small, controlled release lane for ECHO employees. It is
not a client release. A manual GitHub workflow builds the npm package once from
`main`, tests those exact bytes on macOS arm64, waits for approval in the
protected `internal-live` environment, and publishes a prerelease bundle whose
exact bytes are pinned by a manifest and checksums.

### One-time updater bootstrap

A clean Mac needs one manual install of an updater-capable release. The
administrator chooses one exact release as the bootstrap anchor and sends its
version, source SHA, artifact SHA-256, workflow run ID, and run attempt over the
trusted handoff channel. Those coordinates are immutable for that handoff;
never substitute a moving `latest` release.

An already-enrolled Mac whose CLI predates `update apply` is a maintenance
migration, not a clean bootstrap. Verify the release first, then use a reviewed
operator procedure that retains the old package, stops the service before
backing up state, restores both on failure, and finishes with native
`update apply`. Do not paste the clean-install command over a running enrolled
installation. All current Internal Live pilot Macs have completed this
transition; future releases use the normal updater below.

First perform every non-mutating trust check while any existing service remains
running. On either kind of Mac, replace every angle-bracket value with the
administrator's exact approved coordinates. This requires authenticated `gh`
access to the repository's Actions approval records:

```sh
set -euo pipefail
BOOTSTRAP_REPOSITORY='EchoBrain-org/echo-brain'
BOOTSTRAP_VERSION='<exact MAJOR.MINOR.PATCH-internal.SEQUENCE>'
BOOTSTRAP_SOURCE_SHA='<exact 40-character source SHA>'
BOOTSTRAP_ARTIFACT_SHA256='<exact 64-character artifact SHA-256>'
BOOTSTRAP_RUN_ID='<exact workflow run ID>'
BOOTSTRAP_RUN_ATTEMPT='<exact workflow run attempt>'
BOOTSTRAP_TAG="internal-v${BOOTSTRAP_VERSION}"
BOOTSTRAP_ARTIFACT="echo-brain-${BOOTSTRAP_VERSION}.tgz"
BOOTSTRAP_DIRECTORY="$(mktemp -d)"
BOOTSTRAP_ARTIFACT_PATH="${BOOTSTRAP_DIRECTORY}/${BOOTSTRAP_ARTIFACT}"
BOOTSTRAP_NODE="$(command -v node)"
BOOTSTRAP_NPM="$(command -v npm)"
BOOTSTRAP_RUNTIME_BIN="$(dirname "$BOOTSTRAP_NODE")"

test "$(uname -s)" = Darwin
test "$(uname -m)" = arm64
test -x "$BOOTSTRAP_NODE"
test -x "$BOOTSTRAP_NPM"
test "$BOOTSTRAP_RUNTIME_BIN" = "$(dirname "$BOOTSTRAP_NPM")"
test "$("$BOOTSTRAP_NODE" --version)" = v22.22.1
test "$("$BOOTSTRAP_NODE" -p 'process.platform+"|"+process.arch')" = 'darwin|arm64'
test "$("$BOOTSTRAP_NPM" --version)" = 10.9.4

gh release download "$BOOTSTRAP_TAG" \
  --repo "$BOOTSTRAP_REPOSITORY" \
  --dir "$BOOTSTRAP_DIRECTORY" \
  --pattern "$BOOTSTRAP_ARTIFACT" \
  --pattern SHA256SUMS

test "$(gh release view "$BOOTSTRAP_TAG" \
  --repo "$BOOTSTRAP_REPOSITORY" \
  --json tagName,targetCommitish,isPrerelease \
  --jq '[.tagName,.targetCommitish,(.isPrerelease|tostring)]|join("|")')" \
  = "${BOOTSTRAP_TAG}|${BOOTSTRAP_SOURCE_SHA}|true"

test "$(gh run view "$BOOTSTRAP_RUN_ID" \
  --repo "$BOOTSTRAP_REPOSITORY" \
  --attempt "$BOOTSTRAP_RUN_ATTEMPT" \
  --json conclusion,event,headBranch,headSha,workflowName,jobs \
  --jq '[.conclusion,.event,.headBranch,.headSha,.workflowName,([.jobs[]|select(.name=="Approve, attest, and publish prerelease")|.conclusion]|join(","))]|join("|")')" \
  = "success|workflow_dispatch|main|${BOOTSTRAP_SOURCE_SHA}|INTERNAL LIVE release|success"

test "$(gh api \
  "repos/${BOOTSTRAP_REPOSITORY}/actions/runs/${BOOTSTRAP_RUN_ID}/approvals" \
  --jq '[.[]|select(.state=="approved")|.environments[]|select(.name=="internal-live")]|length>0')" \
  = true

test "$(awk 'NR==1{v=$1"|"$2} END{if(NR!=1)exit 1; print v}' \
  "${BOOTSTRAP_DIRECTORY}/SHA256SUMS")" \
  = "${BOOTSTRAP_ARTIFACT_SHA256}|${BOOTSTRAP_ARTIFACT}"
(cd "$BOOTSTRAP_DIRECTORY" && \
  printf '%s  %s\n' "$BOOTSTRAP_ARTIFACT_SHA256" "$BOOTSTRAP_ARTIFACT" | \
  shasum -a 256 --check -)

gh attestation verify "$BOOTSTRAP_ARTIFACT_PATH" \
  --repo "$BOOTSTRAP_REPOSITORY" \
  --signer-workflow "$BOOTSTRAP_REPOSITORY/.github/workflows/internal-live-release.yml" \
  --signer-digest "$BOOTSTRAP_SOURCE_SHA" \
  --source-digest "$BOOTSTRAP_SOURCE_SHA" \
  --source-ref refs/heads/main \
  --deny-self-hosted-runners
```

Only after every check above exits zero may a clean-Mac installation begin.
Continue in the same shell:

```sh
set -euo pipefail

BOOTSTRAP_NPM_PREFIX="${HOME}/.npm-global"
BOOTSTRAP_NPM_HOME="${BOOTSTRAP_DIRECTORY}/npm-home"
BOOTSTRAP_NPM_CACHE="${BOOTSTRAP_DIRECTORY}/npm-cache"
install -d -m 0700 "$BOOTSTRAP_NPM_PREFIX" "$BOOTSTRAP_NPM_HOME" \
  "$BOOTSTRAP_NPM_CACHE"
install -m 0600 /dev/null "${BOOTSTRAP_DIRECTORY}/user.npmrc"
install -m 0600 /dev/null "${BOOTSTRAP_DIRECTORY}/global.npmrc"
(
  cd "$BOOTSTRAP_DIRECTORY"
  env -i HOME="$BOOTSTRAP_NPM_HOME" \
    PATH="${BOOTSTRAP_RUNTIME_BIN}:/usr/bin:/bin:/usr/sbin:/sbin" \
    "$BOOTSTRAP_NPM" install --global \
    --prefix "$BOOTSTRAP_NPM_PREFIX" \
    --cache "$BOOTSTRAP_NPM_CACHE" \
    --registry=https://registry.npmjs.org/ \
    --userconfig="${BOOTSTRAP_DIRECTORY}/user.npmrc" \
    --globalconfig="${BOOTSTRAP_DIRECTORY}/global.npmrc" \
    --no-audit --no-fund --no-update-notifier \
    "$BOOTSTRAP_ARTIFACT_PATH"
)
export PATH="${BOOTSTRAP_NPM_PREFIX}/bin:${PATH}"
test "$(echo-brain --version)" = "$BOOTSTRAP_VERSION"
test "$("$BOOTSTRAP_NODE" -e '
  const fs = require("node:fs");
  const identity = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(
    `${identity.product_version}|${identity.source_sha}|${identity.source_kind}`,
  );
' "${BOOTSTRAP_NPM_PREFIX}/lib/node_modules/echo-brain/dist/product/build-identity.v1.json")" \
  = "${BOOTSTRAP_VERSION}|${BOOTSTRAP_SOURCE_SHA}|materialized-commit"
file "${BOOTSTRAP_NPM_PREFIX}/lib/node_modules/echo-brain/node_modules/better-sqlite3/build/Release/better_sqlite3.node" | \
  grep -q 'Mach-O 64-bit bundle arm64'
```

Persist `export PATH="$HOME/.npm-global/bin:$PATH"` once in `~/.zshrc`.
A clean Mac continues with `onboard`, `init`, `organization enroll`, service
setup, and a green local doctor. Bootstrap is complete only after it immediately
runs native `update apply` for the Authority's current release and the central
rollout status records that installation's healthy receipt. The manual first
install is the sole pre-Authority exception; the native update performs the
normal signed Authority request and full manifest/package verification.

### Normal enrolled-machine updates

After the one-time bootstrap and enrollment, every later update is one command:

```sh
echo-brain update apply \
  --channel internal-live \
  --config /absolute/path/runtime.json
```

That command asks the organization Authority for the currently approved
release, verifies the public manifest and package in full before stopping the
service, backs up local state, retains the installed package, installs the new
version, reapplies the existing configuration, starts the service, and runs
a local-only `doctor` covering package identity, config/state, LaunchAgent,
runtime, and credential files. It does not call Granola, Slack, or an LLM. If
the candidate fails, it restores the previous package and state. The Authority
receives only a signed, non-secret outcome receipt so the admin can see which
enrolled Macs are pending, healthy, rolled back, or failed.

The admin approves a tested manifest and reads rollout status from the
organization-authority checkout:

```sh
npm run organization-authority:admin -- internal-live release approve \
  --config /absolute/path/authority.json \
  --manifest /absolute/path/internal-live-release-manifest.v1.json

npm run organization-authority:admin -- internal-live rollout status \
  --config /absolute/path/authority.json
```

Minimum V1 keeps one rollout current at a time. Before any active installation
reports a receipt, the admin may replace an approved release with a strictly
newer one. After the first receipt, the Authority will not approve the next
release until every active installation has reported healthy on the current
one. Retry a rolled-back Mac, or explicitly revoke an installation that is no
longer in service, before advancing. This keeps an interrupted command pinned
to the manifest it was already applying without adding rollout rings or a
remote recovery system.

V1 does not install a second privileged updater. If power is lost during npm's
own in-place package replacement and the `echo-brain` command itself is absent,
reinstall the retained package from the config directory's
`internal-live-updates/retained-packages/` folder, then rerun the same update
command.

The V1 intentionally has no background auto-update, remote shell, MDM,
dashboard, rollout rings, or automatic live Granola/Slack test. A person starts
each release and each machine update.

Initialize private config and state:

```sh
echo-brain onboard \
  --config /absolute/path/runtime.json \
  --state-dir /absolute/path/state

echo-brain init --config /absolute/path/runtime.json

echo-brain organization enroll \
  --config /absolute/path/runtime.json \
  --invitation /absolute/path/echo-organization-invitation.json \
  --authority-pin sha256:PIN_FROM_A_SEPARATE_TRUSTED_CHANNEL \
  --authority-ca /absolute/path/internal-authority-ca.pem \
  --allow-exportable-software-key

echo-brain organization status --config /absolute/path/runtime.json
echo-brain organization refresh --config /absolute/path/runtime.json

echo-brain run-once --config /absolute/path/runtime.json
echo-brain doctor --config /absolute/path/runtime.json
```

The file-backed installation signer stores an exportable P-256 key below the
private state directory and labels its assurance as
`software_key_development_only`. The signer port remains replaceable by a
hardware-backed implementation later. `organization enroll` requires
`--allow-exportable-software-key` so pilot-grade assurance cannot be accepted
silently. This signer can be operationally ready for a pilot, but it never
makes `seed_grade_ready` true; `identity-check --strict` continues to require
hardware-bound, non-exportable key assurance.

Central organization-admin bootstrap is the one supported v1 enrollment path.
The local founder-provenance mode -- the `identity-bootstrap` ceremony, the
federated `export` command, and the signed record projection and protected
independent copy behind them -- is retired and removed from this build.

A state root that still holds founder identity or cutover material is detected
and refused, not downgraded. One early dispatch gate refuses `onboard`, `init`,
`reconfigure`, `doctor`, every `organization` action, `approvals`, `approve`,
`reject`, `run-once`, `run`, `service-run`, and `service
install`/`start`/`restart` — before a `ProductOperator` is constructed, the
filesystem is probed, a lifecycle lock is taken, a directory is created or
chmodded, credentials are resolved, SQLite is opened or migrated, a provider or
the Authority is contacted, or an injected callback runs. A custom identity
check, approval capture, approval store, or runtime cannot bypass it.

The exceptions are not "commands that do not write" — several of them do write.
They are the commands whose purpose is to diagnose, preserve, or quiesce a
fenced profile: `--help`/`--version`, `validate-config`, `selftest`, `status`,
`identity-check`, `backup`, `restore`, and `service stop`/`status`/`uninstall`.
`organization status` is **not** an exception: it opens and migrates writable
SQLite, so it is gated with every other organization action.

Recovery does not go through a restore. The cutover is irreversible, and a
backup stays bound to the state path it was taken from, so no restore crosses
the fence — a backup of a retired profile is preservation for that profile,
nothing more.

The executable order matters, because `backup` refuses to run while the service
is loaded:

```sh
echo-brain service stop --config /absolute/path/retired-runtime.json
echo-brain backup --config /absolute/path/retired-runtime.json \
  --backup-root /absolute/path/backups

echo-brain onboard \
  --config /absolute/path/new-runtime.json \
  --state-dir /absolute/path/new-state
# provision the Granola credential the new config references, then:
echo-brain init --config /absolute/path/new-runtime.json
echo-brain organization enroll \
  --config /absolute/path/new-runtime.json \
  --invitation /absolute/path/echo-organization-invitation.json \
  --authority-pin sha256:PIN_FROM_A_SEPARATE_TRUSTED_CHANNEL \
  --allow-exportable-software-key
```

The new path must be free of founder residue — that is what the fence checks,
not pristineness in general. `init` reports the credential recommendations for
the configured adapters; `organization enroll` requires an initialized
installation that is not already enrolled.

This pre-1.0 build does not migrate a Secure Enclave identity to the portable
file signer. `identity-check` reports `unsupported_legacy_key_backend` for that
state. Preserve the prior state and signer when identity continuity matters.

## Runtime configuration

Operational commands require an absolute JSON config path. This offline
baseline uses Granola, local manual approval, and a JSONL outbox:

```json
{
  "schema_version": 1,
  "lane": "team-product",
  "state_dir": "/Users/you/.echo-brain",
  "meeting_sources": [
    {
      "adapter_id": "granola",
      "instance_id": "primary",
      "credential_ref": "file:/Users/you/.echo-brain/credentials/granola-api-key",
      "settings": {
        "owner_email": "you@example.com",
        "page_size": 30,
        "cursor_overlap_ms": 1000
      }
    }
  ],
  "decision_processor": {
    "adapter_id": "structured-text",
    "instance_id": "primary",
    "settings": {}
  },
  "delivery_surfaces": [
    {
      "adapter_id": "jsonl-outbox",
      "instance_id": "local",
      "settings": {
        "path": "/Users/you/.echo-brain/outbox.jsonl",
        "destination_id": "reviewed-briefs"
      }
    }
  ],
  "approval_mode": "manual",
  "cycle_interval_ms": 60000
}
```

When `owner_email` is set, Granola list-owner emails are trimmed, lowercased,
and compared with that canonical lowercase value. List metadata still reaches
the adapter, but non-matches are skipped before detail/transcript retrieval or
local persistence while the source cursor continues normally. This does not
purge previously stored notes. Enabling the boundary on an existing source
requires a fresh `instance_id` so its cursor and processing history start in a
new scope.

Credential values never belong in the config. Interactive runs may use `env:`;
persistent service configuration requires private `file:` references.

The LLM processor supports Ollama, OpenAI, Anthropic, and OpenRouter while
retaining one canonical output schema and validator:

```json
{
  "decision_processor": {
    "adapter_id": "llm",
    "instance_id": "primary",
    "credential_ref": "file:/Users/you/.echo-brain/credentials/openai-api-key",
    "settings": {
      "provider": "openai",
      "model": "YOUR_STRUCTURED_OUTPUT_MODEL",
      "max_output_tokens": 4096,
      "request_timeout_ms": 240000
    }
  }
}
```

Only Ollama accepts a custom `base_url`; hosted credentials cannot be redirected
to an arbitrary endpoint.

## Slack approval and delivery

Slack remains a first-class internal surface. For reaction approval:

```json
{
  "approval_mode": "adapter",
  "approval_surface": {
    "adapter_id": "slack-reactions",
    "instance_id": "internal-approvals",
    "credential_ref": "file:/Users/you/.echo-brain/credentials/slack-bot-token",
    "settings": {
      "channel_id": "C0123ABCD",
      "reviewer": {
        "slack_user_id": "U0456EFGH",
        "name": "founder"
      },
      "approve_reaction": "white_check_mark",
      "reject_reaction": "x"
    }
  }
}
```

The bot needs `chat:write`, `reactions:read`, and the appropriate public or
private channel history scope. Only the configured reviewer can resolve a
brief.

Slack delivery is independent of Slack approval:

```json
{
  "delivery_surfaces": [
    {
      "adapter_id": "slack",
      "instance_id": "team-decisions",
      "credential_ref": "file:/Users/you/.echo-brain/credentials/slack-bot-token",
      "settings": {
        "channel_id": "C0123ABCD",
        "request_timeout_ms": 30000
      }
    }
  ]
}
```

Confirmed Slack message identities are persisted as delivery receipts.
Ambiguous post outcomes stop automatic retry so the product does not knowingly
duplicate a message.

## Day-to-day commands

```sh
echo-brain validate-config --config /absolute/path/runtime.json
echo-brain selftest --config /absolute/path/runtime.json
echo-brain status --config /absolute/path/runtime.json
echo-brain run-once --config /absolute/path/runtime.json
echo-brain approvals --config /absolute/path/runtime.json
echo-brain approve --config /absolute/path/runtime.json --id <id> --reviewer <name>
echo-brain reject --config /absolute/path/runtime.json --id <id> --reviewer <name>
echo-brain run --config /absolute/path/runtime.json
```

`run-once` loads the configured adapters, processes available meetings,
persists cursors and decisions, waits for approval, and delivers the exact
approved snapshot. Failures conservatively pin the source cursor.

`status` reports the recorded installation and the LaunchAgent state. `reject`
takes the same `--id` and `--reviewer` as `approve` plus an optional
`--reason <text>`.

Backups and restores are explicit maintenance operations:

```sh
echo-brain backup \
  --config /absolute/path/runtime.json \
  --backup-root /absolute/path/backups \
  --id before-change

echo-brain restore \
  --config /absolute/path/runtime.json \
  --backup /absolute/path/backups/before-change \
  --backup-root /absolute/path/backups \
  --id restore-before-change
```

Backups can contain credentials and raw meeting state. Protect them like the
live state.

## Persistent service

The per-user LaunchAgent is installed and controlled from the same CLI:

```sh
echo-brain service install --config /absolute/path/runtime.json
echo-brain service start --config /absolute/path/runtime.json
echo-brain service status --config /absolute/path/runtime.json
echo-brain service restart --config /absolute/path/runtime.json
echo-brain service stop --config /absolute/path/runtime.json
echo-brain service uninstall --config /absolute/path/runtime.json
```

`install`, `start`, and `restart` re-check that every configured credential
reference is a private `file:` path inside the managed credentials directory
before touching launchd. `reconfigure` re-records the installation manifest
after the configuration content or product version changes; it requires the
service to be stopped and refuses to change the config path, state directory,
Node, CLI, or service identity.

## Organization onboarding and access

The single-organization authority is a separate workspace and deployment. Its
employee APIs and `/admin` console share one HTTPS origin behind a standard
reverse proxy. See:

- [authority service](services/organization-authority/README.md)
- [portable one-machine deployment](deploy/organization-authority/README.md)
- [organization protocol boundaries](docs/architecture/organization-workspace-boundaries.md)
- [organization control-plane design](docs/architecture/organization-control-plane.md)

The employee product owns its installation private key and pins the authority
identity. The authority owns membership, enrollment grants, leases, and
revocation; it never owns meeting or reasoning data.

The administrator sends the private mode-0600 invitation file to the employee
and communicates the displayed authority PIN through a separate trusted
channel. `organization enroll` refuses to treat the PIN embedded in the
invitation itself as independent verification. Enrollment retains the signed
request, signed receipt, signed access state, and the authority's non-secret
HTTPS origin plus any explicitly supplied internal CA; it never stores the
bearer grant. `organization refresh` therefore works after the invitation is
securely removed.

Once the authority is pinned, product startup and every processing cycle check
the signed access lease before adapter contact. The running service renews its
short lease in the background. A transient authority outage can use only the
remaining signed lease; expiration or revocation fails closed. Use
`organization rebind` with the same independently verified authority PIN to
prove the identical authority at a new HTTPS origin before changing the saved
route.

Once the organization Slack tool is active, an enrolled installation links its
Slack identity with `organization slack-link-begin` and
`organization slack-link-complete`. The one-time code travels through a reply
in the exact Slack challenge thread and the `ECHO_SLACK_LINK_CODE` environment
variable, never a command-line argument. The
[authority service](services/organization-authority/README.md) README carries
the exact steps.

The current portable machine key is an exportable software key, so enrollment
requires the explicit `--allow-exportable-software-key` acknowledgement.
Enrollment, explicit rebind, and manual refresh require the product service to
be stopped because they take the exclusive runtime maintenance window.

## Architecture

The core owns canonical meeting, decision, brief, approval, delivery, receipt,
and error shapes. Adapters own authentication, vendor APIs, pagination,
rate-limit handling, and mapping to or from those shapes.

The primary repository map is
[organization-workspace-boundaries.md](docs/architecture/organization-workspace-boundaries.md).
Extension rules are in
[core-and-adapters.md](docs/architecture/core-and-adapters.md). The original
source-extraction history remains available in Git; it is no longer active
runtime or CI machinery.
