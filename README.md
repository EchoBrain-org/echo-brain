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
  and direct approve/reject permission checks; and
- a source-implemented bounded permission-aware organization readable-search
  baseline, documented with its authority lifecycle rather than as a deployed
  feature.

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
npm install -g ./echo-brain-0.1.0-internal.6.tgz
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
exact bytes are pinned by a manifest and checksums, with bundled provenance
evidence attached.

### One-time updater bootstrap

A clean Mac needs one manual install of an updater-capable release. The
administrator chooses one exact release as the bootstrap anchor and transfers
that release's artifact, manifest, checksums, and attestation bundle as one
directory. The version, source SHA, and artifact SHA-256 travel over
the trusted handoff channel. Those coordinates are immutable for that handoff;
never substitute a moving `latest` release. Downloading the private release may
use an administrator's GitHub session on an admin workstation, but the employee
Mac must not receive or require those credentials.

Before a new employee runs `bootstrap` and becomes an active installation, the
administrator must approve this exact manifest as the Authority's current
Internal Live release. Version, source SHA, and artifact SHA-256 must match the
transferred bundle. This ordering matters: the rollout gate may require every
existing active installation to be healthy on the previous release before it
accepts the next one. With no current directive the final update stops; it also
refuses to install a lower Internal Live version than the one already installed.

An already-enrolled Mac whose CLI predates `update apply` is a maintenance
migration, not a clean bootstrap. Verify the release first, then use a reviewed
operator procedure that retains the old package, stops the service before
backing up state, restores both on failure, and finishes with native
`update apply`. Do not paste the clean-install command over a running enrolled
installation. All current Internal Live pilot Macs have completed this
transition; future releases use the normal updater below.

First perform every non-mutating trust check while any existing service remains
running. On either kind of Mac, replace every angle-bracket value with the
administrator's exact approved coordinates and point `BOOTSTRAP_DIRECTORY` at
the transferred release directory. The independently communicated artifact
SHA-256 is the employee's bootstrap integrity anchor. The bundled Sigstore
attestation is verified against the public trust root obtained by GitHub CLI
and additionally checks provenance for the pinned GitHub workflow and source
commit. It does not independently prove the approver's identity. The protected
`internal-live` environment is the publisher-side approval gate. The employee
Mac needs network access to the public trust service, but no GitHub login or
Actions API access:

```sh
set -euo pipefail
BOOTSTRAP_REPOSITORY='EchoBrain-org/echo-brain'
BOOTSTRAP_VERSION='<exact MAJOR.MINOR.PATCH-internal.SEQUENCE>'
BOOTSTRAP_SOURCE_SHA='<exact 40-character source SHA>'
BOOTSTRAP_ARTIFACT_SHA256='<exact 64-character artifact SHA-256>'
BOOTSTRAP_TAG="internal-v${BOOTSTRAP_VERSION}"
BOOTSTRAP_ARTIFACT="echo-brain-${BOOTSTRAP_VERSION}.tgz"
BOOTSTRAP_DIRECTORY='/absolute/path/to/transferred-release-directory'
BOOTSTRAP_ARTIFACT_PATH="${BOOTSTRAP_DIRECTORY}/${BOOTSTRAP_ARTIFACT}"
BOOTSTRAP_MANIFEST_PATH="${BOOTSTRAP_DIRECTORY}/internal-live-release-manifest.v1.json"
BOOTSTRAP_ATTESTATION_PATH="${BOOTSTRAP_DIRECTORY}/internal-live-attestation-bundle.v1.json"
BOOTSTRAP_GH_CONFIG="$(mktemp -d)"
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
test -s "$BOOTSTRAP_ARTIFACT_PATH"
test -s "$BOOTSTRAP_MANIFEST_PATH"
test -s "${BOOTSTRAP_DIRECTORY}/SHA256SUMS"
test -s "$BOOTSTRAP_ATTESTATION_PATH"

test "$("$BOOTSTRAP_NODE" -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write([
    value.release_version,
    value.release_tag,
    value.source?.sha,
    value.artifact?.filename,
    value.artifact?.sha256,
    value.build?.repository,
    value.build?.workflow,
  ].join("|"));
' "$BOOTSTRAP_MANIFEST_PATH")" \
  = "${BOOTSTRAP_VERSION}|${BOOTSTRAP_TAG}|${BOOTSTRAP_SOURCE_SHA}|${BOOTSTRAP_ARTIFACT}|${BOOTSTRAP_ARTIFACT_SHA256}|${BOOTSTRAP_REPOSITORY}|internal-live-release.yml"

test "$(awk 'NR==1{v=$1"|"$2} END{if(NR!=1)exit 1; print v}' \
  "${BOOTSTRAP_DIRECTORY}/SHA256SUMS")" \
  = "${BOOTSTRAP_ARTIFACT_SHA256}|${BOOTSTRAP_ARTIFACT}"
(cd "$BOOTSTRAP_DIRECTORY" && \
  printf '%s  %s\n' "$BOOTSTRAP_ARTIFACT_SHA256" "$BOOTSTRAP_ARTIFACT" | \
  shasum -a 256 --check -)

env -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR="$BOOTSTRAP_GH_CONFIG" \
  gh attestation verify "$BOOTSTRAP_ARTIFACT_PATH" \
    --repo "$BOOTSTRAP_REPOSITORY" \
    --bundle "$BOOTSTRAP_ATTESTATION_PATH" \
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

After the administrator supplies the employee's invitation and communicates
the Authority PIN over an independent channel, the employee runs one ECHO
command. Keep the invitation in a current-user `0700` directory as a `0600`
file; it contains a one-time enrollment secret. The administrator also supplies
the approved Slack channel and employee reviewer identity. The command prompts
locally for the Granola token and organization Slack bot token without echoing
either one. Before running it, make sure Granola has at least one accessible
note whose provider-reported owner is the employee email among the first 30
notes returned; creating one fresh owner-visible note is the simplest pilot
setup for a shared team key:

```sh
ECHO_CONFIG="$HOME/.config/echo-brain/runtime.json"
ECHO_STATE="$HOME/.local/share/echo-brain"
ECHO_INVITATION="$HOME/.config/echo-brain/enrollment/echo-organization-invitation.json"

echo-brain bootstrap \
  --config "$ECHO_CONFIG" \
  --state-dir "$ECHO_STATE" \
  --owner-email '<employee canonical lowercase email>' \
  --slack-channel-id '<C...>' \
  --slack-reviewer-user-id '<U...>' \
  --slack-reviewer-name '<employee display name>' \
  --invitation "$ECHO_INVITATION" \
  --authority-pin '<PIN from the independent channel>' \
  --allow-exportable-software-key
```

`bootstrap` requires a materialized-commit build; release provenance is
established by the artifact verification above. It creates an owner-bound
Granola source with `page_size: 1`, configures the existing Slack-reaction
approval adapter, then makes one bounded Granola `listNotes` request for at
most 30 note headers and requires a provider-reported record-owner match. It
never fetches a note body during this check, and a newly supplied Granola token
is written to its private local file only after the match succeeds. It then
reads and stores the Slack token, initializes and enrolls the installation, and
runs an internal local preflight. It does not place an auto-start file in
`~/Library/LaunchAgents`, construct product adapters, contact Slack or an LLM,
or start product work. The successful final service state is
`installed: false`, `loaded: false`, `running: false`.

The observed owner email is a local Granola record boundary, not proof that the
API key itself belongs to the employee and not an Authority-issued identity
claim. After bootstrap, the employee proves the
configured Slack reviewer through the installation-signed thread challenge:

```sh
echo-brain organization slack-link-begin --config "$ECHO_CONFIG"
# Follow the emitted instructions to reply in Slack and run slack-link-complete.
```

The completion result contains non-secret `identity_link_id`,
`adapter_binding_id`, `membership_id`, and `installation_id` values. The
administrator activates approve/reject permission for that already-verified
link from the Authority machine:

```sh
echo-organization-admin slack approval activate \
  --config '<absolute Authority config path>' \
  --administrator-membership-id '<active owner mem_...>' \
  --target-membership-id '<employee mem_...>' \
  --installation-id '<employee ins_...>' \
  --identity-link-id '<verified clm_...>' \
  --adapter-binding-id '<verified bnd_...>'
```

Activation neither calls Slack nor creates an identity link or adapter
binding. The verified identity link the employee already proved is its
prerequisite and audit reference; the two direct grants it adds are scoped to
the exact adapter binding, principal, and membership. Exact retries reuse the
existing grants.

Only after that central activation succeeds, run the stopped, controlled test:

```sh
# The note must be visible to the employee and contain explicit
# Decision:, Action:, and Rationale: lines.
echo-brain run-once --config "$ECHO_CONFIG"
echo-brain approvals --config "$ECHO_CONFIG"
# React to the new card in Slack as the configured reviewer.
echo-brain run-once --config "$ECHO_CONFIG"
test "$(wc -l < "$ECHO_STATE/outbox.jsonl" | tr -d ' ')" = 1
echo-brain run-once --config "$ECHO_CONFIG"
test "$(wc -l < "$ECHO_STATE/outbox.jsonl" | tr -d ' ')" = 1
```

The first pass creates and posts one pending approval. The reviewer reaction is
checked live by the Authority; the second pass resolves and writes exactly one
JSONL delivery; the third confirms it is not duplicated. Then run the normal
`service install`, green doctor, and native `update apply`. That last command
exercises the Authority's signed release path and records the installation's
healthy receipt centrally. The manual first package install is the sole
pre-Authority exception.

```sh
echo-brain service install --config "$ECHO_CONFIG"
echo-brain doctor --config "$ECHO_CONFIG"
echo-brain update apply --channel internal-live --config "$ECHO_CONFIG"
```

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

`bootstrap` is the only supported v1 setup path: it writes the private config
and state, provisions the credentials, initializes, and enrolls in one command.
After it succeeds, the individual commands stay available for inspection and
maintenance:

```sh
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
silently. That key authenticates the supported organization enrollment and
Authority flows. It is not used to revive or qualify retired local founder
identity; any founder residue is refused before product work begins.

Central organization-admin bootstrap is the one supported v1 enrollment path.
The local founder-provenance mode -- the `identity-bootstrap` ceremony, the
federated `export` command, and the signed record projection and protected
independent copy behind them -- is retired and removed from this build.

A state root that still holds founder identity or cutover material is detected
and refused, not downgraded. One early dispatch gate refuses `bootstrap`,
`init`, `reconfigure`, `doctor`, `update`, every `organization` action,
`approvals`, `run-once`, the launchd `service-run` child, and `service
install`/`start`/`restart` — before a `ProductOperator` is constructed, the
filesystem is probed, a lifecycle lock is taken, a directory is created or
chmodded, credentials are resolved, SQLite is opened or migrated, a provider or
the Authority is contacted, or an injected callback runs. An injected approval
store or callback cannot bypass it.

The exceptions are not "commands that do not write" — several of them do write.
They are the commands whose purpose is to inspect, preserve, or quiesce a
fenced profile: `--help`/`--version`, `validate-config`, `status`, `backup`,
`restore`, and `service stop`/`status`/`uninstall`.
`organization status` is **not** an exception: it opens and migrates writable
SQLite, so it is gated with every other organization action.

Old founder state is never parsed: the code that read, validated, or recovered
it is deleted, and detection is presence-only. `backup` of a fenced profile
stays available: regular state-tree files are copied byte-for-byte, the SQLite
database is captured as a consistent SQLite backup, and the external cutover
guard remains beside the original state path, outside the backup. Recovery
does not go through a
restore: `restore` refuses — before its safety pre-backup, its durable marker,
staging, or any live change — whenever the live target holds founder residue
*or* the validated backup payload would reintroduce it, and it will not
recover, roll back, or report success over interrupted restore artifacts that
involve that residue.

The executable order matters, because `backup` refuses to run while the service
is loaded:

```sh
echo-brain service stop --config /absolute/path/retired-runtime.json
echo-brain backup --config /absolute/path/retired-runtime.json \
  --backup-root /absolute/path/backups

echo-brain bootstrap \
  --config /absolute/path/new-runtime.json \
  --state-dir /absolute/path/new-state \
  --owner-email '<employee canonical lowercase email>' \
  --slack-channel-id '<C...>' \
  --slack-reviewer-user-id '<U...>' \
  --slack-reviewer-name '<employee display name>' \
  --invitation /absolute/path/echo-organization-invitation.json \
  --authority-pin sha256:PIN_FROM_A_SEPARATE_TRUSTED_CHANNEL \
  --allow-exportable-software-key
```

Recovery is a fresh central bootstrap, not a repair of the fenced profile. The
new path must be free of founder residue — that is what the fence checks, not
pristineness in general. `bootstrap` prompts for the Granola and Slack tokens,
initializes the installation, and enrolls it against a not-yet-enrolled
membership.

This pre-1.0 build does not migrate, exercise, or provide a readiness diagnostic
for a retired founder identity. Preserve the prior state when identity
continuity matters; fresh central bootstrap is the supported way forward.

## Runtime configuration

Operational commands require an absolute JSON config path. `bootstrap` writes
the supported Internal Live configuration: Granola as the meeting source, the
`structured-text` decision processor, the local JSONL outbox, and Slack
reaction approval. There is no hand-written baseline to copy — the sections
below document the fields that profile uses and the alternatives the composition
root also bundles.

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

## Slack approval

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

The approval channel is a separate PUBLIC organization review channel — the
same Authority-bound public channel the organization verifies during Slack
onboarding. V1 does not support private approval channels. The bot needs
`chat:write`, `reactions:read`, and the public channel history scope. Only
the configured reviewer can resolve a brief.

V1 delivers approved briefs to the local JSONL outbox; Slack carries approval
only. Generic Slack delivery already exists but is not enabled in the Internal
Live V1 profile. If it is enabled later it must use a different channel than
the approval surface, so review traffic stays in the review channel: `init` and
a configuration-changing `reconfigure` refuse a config that points both at one
channel. The rule reads only the configuration — it contacts no provider and
discovers no Slack channel — and a package-only re-pin of an unchanged
configuration recorded before the rule existed is still allowed.

## Day-to-day commands

```sh
echo-brain validate-config --config /absolute/path/runtime.json
echo-brain status --config /absolute/path/runtime.json
echo-brain run-once --config /absolute/path/runtime.json
echo-brain approvals --config /absolute/path/runtime.json
```

Every command takes an absolute `--config` path and rejects any option that
command does not define.

`run-once` loads the configured adapters, processes available meetings,
persists cursors and decisions, waits for approval, and delivers the exact
approved snapshot. Failures conservatively pin the source cursor. The installed
LaunchAgent runs the same cycle continuously; there is no foreground `run`.

`approvals` lists local decision records without a federation projection. It
cannot resolve one — the organization
Slack approval surface is the single v1 resolver, so every approve/reject is
centrally attributed and authorized — but it is not a fully read-only command
either: listing opens the local decision store, which initializes or migrates
that state on first use. A historical node whose requested metadata owns a
`federation` field is from the retired capture path and is refused rather than
reinterpreted; similarly named publication or resolution fields remain opaque
local metadata.

`status` reports the recorded installation and the LaunchAgent state.

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
before touching launchd. The LaunchAgent invokes a hidden `service-run` child
that re-proves the immutable service identity and then runs the cycle loop.

`reconfigure` re-records the installation manifest after the configuration
content or product version changes. Before rewriting the manifest it proves
statically that this package can run the recorded configuration: every
configured adapter factory exists and each one's own static validator accepts
its configuration. That proof constructs no adapter and reads no credential,
environment, state store, or provider, so update and recovery never depend on
provider uptime or on anything outside the config file. A factory that exposes
no static validator is refused rather than skipped, and every rejection in a
pass is reported together. `reconfigure` requires the service to be stopped and
refuses to change the config path, state directory, Node, CLI, or service
identity.

## Organization onboarding and access

The single-organization authority is a separate workspace and deployment. Its
employee APIs and `/admin` console share one HTTPS origin behind a standard
reverse proxy. See:

- [authority service](services/organization-authority/README.md)
- [portable one-machine deployment](deploy/organization-authority/README.md)
- [organization protocol boundaries](docs/architecture/organization-workspace-boundaries.md)
- [organization control-plane design](docs/architecture/organization-control-plane.md)
- [permission-aware readable-search baseline](docs/product/2026-08-11-trusted-permission-aware-searchable-layer-2-design.md)

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
short lease in the background. Current installations explicitly request up to
a 30-minute renewal; legacy V1 installations continue to receive five-minute
renewals. A transient authority outage can use only the remaining signed lease;
expiration or revocation fails closed. Authority-backed permission and read
requests still recheck current central access rather than treating the local
lease as cached content authorization. Use
`organization rebind` with the same independently verified authority PIN to
prove the identical authority at a new HTTPS origin before changing the saved
route.

Deploy a V2-capable Authority before a V2-capable product. The new Authority
continues to serve legacy V1 products, while a new product deliberately fails
closed against an Authority that does not understand its signed V2 request.

Once the organization Slack tool is active, an enrolled installation links its
Slack identity with `organization slack-link-begin` and
`organization slack-link-complete`. The one-time code travels through a reply
in the exact Slack challenge thread and the `ECHO_SLACK_LINK_CODE` environment
variable, never a command-line argument. Linking creates no permission grant;
an organization owner must then run `echo-organization-admin slack approval
activate` for the returned identity link and adapter binding. The
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
