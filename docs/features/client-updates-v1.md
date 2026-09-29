# Client updates V1

Status: CLI updater and dedicated S3 first-publication tooling implemented.
Hosting, publication, enrollment and live activation have separate operator
evidence; code and offline tests alone do not establish their completion.

An installed Person client can discover an approved release, download its exact
platform kit, and activate it while keeping the existing Person session. A
configured automatic check runs before a Person command starts, at most once
per hour after a completed attempt. It never resubmits an in-flight command.
An idle machine updates when its next command starts.

When this document calls an update "latest", it means the applicable entry in
the client's current valid signed feed for its pinned channel and target. It
does not mean the newest Git commit, a server that has been staged or promoted,
or an unsigned prepared manifest. A product-version string may be reused; the
release identity is the canonical release record's source SHA together with the
exact Person-client artifact digest.

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

The normal installation is the versioned release directory and stable wrapper
under the documented shared CLI root. A custom Person wrapper outside the
managed wrapper path may remain pinned to a versioned binary inside that shared
root. After an update, verify the actual executable used for the required
Person reads, rather than relying on a PATH lookup or a version string from
another wrapper.

The contract supports desktop and container targets, but activation returns
`adapter_unavailable`. Desktop app updates belong to the separate Electron
packaging work; immutable containers use their deployment mechanism. The public command is identical for all implemented adapters:

```sh
echo-brain update --status
echo-brain update --check
echo-brain update
echo-brain update --if-due
echo-brain update --status --json
```

Terminal output uses plain-language messages with the installed release, the
available release when relevant, and the next action. Piped or redirected output
keeps the existing JSON format; add `--json` to request that format explicitly,
including in a terminal. `echo-brain update --help` explains each command.

`--status` reads saved local installation/update metadata without contacting the
feed. Its last result and last-check time describe the saved observation, not a
fresh availability check. `--check` verifies the feed
without installing. The default applies the approved update. `--if-due` performs
the same bounded automatic check used before Person commands. Automatic
diagnostics go to stderr, preserving the requested command's stdout contract.
After successful activation the stable wrapper executes the original command
once, before any Person request has been sent. Download or validation failure
keeps the working installation and records a bounded error code locally.

## Trusted bootstrap

New Linux kits enroll updates during the normal `Start-ECHO.sh` installation.
The release operator supplies the reviewed public configuration while building
the kit; the user runs no additional update command:

```sh
npm run kit:person-onboarding -- \
  --target linux-x64 \
  --update-config /absolute/path/to/bootstrap-config.json \
  --release /absolute/path/to/accepted-release.json \
  --artifact /absolute/path/to/person-client.tgz \
  --runtime-node /absolute/path/to/node-v22.22.1-linux-x64/bin/node \
  --output /absolute/path/to/ECHO-linux-x64.zip
```

The configuration must have `automatic: true` and `installation: "cli-kit"`.
It is embedded in the authenticated canonical kit manifest, so changing it
changes the kit checksum. It contains only a public key and public HTTPS feed
location, never signing material. Reinstall and signed update installation
preserve existing configuration, including a user's `automatic: false` choice,
and preserve the highest verified sequence in updater state.

For an existing Linux installation, deliver one trusted kit built with
`--update-config` and run its `Start-ECHO.sh --install-only`. This one-time bridge
installation preserves the Person session and enrolls updates. The next normal
Person command checks the approved feed without another setup command or login.

Older kits cannot self-bootstrap: their installer bytes contain no trusted
publisher or feed. They remain usable and, if updater-capable, report
`not_configured`. As an alternative recovery path for an updater-capable client,
configure it using a public configuration file delivered through the same
authenticated operator channel:

```sh
echo-brain update configure --file /absolute/path/to/bootstrap-config.json
```

For macOS, build the command-line kit. It is the only macOS kit, and the
builder requires the installation type explicitly:

```sh
npm run kit:person-onboarding -- \
  --target darwin-arm64 --installation cli-kit \
  --release /absolute/path/to/accepted-release.json \
  --artifact /absolute/path/to/person-client.tgz \
  --runtime-node /absolute/path/to/node-v22.22.1-darwin-arm64/bin/node \
  --output /absolute/path/to/ECHO-cli-macos-arm64.zip
```

Extract the ZIP and run `./echo-person-onboarding-kit/Start-ECHO.sh --install-only`.
The Mac CLI installs to
`~/Library/Application Support/ECHO/cli/bin/echo-brain`; add that directory to
PATH or use the absolute command. It has its own release/updater directory
and never modifies `~/Applications` or the retired Swift app's paired command
at `~/Library/Application Support/ECHO/bin/echo-brain`. The retired app kits
are no longer built, and an installation from one cannot be enrolled as an
independent CLI installation. The CLI kit uses manifest schema 3
(`echo-person-cli-kit-v1`) and contains no app archive.

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
For a coordinated server and client release, evaluate that compatibility before
the server is staged because staging changes the live host. The feed publisher
does not make that compatibility decision or publish a staged candidate by
itself.

The configuration and update state live under the installation's `updater/`
directory, separate from Person sessions and upload retry material. A trusted
reconfiguration may toggle `automatic` without resetting the freshness
checkpoint. Changing the publisher, feed, channel, installation type or sequence
floor requires a separately reviewed bootstrap; feed contents cannot change
those settings. The Mac CLI and legacy Linux recovery remain opt-in. Configured Linux kits add no daemon or scheduler; checks run only before Person commands.

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

Supply both supported CLI kits: macOS arm64 and Linux x64/glibc. Preparation,
signing, sealing and publication refuse a release missing either target. Both
kits must bind the same canonical release, source SHA and Person-client artifact;
each client selects its exact OS, architecture, libc and installation type.
Historical single-platform feeds remain readable by clients and auditable through
publication status, but cannot be published again without both platform kits.

Choose a sequence at least the bootstrap minimum and strictly higher than the
previously published sequence; choose a future expiry no more than 31 days
after issuance. `prepare` produces `manifest.json`, the public bootstrap
configuration, the canonical release record and both content-addressed artifacts.
It does not publish anything or read a private signing key. Unsigned `prepare`
needs no final release authorization and may use the candidate canonical record;
the signing preview itself requires the existing final release authorization.

Have the release signer review the exact manifest and sign its **unchanged
UTF-8 bytes**, including the terminal newline, with Ed25519. Supply the detached
64-byte signature to `seal` together with the existing exact release
authorization. The [staging signer and first-publication commands](../../deploy/client-updates/README.md#sign-and-publish-the-first-release)
provide private local key generation, signing preview and a digest-bound signing
operation:

```sh
node tools/client-update-feed.mjs seal \
  --prepared /absolute/path/to/new-feed-bundle \
  --signature /absolute/path/to/manifest.sig \
  --authorization /absolute/path/to/release-authorization.json
```

The authorization must bind the release and Person-client artifact hashes and
record the existing Slack approval, record/Ask checks and final release
decision. Signing the manifest additionally authorizes its exact platform kits
and channel selection. One final human review may also approve the prepared
manifest digest and, for a replacement, the expected predecessor digest, while
the existing authorization and exact digest approval records retain their
current formats. Neither receipt is generated by this tool. Existing candidate
release decisions remain governed by the Authority operator playbook; general
workflow approval and a staged candidate do not authorize publication.

`seal` verifies the signature and revalidates the artifact and authorization,
then writes `feed.json`. Through the approved publication lane, upload immutable
`artifacts/<sha256>.zip` files first and publish the configured feed last. The
server must serve these bytes without redirects or content encoding. Hosting,
signer provisioning, first-seat enrollment and live document-read qualification
are separate deployment steps.

The S3 lane has a separate reviewed replacement operation for a later approved
release or expiry refresh. It requires a human-approved SHA-256 of the current
raw feed, verifies that predecessor's signature with the existing pinned key and
channel, and requires a strictly higher signed sequence. The replacement reuses
the enrolled client's bootstrap configuration, so its feed origin, publisher
key, channel, and installation type remain pinned at the client. Existing
content-addressed artifacts can be reused only when
their authenticated metadata and public bytes match the new signed digest;
otherwise artifact creation remains conditional. The final `feed.json` write is
the sole overwrite and is conditional on the verified predecessor ETag. A
changed predecessor, failed condition, or lost PUT result is unconfirmed and is
resolved only by the replacement receipt's read-only status command. There is
no retry of an attempted write, delete, forced overwrite, signer rollover, or
automatic rollback. The original first-publication receipt remains historical
evidence and must not be used to poll a feed after replacement.

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
