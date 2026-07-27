# Organization administrator edge

**Status:** Founder Live deployment contract available; no live deployment,
production qualification, or Phase 5 network qualification claimed

This runbook describes how to build, configure, start, rotate, and roll back
the organization administrator HTTPS edge. It defines a target operating
boundary for local and later deployment work. Completing these steps on a
developer machine does not prove a production endpoint and does not close
Phase 5 `P5-NET-001`.

## Deployable and trust boundary

The edge is an exact artifact distinct from both other runtime artifacts:

```text
employee-machine ECHO artifact
single-organization authority artifact
organization administrator edge artifact
```

It is a foreground, stateless transport process. It owns:

- server TLS for one exact administrator origin;
- mandatory client-certificate verification;
- an explicit administrator client-SPKI SHA-256 allowlist;
- canonical request-target, Host, header, framing, size, and timeout checks;
- an exact console route allowlist;
- trusted identity injection on the private loopback hop; and
- the local, non-secret `GET /admin/edge-config` deployment-metadata response.

It does not own membership, organization roles, the administrator bearer
credential, authority browser sessions, CSRF decisions, invitation grant
registration, enrollment, leases, revocation, audit, signing, or any database.
Those remain in the single-organization authority.

```text
administrator browser
  -- HTTPS to exact admin.example.com
  -- valid client certificate
  -- configured SPKI pin
  --> administrator edge
        -- one sanitized, bounded request
        -- one injected Echo-Proxy credential
        -- one cid_ identity derived from authenticated certificate material
        --> http://127.0.0.1:<authority-port>
            organization authority

invitation authority_base_url
  --> https://employee-authority.example.com
      (a separate employee-facing origin, not an admin-edge proxy route)
```

## Exact artifact

Build only from a clean committed source state. The builder requires the
supplied full SHA to equal `HEAD`, materializes that commit independently, and
publishes one tarball, checksum sidecar, and artifact manifest into a new output
directory:

```sh
node tools/organization-admin-edge/build-artifact.mjs \
  --version 0.1.0-dev.admin-edge \
  --source-sha "$(git rev-parse HEAD)" \
  --out-dir /absolute/path/to/admin-edge-artifact
```

Verify the published directory on the release workstation:

```sh
node tools/organization-admin-edge/verify-artifact.mjs \
  --artifact-dir /absolute/path/to/admin-edge-artifact \
  --output /absolute/path/to/admin-edge-verification.json
```

The verifier checks the complete file set, manifest, tarball checksum,
per-file hashes, build identity, bundled shared workspaces, runtime dependency
closure, and declared platform. It does not validate operator certificates,
credentials, network policy, or a live deployment.

The artifact must contain no runtime configuration, TLS material, client CA,
proxy token, log, or supervisor state. Installation and service supervision
remain operator-owned. Retain the tarball, manifest, checksum, and verification
record together so rollback can select exact previously verified bytes.

The artifact also contains the exact verifier, installer, LaunchAgent
preparer, Founder Live plan creator, evidence validator, and evidence schema.
The service runtime never imports those operator tools. A target host does not
need a repository checkout or `node_modules`.

## Sealed Founder Live installation

The minimum Founder Live lane uses one private Apple Silicon Mac, Node 22.22.1,
a non-root high-port edge listener, private VPN forwarding from port 443, and a
per-user LaunchAgent. Public internet exposure is outside this lane.

Install only after obtaining the tarball SHA-256 through an independent
operator channel. First compare that value to the tarball with the platform
SHA-256 utility. Only after that comparison succeeds, extract the six
operator tools and evidence schema into a new private bootstrap directory.
Run the packaged verifier from that directory. This small bootstrap is the
only pre-install extraction; its bytes are already covered by the
independently verified tarball hash.

```sh
/usr/bin/shasum -a 256 \
  /absolute/candidate/organization-admin-edge/echo-brain-organization-admin-edge-<version>.tgz

/bin/mkdir -m 700 -p \
  /absolute/private/bootstrap/package/tools/organization-admin-edge \
  /absolute/private/bootstrap/package/schemas

umask 077
set -o noclobber
/usr/bin/tar -xOf \
  /absolute/candidate/organization-admin-edge/echo-brain-organization-admin-edge-<version>.tgz \
  package/tools/organization-admin-edge/verify-artifact.mjs \
  > /absolute/private/bootstrap/package/tools/organization-admin-edge/verify-artifact.mjs
/usr/bin/tar -xOf \
  /absolute/candidate/organization-admin-edge/echo-brain-organization-admin-edge-<version>.tgz \
  package/tools/organization-admin-edge/install-release.mjs \
  > /absolute/private/bootstrap/package/tools/organization-admin-edge/install-release.mjs
/usr/bin/tar -xOf \
  /absolute/candidate/organization-admin-edge/echo-brain-organization-admin-edge-<version>.tgz \
  package/tools/organization-admin-edge/prepare-launchd.mjs \
  > /absolute/private/bootstrap/package/tools/organization-admin-edge/prepare-launchd.mjs
/usr/bin/tar -xOf \
  /absolute/candidate/organization-admin-edge/echo-brain-organization-admin-edge-<version>.tgz \
  package/tools/organization-admin-edge/create-founder-live-plan.mjs \
  > /absolute/private/bootstrap/package/tools/organization-admin-edge/create-founder-live-plan.mjs
/usr/bin/tar -xOf \
  /absolute/candidate/organization-admin-edge/echo-brain-organization-admin-edge-<version>.tgz \
  package/tools/organization-admin-edge/verify-founder-live-activation.mjs \
  > /absolute/private/bootstrap/package/tools/organization-admin-edge/verify-founder-live-activation.mjs
/usr/bin/tar -xOf \
  /absolute/candidate/organization-admin-edge/echo-brain-organization-admin-edge-<version>.tgz \
  package/tools/organization-admin-edge/validate-founder-live-evidence.mjs \
  > /absolute/private/bootstrap/package/tools/organization-admin-edge/validate-founder-live-evidence.mjs
/usr/bin/tar -xOf \
  /absolute/candidate/organization-admin-edge/echo-brain-organization-admin-edge-<version>.tgz \
  package/schemas/organization-admin-edge-founder-live-evidence.v1.schema.json \
  > /absolute/private/bootstrap/package/schemas/organization-admin-edge-founder-live-evidence.v1.schema.json
/bin/chmod 400 \
  /absolute/private/bootstrap/package/tools/organization-admin-edge/*.mjs \
  /absolute/private/bootstrap/package/schemas/*.json

/absolute/canonical/node-22.22.1 \
  /absolute/private/bootstrap/package/tools/organization-admin-edge/verify-artifact.mjs \
  --artifact-dir /absolute/candidate/organization-admin-edge
```

Compare the first command's digest character-for-character with the
independent value; do not treat the checksum sidecar delivered beside the
tarball as independent evidence. The bootstrap uses `tar -xOf` plus exclusive
regular-file creation; it never materializes archive links or metadata. The
packaged verifier also rejects every non-regular, linked, duplicate, or
ambiguous archive member before installation.

Then run the packaged installer:

```sh
/absolute/canonical/node-22.22.1 \
  /absolute/private/bootstrap/package/tools/organization-admin-edge/install-release.mjs \
  --artifact-dir /absolute/candidate/organization-admin-edge \
  --expected-artifact-sha256 <64-lowercase-hex-digest> \
  --install-root "/Users/<service-user>/Library/Application Support/ECHO/organization-admin-edge-install"
```

The command returns the exact `release_directory`, `edge_cli_path`, artifact
identity, and deployed-tree digest. Repeating it with the same artifact is
read-only and verifies the existing release. It never replaces or mutates a
release. Configuration, TLS material, client CA, client pins, proxy token,
logs, evidence, and LaunchAgent files remain outside the install root.

Create a separate current-user-owned mode-`0700` state directory with private
`logs/`, `evidence/`, `preparations/`, and `network/` children. The
administrator edge remains stateless; this directory contains only supervisor
output and deployment evidence. Delete the bootstrap after the sealed release
and its packaged verifier have re-verified successfully; use operator tools
from `<release_directory>/runtime/package/tools/organization-admin-edge/`
after that point.

## Runtime files and configuration

Place runtime files outside the immutable installation prefix. Use normalized
absolute paths. The config file and every referenced file must be canonical
regular files owned by the service account, must not be symlinks, and must have
the required private mode (currently `0600`). Do not place secret values inline
in JSON, environment variables, command arguments, readiness output, or logs.

The runtime configuration is exact-shaped. A representative outline is:

```json
{
  "schema_version": 1,
  "kind": "echo-organization-admin-edge-runtime-config",
  "listener": {
    "host": "127.0.0.1",
    "port": 8443
  },
  "public_origin": "https://admin.example.com",
  "employee_authority_base_url": "https://employee-authority.example.com",
  "authority_origin": "http://127.0.0.1:39479",
  "tls": {
    "certificate_chain_ref": "file:/absolute/private/admin-edge/server-chain.pem",
    "private_key_ref": "file:/absolute/private/admin-edge/server-key.pem",
    "client_ca_bundle_ref": "file:/absolute/private/admin-edge/admin-client-ca.pem"
  },
  "trusted_proxy_token_ref": "file:/absolute/private/admin-edge/trusted-proxy-token",
  "allowed_admin_client_spki_sha256": [
    "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  ]
}
```

The example pin is a placeholder and must never be deployed. Compute each pin
from the DER-encoded subject public-key information of the intended
administrator client key, then verify the certificate-to-person mapping
through an independent operator channel.

Founder Live uses one fixed ingress shape:

```text
administrator device on private VPN
  -> VPN-only TCP 443
  -> TLS pass-through forwarding
  -> 127.0.0.1:8443 on the edge host
```

The edge must not bind a LAN or public interface. Before planning the live
run, the operator must select and configure the actual VPN/L4 provider and
write a secret-free policy record with
`kind: echo-organization-admin-edge-vpn-ingress-policy`, its provider and
policy identifiers, application time, `private-vpn-only` scope, public port
443, loopback target `127.0.0.1:8443`, TLS `passthrough`, and the SHA-256 of a
secret-free procedure record. The procedure fixes bounded argv for apply,
disable, enabled verification, and disabled verification, plus the SHA-256 of
their one canonical, executable, non-group/world-writable provider binary.
Credentials must come from the provider's protected host binding, never argv.
The plan hashes both records and re-hashes that executable. Provider selection
and the applied target policy are target inputs; an example hostname or
unapplied policy cannot satisfy this gate.

```json
{
  "schema_version": 1,
  "kind": "echo-organization-admin-edge-vpn-ingress-procedure",
  "provider": "<selected-provider>",
  "policy_id": "<applied-policy-id>",
  "executable_sha256": "<sha256-of-exact-provider-cli>",
  "apply_argv": ["/absolute/provider-cli", "apply", "<policy-id>"],
  "disable_argv": ["/absolute/provider-cli", "disable", "<policy-id>"],
  "verify_enabled_argv": [
    "/absolute/provider-cli",
    "verify-enabled",
    "<policy-id>"
  ],
  "verify_disabled_argv": [
    "/absolute/provider-cli",
    "verify-disabled",
    "<policy-id>"
  ]
}
```

```json
{
  "schema_version": 1,
  "kind": "echo-organization-admin-edge-vpn-ingress-policy",
  "provider": "<selected-provider>",
  "policy_id": "<applied-policy-id>",
  "applied_at": "2026-07-27T18:00:00.000Z",
  "ingress_mode": "vpn-l4-forward-to-loopback",
  "public_scope": "private-vpn-only",
  "public_port": 443,
  "forward_host": "127.0.0.1",
  "forward_port": 8443,
  "tls_mode": "passthrough",
  "procedure_sha256": "<sha256-of-exact-procedure-record-bytes>"
}
```

Configuration rules are fail-closed:

- `public_origin` is one canonical bare HTTPS origin with a DNS hostname. Its
  host is the only accepted TLS SNI and HTTP `Host`/`:authority`.
- `employee_authority_base_url` is one canonical bare HTTPS origin. It is the
  locator embedded in newly generated employee invitations; it grants no
  authority by itself.
- `authority_origin` is one bare loopback HTTP origin using only `127.0.0.1` or
  `[::1]`. It has no path, query, fragment, credentials, DNS resolution,
  redirect, alternative, or remote fallback.
- The server certificate chain, private key, client CA bundle, and trusted
  proxy token use distinct external `file:` references.
- The proxy token contains at least 32 visible ASCII bytes and must match the
  authority's separately configured trusted-proxy credential. It is distinct
  from the administrator bearer credential.
- The client-SPKI pin set is nonempty, bounded, canonical, and duplicate-free.
  A valid chain without a pin match is rejected; a pin match without a valid
  chain is also rejected.

The edge and authority may share one host but remain separate artifacts and
processes. If different service accounts are used, provision the same proxy
token value into separate owner-only files. Do not weaken file permissions or
move the authority origin onto a LAN to share it.

## Startup outline

Before starting:

1. Verify the exact edge artifact and record its artifact and manifest hashes.
2. Verify the authority is the intended process on the configured loopback
   listener and is using the matching trusted-proxy token.
3. Inspect the administrator server certificate for the exact
   `public_origin` hostname and current validity.
4. Inspect the client CA and each allowed client certificate, including
   client-auth usage, validity, and independently verified SPKI pin.
5. Confirm the employee authority HTTPS origin is separately reachable through
   its intended employee deployment path; do not expose its routes through the
   administrator host.
6. Confirm the runtime config and referenced files satisfy ownership, mode,
   canonical-path, size, and distinct-file rules.

Run the packaged no-bind preflight after those operator checks and before
installing the supervisor definition:

```sh
/absolute/sealed/release/runtime/package/bin/echo-organization-admin-edge.mjs \
  preflight --config /absolute/private/admin-edge/admin-edge.json
```

The command requires the declared `darwin/arm64` Node 22.22.1 runtime. It
reuses the exact configuration, private-file, certificate, key, client-CA, and
TLS-context preparation path used by `serve`, but it opens no listener and
contacts no authority. Success writes one bounded secret-free JSON record and
returns zero. Expected failure returns one with a fixed `failed_check` code;
raw file paths, certificate identities, pins, tokens, private material, and
Node/OpenSSL errors are never included.

The version 1 failure-code set is `release_platform`, `runtime_config`,
`runtime_material`, `server_certificate_parse`,
`server_certificate_hostname`, `server_certificate_purpose`,
`server_certificate_not_yet_valid`, `server_certificate_expired`,
`server_private_key_parse`, `server_private_key_mismatch`, and
`client_ca_or_tls_context`. The packaged README defines each code. A client CA
bundle is accepted only when it contains PEM certificate blocks separated by
whitespace.

Preflight checks local material at one instant. It cannot prove DNS,
firewalling, supervisor behavior, authority reachability or proxy-token
equality, public-chain acceptance, individual administrator certificate
identity or validity, revocation, renewal monitoring, rollback, listener
address or port availability, or permission to bind that listener. Those
remain explicit live acceptance steps.

The packaged binary is intended to run in the foreground under an external
supervisor:

```sh
/absolute/sealed/release/runtime/package/bin/echo-organization-admin-edge.mjs \
  serve --config /absolute/private/admin-edge/admin-edge.json
```

`serve` enforces the declared runtime cell (`darwin/arm64`, Node `22.22.1`)
before it reads private runtime configuration or opens a listener. npm
`10.9.4` remains the artifact build/install toolchain declaration; the running
edge does not invoke a package manager.

An unsupported developer host may run only a loopback-bound edge by adding
`--acknowledge-unsupported-host-for-development`. That flag emits a structured
non-qualifying warning and is rejected on the declared release cell. Never put
the flag in a production supervisor command, and never use it to claim
deployment or Phase 5 evidence.

The supervisor owns start, stop, restart, log destination, and crash policy.
It must not place certificate, key, token, or configuration content in its unit
definition. Missing or invalid configuration, TLS material, client trust,
allowlist, or loopback origin must prevent the public listener from becoming
ready. The generated LaunchAgent does not rotate its stdout/stderr files.
Before unattended Founder Live operation, install and test a current-user log
rotation or size-monitoring job with a bounded threshold and retention policy.

### Prepare the Founder Live LaunchAgent

On the target `darwin/arm64` host, invoke the **sealed release's** preparation
tool with the canonical Node 22.22.1 executable and `release_directory`
returned by the installer:

```sh
/absolute/canonical/node-22.22.1 \
  /absolute/sealed/release/runtime/package/tools/organization-admin-edge/prepare-launchd.mjs \
  --release-dir /absolute/sealed/release-directory \
  --expected-artifact-sha256 <64-lowercase-hex-digest> \
  --config /absolute/private/admin-edge/admin-edge.json \
  --state-dir /absolute/private/admin-edge-state
```

This command re-verifies the sealed release, runs that exact candidate's
preflight, hashes the unchanged config and exact Node executable, and creates
a unique mode-`0700` attempt below `state/preparations/`. A successful attempt
contains durable mode-`0600` `preflight.json`, `launch-agent.plist`, and
`preparation.json` files. The command returns their paths and hashes. It opens
no listener, never adds the development-only unsupported-host flag, and never
writes into `~/Library/LaunchAgents`. A failed attempt retains its preflight
record but no plist; retrying creates a new attempt, so failure evidence is
never deleted or overwritten.

The plist executes exactly:

```text
<canonical-node> <sealed-release>/runtime/package/bin/echo-organization-admin-edge.mjs serve --config <private-config>
```

It contains no secret value or environment variable. Its working directory
and stdout/stderr logs are below the separate private state directory.

### Freeze the plan before live access

Do not bootstrap the service or connect a live client until the plan exists.
After the target VPN/L4 policy has been applied and recorded, create the plan
with the sealed release's tool:

```sh
/absolute/canonical/node-22.22.1 \
  /absolute/sealed/release/runtime/package/tools/organization-admin-edge/create-founder-live-plan.mjs \
  --preparation /absolute/private/admin-edge-state/preparations/<attempt>/preparation.json \
  --restored-preparation /absolute/private/admin-edge-state/preparations/<attempt>/preparation.json \
  --network-policy /absolute/private/admin-edge-state/network/vpn-policy.json \
  --network-procedure /absolute/private/admin-edge-state/network/vpn-procedure.json \
  --recovery-mode disable_restore_same_candidate \
  --output /absolute/private/admin-edge-state/evidence/founder-live-plan.json
```

For a first deployment, `disable_restore_same_candidate` is the minimum
recovery drill and `--restored-preparation` is the same exact preparation
record. For a later upgrade, first create a fresh preparation for the
previously sealed release against current runtime material, then use that
distinct record with `rollback_previous_release`. The tool re-reads and hashes
the preflight, plist, config, Node executable, network policy, network
procedure, and both preparation records. It creates the plan exclusively as
mode `0400` and refuses to overwrite it. Any new candidate, config, network
policy or procedure, plist, Node binary, or recovery target requires a new
plan.

Before activation, publish the returned `plan_sha256` to an independent,
append-only founder-controlled channel and export its receipt as:

```json
{
  "schema_version": 1,
  "kind": "echo-organization-admin-edge-founder-live-plan-commitment",
  "plan_sha256": "<exact-plan-sha256>",
  "committed_at": "2026-07-27T18:02:00.000Z",
  "channel": "<append-only-channel-id>",
  "receipt_id": "<immutable-receipt-id>"
}
```

The receipt time must follow plan creation and precede `started_at`. Keep the
receipt beside the private evidence; the final validator re-hashes it and
requires its plan digest to match. A local timestamp or local mode `0400`
alone is not a precommit.

### Load, inspect, restart, and disable

Immediately before any launchd or VPN mutation, re-verify all planned bytes:

```sh
/absolute/canonical/node-22.22.1 \
  /absolute/sealed/release/runtime/package/tools/organization-admin-edge/verify-founder-live-activation.mjs \
  --plan /absolute/private/admin-edge-state/evidence/founder-live-plan.json \
  --commitment /absolute/private/admin-edge-state/evidence/plan-commitment.json \
  --preparation /absolute/private/admin-edge-state/preparations/<attempt>/preparation.json \
  --restored-preparation /absolute/private/admin-edge-state/preparations/<attempt>/preparation.json \
  --network-policy /absolute/private/admin-edge-state/network/vpn-policy.json \
  --network-procedure /absolute/private/admin-edge-state/network/vpn-procedure.json \
  --release-dir /absolute/sealed/release-directory \
  --output /absolute/private/admin-edge-state/evidence/activation-verification.json
```

This check is read-only apart from its exclusive evidence output. Any mismatch
in the sealed release, config, Node path or bytes, staged plist, preflight,
network policy/procedure, recovery preparation, plan, or independent
commitment stops activation.

Use the stable label
`com.echo.brain.organization-admin-edge.founder-live`. Keep the label disabled
while installing the planned plist. Copy the staged plist to a unique sibling
of the stable target, lint it, compare its SHA-256 with `preparation.json`, and
atomically rename it into place. Only then enable and bootstrap the label:

```sh
set -Eeuo pipefail
service_domain="gui/$(id -u)"
service_target="${service_domain}/com.echo.brain.organization-admin-edge.founder-live"
staged_plist="/absolute/private/admin-edge-state/preparations/<attempt>/launch-agent.plist"
incoming_plist="/Users/<service-user>/Library/LaunchAgents/com.echo.brain.organization-admin-edge.founder-live.<attempt>.incoming"
installed_plist="/Users/<service-user>/Library/LaunchAgents/com.echo.brain.organization-admin-edge.founder-live.plist"

abort_admin_edge_activation() {
  trap - ERR INT TERM
  set +e
  cleanup_failed=0
  /bin/launchctl disable "$service_target" || cleanup_failed=1
  /bin/launchctl bootout "$service_target" >/dev/null 2>&1 || :
  /bin/launchctl print "$service_target" >/dev/null 2>&1
  service_status=$?
  if [ "$service_status" -eq 0 ] || [ "$service_status" -ne 113 ]; then
    cleanup_failed=1
  fi
  /absolute/provider-cli disable <policy-id> || cleanup_failed=1
  /absolute/provider-cli verify-disabled <policy-id> || cleanup_failed=1
  return "$cleanup_failed"
}
trap 'abort_admin_edge_activation; exit 1' ERR INT TERM

/bin/launchctl print "$service_domain" >/dev/null
/bin/launchctl disable "$service_target"

set +e
/bin/launchctl print "$service_target" >/dev/null 2>&1
service_status=$?
set -e
if [ "$service_status" -eq 0 ]; then
  /bin/launchctl bootout "$service_target"
elif [ "$service_status" -ne 113 ]; then
  unexpected_service_status="$service_status"
  abort_admin_edge_activation || :
  exit "$unexpected_service_status"
fi

/usr/bin/install -m 600 "$staged_plist" "$incoming_plist"

/usr/bin/plutil -lint "$incoming_plist"
/usr/bin/cmp -s "$staged_plist" "$incoming_plist"

/bin/mv "$incoming_plist" "$installed_plist"
/usr/bin/cmp -s "$staged_plist" "$installed_plist"

/absolute/provider-cli verify-enabled <policy-id>

/bin/launchctl enable "$service_target"

/bin/launchctl bootstrap "$service_domain" "$installed_plist"

/bin/launchctl print "$service_target"
```

The staged plist was already tied to the plan by the activation verifier, and
both `cmp` calls make byte equality fail automatically before load. On this
declared macOS cell, `launchctl print` status `113` is the only accepted
not-loaded result on first deployment; any other status or command failure
stops activation. Execute the exact precommitted `verify_enabled_argv`
immediately before bootstrap. Record the live run's `started_at` immediately
before the explicit `enable`/`bootstrap` checkpoint. That checkpoint is the
first action permitted to open the listener. The abort trap independently
attempts service disable, bootout, VPN disable, and disabled-state
verification even if an earlier cleanup action fails. Keep it armed through
all acceptance and recovery checks; clear it with `trap - ERR INT TERM` only
after the complete passing evidence has been written. Substitute the exact
precommitted `verify_enabled_argv`, `disable_argv`, and
`verify_disabled_argv`; the placeholders above are not deployable commands.

`launchctl print` showing a PID proves only that launchd has a process. It does
not prove listener readiness, authority reachability, matching proxy tokens,
or authenticated browser behavior. Run the live acceptance checks below from
an independently configured administrator device.

Restart:

```sh
launchctl bootout \
  "gui/$(id -u)/com.echo.brain.organization-admin-edge.founder-live"

launchctl bootstrap "gui/$(id -u)" \
  "/Users/<service-user>/Library/LaunchAgents/com.echo.brain.organization-admin-edge.founder-live.plist"
```

Emergency disable and the first-deployment rollback command must persist
across logout, login, and reboot. Disable the stable label before unloading
the current process:

```sh
launchctl disable \
  "gui/$(id -u)/com.echo.brain.organization-admin-edge.founder-live"

launchctl bootout \
  "gui/$(id -u)/com.echo.brain.organization-admin-edge.founder-live"
```

Run the network policy record's tested forwarding-disable procedure as part of
the same emergency action. After disabling, prove both the loopback high-port
listener and private port-443 forwarding are closed, and prove a non-VPN path
never became reachable. Re-run the exact sealed release's preflight with the
current config before restoring the same candidate. Restore requires
re-applying the exact hashed network policy, then an explicit enable followed
by bootstrap:

```sh
launchctl enable \
  "gui/$(id -u)/com.echo.brain.organization-admin-edge.founder-live"

launchctl bootstrap "gui/$(id -u)" \
  "/Users/<service-user>/Library/LaunchAgents/com.echo.brain.organization-admin-edge.founder-live.plist"
```

Never restore a
compromised pin, expired/revoked certificate, unsafe employee origin, or old
proxy token to regain availability.

After startup, use a deliberately authorized test client to verify:

- private-VPN TCP 443 reaches the edge with TLS pass-through;
- the same host and port are rejected outside the VPN, and port 8443 is not
  reachable remotely through either path;
- a valid client certificate and pin can reach `/admin/login`;
- no client certificate, an untrusted chain, or a non-allowlisted SPKI cannot;
- `GET /admin/edge-config` returns only the exact configured employee origin;
- the authority observes exactly one injected proxy credential and one
  canonical client identity;
- a session established by one client identity cannot be replayed by another;
  and
- private, employee, JSON-administrator, unknown, or malformed routes never
  reach the authority.

Complete one bounded real administrator workflow: sign in as the designated
founder test administrator, create one clearly named temporary test membership
and invitation, verify the intended employee authority URL, then revoke that
temporary membership before ending the run. Verify the invitation can no
longer enroll, log out, and retain only secret-free hashes of the workflow
record. The revocation and authority audit record are the cleanup; never use a
real employee identity for this check.

Also prove the certificate-expiry alert path, authority backup/restore
procedure, secret-safe log allowlist, bounded stdout/stderr rotation or size
monitoring, and named incident owner before marking their checks complete.
Exercise the log control against disposable output and retain its secret-free
configuration and result hashes as `log_rotation_ready` evidence. If no
bounded log control is installed, leave that check incomplete and do not run
the edge unattended. The current certificate lifecycle may remain manual as a
declared limitation, but an expiry threshold and responsible person must still
exist for Founder Live.

Do not log request bodies or raw headers while performing these checks.

## Public request contract

The edge allows only these canonical request targets:

| Handling | Method | Path                                                           |
| -------- | ------ | -------------------------------------------------------------- |
| local    | `GET`  | `/admin/edge-config`                                           |
| proxy    | `GET`  | `/admin`                                                       |
| proxy    | `GET`  | `/admin/`                                                      |
| proxy    | `GET`  | `/admin/login`                                                 |
| proxy    | `GET`  | `/admin/assets/admin.css`                                      |
| proxy    | `GET`  | `/admin/assets/admin.js`                                       |
| proxy    | `POST` | `/admin/login`                                                 |
| proxy    | `POST` | `/admin/logout`                                                |
| proxy    | `POST` | `/admin/memberships`                                           |
| proxy    | `POST` | `/admin/memberships/mem_<canonical-v4-uuid>/enrollment-grants` |
| proxy    | `POST` | `/admin/memberships/mem_<canonical-v4-uuid>/revocations`       |
| proxy    | `POST` | `/admin/installations/ins_<canonical-v4-uuid>/revocations`     |

No allowed target carries a query or fragment. The edge rejects every other
method or target before opening an upstream request, including:

- `/v1/enrollments` and `/v1/access-leases`;
- `/v1/admin/*`;
- `/_echo/runtime-status` and every other `/_echo/*` path;
- arbitrary paths merely beginning with `/admin`;
- `TRACE`, `CONNECT`, `OPTIONS`, upgrades, and WebSockets;
- absolute-form or authority-form targets, double-leading slashes, control
  bytes, dot-segment normalization, encoded traversal, queries, fragments, and
  overlong request targets.

`GET /admin/edge-config` is answered by the edge and is never forwarded. Its
exact JSON body is:

```json
{ "authority_base_url": "https://employee-authority.example.com" }
```

It is non-secret, authenticated deployment metadata with `Cache-Control:
no-store`, an exact JSON content type, a canonical `Content-Length`, and
`X-Content-Type-Options: nosniff`. It has no CORS grant. Missing or invalid
metadata causes browser invitation creation to stop; the browser never falls
back to the administrator page origin. The one-time grant stays in browser
memory and only its digest reaches the authority.

## Header and framing contract

The edge inspects raw incoming headers before relying on normalized values:

- Duplicate header names and malformed names or control-bearing values fail
  closed. `Host`, mutation `Origin`, and request framing are then checked
  against their exact edge contracts; authority-owned credentials and cookies
  remain opaque to the edge.
- Caller-supplied `X-Echo-Proxy-*`,
  `X-Echo-Authenticated-Client-*`, runtime-status, `Forwarded`,
  `X-Forwarded-*`, proxy authorization, hop-by-hop, and
  `Connection`-nominated fields are removed.
- `X-Echo-Admin-CSRF` is the only ECHO browser header deliberately preserved.
- The edge sets the configured public `Host`, injects exactly one
  `X-Echo-Proxy-Authorization`, and injects exactly one
  `X-Echo-Authenticated-Client-Id`.
- Raw certificate names, email addresses, source IPs, and caller-provided
  identity headers never become the authority client identity.

Requests have bounded header bytes and count, target length, body bytes,
connection lifetime, and upstream deadlines. Console mutation bodies are
bounded by the authority's 16 KiB maximum. Conflicting or duplicate
`Content-Length`, any `Content-Length` plus `Transfer-Encoding`, malformed
chunking, incomplete bodies, and over-limit input are rejected and the
connection is closed when framing is ambiguous. A forwarded body has one
canonical framing interpretation. The edge never automatically retries a
`POST`, even when the authority command itself has an idempotency key.

Hop-by-hop and `Connection`-nominated response fields are not forwarded.
Incomplete, malformed, upgraded, or over-limit upstream responses fail closed.
All edge-generated errors are bounded, non-cacheable, and contain no upstream,
certificate, identity, configuration, or credential detail.

## Logs and monitoring

Logs use an allowlist rather than redaction after serialization. They may
contain a generated request ID, canonical route template, method, status,
duration, bounded byte counts, TLS version, and the already privacy-preserving
client digest. They must not contain:

- `Authorization`, `Cookie`, `Set-Cookie`, proxy tokens, client private
  material, raw certificate identity, or administrator email;
- request or response bodies, CSRF values, invitation grants, invitation
  envelopes, runtime-status nonces or proofs;
- full URLs, unbounded path identifiers, or query strings; or
- TLS private keys, file contents, environment dumps, or serialized config.

Keep readiness and metrics credential-free and bounded. A public health route
is not part of the allowlist; bind supervisor diagnostics to a private local
control surface if one is later introduced.

## Rotation

Every rotation is a planned, fail-closed restart. Preserve the last verified
artifact, config, and external files until the replacement is proven.

### Administrator client certificate or SPKI

1. Add the replacement CA material if the issuer changes and add the new SPKI
   pin while retaining the old pin.
2. Restart the edge and verify the new client end to end.
3. Remove the old SPKI pin and obsolete CA only after the replacement succeeds.
4. Restart again and prove the old client is rejected.

For urgent revocation, remove the compromised pin, restart, and close existing
connections. Do not rely only on certificate expiry or source-IP filtering.
Changing SPKI changes the injected client identity and naturally invalidates
authority console sessions bound to the prior identity.

### Server certificate or private key

Stage new owner-only files, verify their key match, chain, SAN, validity, and
configured hostname, update only the file references, and restart. Verify the
served certificate and mTLS policy before removing prior files. Never fall back
to an unrelated default certificate or an HTTP listener.

### Client CA

Use a bounded overlap bundle while migrating issuers and retain explicit SPKI
pins throughout. A broader CA bundle never broadens access without a matching
pin. Remove the old CA after every intended client is on the replacement
issuer.

### Trusted proxy token

Rotate the edge-to-authority credential during a maintenance window:

1. Stop the public edge.
2. Stop or otherwise quiesce the authority using its documented lifecycle.
3. Provision the new value into the authority-owned and edge-owned private
   files without printing it.
4. Start and verify the loopback authority.
5. Start the edge and prove authenticated forwarding.

The authority and edge must never run with mismatched values while public
traffic is accepted. If verification fails, stop the edge before restoring the
previous token files.

### Employee authority URL

Changing `employee_authority_base_url` affects only invitations created after
the edge restarts with the new config. Existing invitations retain their prior
URL. Keep the prior employee origin available until outstanding invitations
expire or explicitly replace them; otherwise the change creates an avoidable
onboarding failure.

## Rollback

The edge has no database, so rollback does not restore or alter authority or
employee state:

1. Stop the edge and confirm the public listener is closed.
2. Select a previously installed sealed release and re-verify its retained
   artifact, deployed tree, and out-of-band artifact SHA-256.
3. Run that release's packaged preflight against the **current** config and
   current certificate, CA, allowlist, employee URL, and proxy-token files. A
   failed preflight leaves the service stopped.
4. Create a unique private preparation attempt for that release. Keep the
   stable label disabled and booted out; install the staged plist to a unique
   `.incoming` file beside the stable plist, lint and hash it, then atomically
   rename it over the stable path. The installed digest must equal the
   predeclared recovery plist digest before `enable` and `bootstrap`.
5. Repeat the mTLS, Host, local-config, header
   injection, forbidden-route, and session-isolation checks.
6. Record the restored release ID, artifact SHA-256, and plist SHA-256, then
   retain the failed candidate and logs as private diagnostic evidence.

Never roll back to a compromised client pin, expired/revoked certificate,
untrusted employee origin, or old proxy token merely to restore availability.
Security-policy failure stays fail-closed.

## Evidence boundary

Use
`schemas/organization-admin-edge-founder-live-evidence.v1.schema.json` for the
commit-safe aggregate. Keep raw command output and logs private; the aggregate
contains only their SHA-256 digests and observation times. Validate it with
the dependency-free validator from the same sealed release:

```sh
/absolute/canonical/node-22.22.1 \
  /absolute/sealed/release/runtime/package/tools/organization-admin-edge/validate-founder-live-evidence.mjs \
  --report /absolute/private/admin-edge-state/evidence/founder-live.json \
  --plan /absolute/private/admin-edge-state/evidence/founder-live-plan.json \
  --commitment /absolute/private/admin-edge-state/evidence/plan-commitment.json
```

Install or preflight success alone must remain `DEV/incomplete`. The validator
loads no caller-selected schema and permits `FOUNDER LIVE/pass` only when the
report hashes the supplied predeclared plan, matches its exact artifact,
config, Node, plist, network policy, run count, and recovery identity, and
observes every fixed check between `started_at` and `completed_at`. Those
checks cover artifact and target preflight, loopback authority, listener,
VPN-only port 443 and three negative network paths, supervisor restart,
positive pinned-client access, three negative certificate paths, edge config,
injected proxy identity, a real cleaned-up administrator workflow,
employee-authority readiness, cross-client replay rejection, forbidden-route
rejection, secret-safe logging, bounded log rotation/size monitoring,
certificate-expiry monitoring, authority backup/restore, named incident
ownership, persistent disable, rollback preflight, and service restoration.

The fixed known limitations
`authority_development_file_signer`, `certificate_lifecycle_manual`,
`phase5_physical_gate_open`, and `founder_pilot_only` are recorded separately
from failures. They do not turn a successful controlled founder pilot into
production qualification.

Artifact build/verification, unit tests, local TLS integration, and a local
operator smoke test demonstrate only that the candidate can satisfy locally
provable contracts. They do not establish:

- a publicly reachable production administrator endpoint;
- production certificate issuance, renewal, revocation, monitoring, firewall,
  supervisor, or incident-response behavior;
- a production authority signer;
- two physical `darwin/arm64` installations or Secure Enclave keys;
- independent authority-pin delivery; or
- Phase 5 `P5-NET-001`.

Do not relabel a local report, self-signed certificate test, development
artifact, or loopback proof as production deployment or Phase 5 completion.
