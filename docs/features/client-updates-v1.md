# Client updates V1

Status: implemented for offline qualification; no update feed has been published
and no installed seat has been enrolled by this change.

An installed Person client can discover an approved release, download its exact
platform kit, and activate it while keeping the existing Person session. A
configured automatic check runs before a Person command starts, at most once
per hour after a completed attempt. It never resubmits an in-flight command.
An idle machine updates when its next command starts.

## Platform and installation boundary

The signed manifest selects OS (`linux`, `darwin`, `win32`), architecture
(`x64`, `arm64`), Linux libc (`glibc`, `musl`), and installation type
(`cli-kit`, `electron`, `container`). One release can describe several targets.
An absent target fails explicitly; there is no fallback to another OS or CPU.

V1 implements CLI activation and feed preparation for macOS arm64 (Apple
silicon, macOS 14+) and Linux x64 glibc. Both use
`Start-ECHO.sh --install-only`, an installer lock, private versioned directories
and atomic stable-command replacement. A captured wrapper
hash is rechecked under that lock to avoid overwriting a concurrent manual
installation. Existing releases are retained. The installer validates the new
runtime/client before switching the wrapper.

The contract supports desktop and container targets, but activation returns
`adapter_unavailable`. Desktop app updates belong to the separate Electron
packaging work; immutable containers use their deployment mechanism. The public command is identical for all implemented adapters:

```sh
echo-brain update --status
echo-brain update --check
echo-brain update
echo-brain update --if-due
```

`--status` reads local installation/update metadata. `--check` verifies the feed
without installing. The default applies the approved update. `--if-due` performs
the same bounded automatic check used before Person commands. Automatic
diagnostics go to stderr, preserving the requested command's stdout contract.
After successful activation the stable wrapper executes the original command
once, before any Person request has been sent. Download or validation failure
keeps the working installation and records a bounded error code locally.

## Trusted bootstrap

Existing ZIP-delivered clients need one updater-capable kit installation.
Configure that installed client using a public configuration file delivered
through the same authenticated operator channel:

```sh
echo-brain update configure --file /absolute/path/to/bootstrap-config.json
```

For macOS, build the **CLI-only** kit explicitly:

```sh
npm run kit:person-onboarding -- \
  --target darwin-arm64 --installation cli-kit \
  --release /absolute/path/to/accepted-release.json \
  --artifact /absolute/path/to/person-client.tgz \
  --runtime-node /absolute/path/to/node-v22.22.1-darwin-arm64/bin/node \
  --output /absolute/path/to/ECHO-cli-macos-arm64.zip
```

Extract the ZIP and run `./echo-person-onboarding-kit/Start-ECHO.sh --install-only`.
The standalone Mac CLI installs to
`~/Library/Application Support/ECHO/cli/bin/echo-brain`; add that directory to
PATH or use the absolute command. It has a separate release/updater directory
and never modifies `~/Applications/ECHO.app` or the legacy app's paired command
at `~/Library/Application Support/ECHO/bin/echo-brain`. Existing app kits cannot
be enrolled as independent CLI installations. The CLI-only kit uses manifest
schema 3 (`echo-person-cli-kit-v1`) and contains no app archive.

Linux continues to use `${XDG_DATA_HOME:-~/.local/share}/echo/person/bin/echo-brain`
and its existing schema-2 kit. Both installations keep the current Person session
in its existing location; installing or updating the CLI does not migrate it.
Intel Macs, Linux arm64 and musl are unsupported in this V1.

The exact JSON fields are `schema_version: 1`,
`kind: "echo-client-update-config-v1"`, `channel`, `feed_url`,
`public_key_spki`, `minimum_sequence`, `automatic`, and `installation`.
`public_key_spki` is the base64 DER SPKI of an Ed25519 public key; no private key
is installed. `minimum_sequence` establishes the bootstrap freshness floor.
`feed_url` is a fixed HTTPS URL with no credentials, query or fragment.
Use a separate channel for each Authority's approved compatible client line.
Selecting that line is release-operator work; the updater does not infer server
compatibility from a source SHA or automatically promote staged candidates.

The configuration and update state live under the installation's `updater/`
directory, separate from Person sessions and upload retry material. A trusted
reconfiguration may toggle `automatic` without resetting the freshness
checkpoint. Changing the publisher, feed, channel, installation type or sequence
floor requires a separately reviewed bootstrap; feed contents cannot change
those settings. The updater is opt-in and adds no daemon or scheduler.

## Preparing an approved feed

Build the Person client and each platform kit from a clean release commit using the
existing release workflow. The publisher requires that commit to be present
locally and compares the kit's setup sources with it. It checks the canonical
release record, client/runtime hashes and materialized client identity.

```sh
node tools/client-update-feed.mjs prepare \
  --config /absolute/path/to/bootstrap-config.json \
  --release /absolute/path/to/accepted-release.json \
  --linux-kit /absolute/path/to/approved-linux-kit.zip \
  --macos-kit /absolute/path/to/approved-macos-cli-kit.zip \
  --sequence 1 \
  --expires 2026-10-01T00:00:00.000Z \
  --out /absolute/path/to/new-feed-bundle
```

Supply one or both platform kits. A single feed can serve both operating systems;
each client selects only its exact OS, architecture, libc and installation type.
Both kits must bind the same canonical release and Person-client artifact.

Choose a sequence at least the bootstrap minimum and strictly higher than the
previously published sequence; choose a future expiry no more than 31 days
after issuance. `prepare` produces `manifest.json`, the public bootstrap
configuration, the canonical release record and a content-addressed artifact.
It does not publish anything or read a private signing key.

Have the release signer review the exact manifest and sign its **unchanged
UTF-8 bytes**, including the terminal newline, with Ed25519. Supply the detached
64-byte signature to `seal` together with the existing exact release
authorization:

```sh
node tools/client-update-feed.mjs seal \
  --prepared /absolute/path/to/new-feed-bundle \
  --signature /absolute/path/to/manifest.sig \
  --authorization /absolute/path/to/release-authorization.json
```

The authorization must bind the release and Person-client artifact hashes and
record the existing Slack approval, record/Ask checks and final release
decision. Signing the manifest additionally authorizes its exact platform kits
and channel selection. Neither receipt is generated by this tool. Existing
candidate release decisions remain governed by the Authority operator playbook.

`seal` verifies the signature and revalidates the artifact and authorization,
then writes `feed.json`. Through the approved hosting lane, upload immutable
`artifacts/<sha256>.zip` files first and replace the configured feed last. The
server must serve these bytes without redirects or content encoding. Hosting,
signer provisioning, first-seat enrollment and live document-read qualification
are separate deployment steps; this change supplies their local artifacts and
verification commands.

## Verification and recovery

An envelope contains only base64 `payload` and `signature`. The client verifies
the pinned key before interpreting the payload. Metadata is bounded to 64 KiB;
downloads to 256 MiB, with fixed deadlines. Both URLs must share the configured
HTTPS origin. Artifact size/hash verification precedes archive inspection or
execution. ZIP members are copied as bounded bytes into known regular files;
archive-provided paths and symlinks never control extraction destinations.

Clients persist the highest verified sequence and its payload digest. Older
sequences, changed bytes at the same sequence, expired metadata, and unknown
fields fail closed. A deliberately authorized rollback uses a new sequence
pointing to the retained compatible release. Refresh expiry by publishing a
new signed sequence even when the artifact is unchanged.

This is a single-publisher V1 signature profile, not a complete TUF repository.
Delegated roles, automated key rotation and compromise recovery are outside
this implementation. A publisher trust change uses the authenticated bootstrap
lane. Status reports the exact release ID; product versions need not be used as
an ordering mechanism.

The private `updater/.lock` serializes updates. An interrupted/uncertain installer
retains that lock and staging evidence; inspect whether the installer is still
running, the stable wrapper and retained release before recovery. Do not remove
locks speculatively. Recover to a retained release through the reviewed installer
and recheck its build and authenticated reads. A network or metadata error
alone does not trigger rollback or alter the session.

Acceptance: publish B; a supported seat on A starts its next job, updates without
file copying or a new login, and reads Stout's MRD/PRD. Offline tests cover
platform selection, signature/freshness failures, bounded downloads,
concurrent starts, installation races and session preservation. Offline proof
does not establish that this live acceptance test has occurred.
