# Client updates V1

Status: CLI updater, desktop app updater
([ADR-0035](../decisions/ADR-0035-desktop-updates-from-the-signed-feed.md))
and dedicated S3 first-publication tooling implemented. Hosting, publication,
enrollment and live activation have separate operator evidence; code and
offline tests alone do not establish their completion. Live qualification of
the desktop updater on native seats is outstanding.

An installed Person client checks for an approved release and tells the user
when one is available. With automatic checks enabled, it checks before a Person
command starts, at most once per hour after a completed attempt. A cached
available release can still produce a notice between checks. The requested
command runs once in the same process with the installed client. Automatic
checks never download or activate a platform kit; only an explicit
`echo-brain update` does that, while keeping the existing Person session.

This behavior applies once the client version containing it is installed.
Older clients keep their existing update behavior until upgraded. Publishing
a feed or deploying an Authority does not change their installed code or push
this policy to every seat.

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
root. The client compares the release it runs from with the release the managed
wrapper selects. When they differ on entry, `update`, `--check`, `--status`
and `--if-due` return `running_release_mismatch` (exit 1) with `running_release` and
`installed_release`, without contacting the feed, writing update state or
installing; automatic checks before Person commands print the same mismatch on
stderr and continue. An `update` that starts on A and installs B is the normal
transition and reports `updated`. Recovery keeps the launcher's own sign-in and
session environment and makes it run the managed wrapper with the same
arguments. ECHO never rewrites custom launchers or removes retained releases.
Clients built before this check still report the managed installation as their
own, and a new release cannot change them. After an update, verify the actual
executable used for the required Person reads, rather than relying on a PATH
lookup or a version string from another wrapper.

The Electron desktop app installs the `electron` target on the same two
platforms through its own installation adapter; see [Desktop app](#desktop-app).
It does not run this CLI's pre-command check hook. Each installation updates
only itself: `echo-brain update` installs the CLI kit and the app installs the
app, both from the same signed release. Container targets return
`adapter_unavailable`; immutable containers use their deployment mechanism.
The CLI's public command is the same on both platforms:

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
fresh availability check. `--check` verifies the feed without installing.
`echo-brain update` downloads and applies the approved update. `--if-due`
performs the same bounded, check-only operation used before Person commands;
an available release does not bypass the hourly interval. Automatic notices
and diagnostics go to stderr, preserving the requested command's stdout
contract, and tell the user to run `echo-brain update` to install an available
release. The command continues with the installed client without re-execution.
Download or validation failure keeps the working installation and records a
bounded error code locally.

## Trusted bootstrap

New Linux kits enroll update checks during the normal `Start-ECHO.sh`
installation. The release operator supplies the reviewed public configuration
while building the kit; the user runs no additional update command:

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
`automatic` enables checks and availability notices, never installation.
The configuration is embedded in the authenticated canonical kit manifest,
so changing it changes the kit checksum. It contains only a public key and
public HTTPS feed location, never signing material. Reinstall and signed update
installation preserve existing configuration, including a user's
`automatic: false` choice to disable automatic checks and notices, and preserve the highest verified
sequence in updater state. Explicit `--check` and `update` remain available
when automatic checks are disabled.

For an existing Linux installation, deliver one trusted kit built with
`--update-config` and run its `Start-ECHO.sh --install-only`. This one-time bridge
installation preserves the Person session and enrolls update checks. The next
normal Person command checks the approved feed without another setup command
or login.

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
those settings. The Mac CLI and legacy Linux recovery remain opt-in.
Configured Linux kits add no daemon or scheduler; automatic checks run only
before Person commands. The existing configuration schema and freshness
checkpoint need no migration for check-only automatic behavior.

## Desktop app

The desktop app on macOS arm64 and Linux x64 updates from the same signed feed
([ADR-0035](../decisions/ADR-0035-desktop-updates-from-the-signed-feed.md)).
Only a release package has an updater. Release packaging takes `--release`,
`--artifact` and `--update-config`, embeds the release's exact Person-client
tarball and writes `echo-desktop-identity.v1.json` beside the app
(`ECHO.app/Contents/Resources` or `/opt/ECHO/resources`). Its update config is
the CLI bootstrap with `installation: "electron"` and `automatic: true`.
Development, CI and ad hoc builds and the Linux `.tar.gz` never update.

On first run the app pins the bootstrap embedded in its identity. A later app
with a different publisher, feed, channel or sequence floor cannot change that
pin; updates then stop with `already_configured`. Updater state lives in
`~/Library/Application Support/ECHO/desktop/updater` on macOS and
`~/.config/ECHO/desktop/updater` on Linux, apart from the CLI root.

The app applies the CLI's rules: configuration pinning, signature, channel and
expiry checks, the anti-rollback checkpoint, the lock and the bounded download
(256 MiB, 15 minutes). It asks every ten minutes, but contacts the feed at most
once an hour after its last completed check, across relaunches. Relaunching
does not force a check. It only announces, and a failed check shows nothing.
One sidebar row shows **New version · Restart** when a release is available or
newer files are already installed (`running_release_mismatch`). Selecting it
stages the verified update (status `staged`), and the app activates it after it
quits. **Restart** arms the relaunch only when the quit is certain.

- **macOS** checks the staged `ECHO.app` (bundle id, `codesign --verify --deep
  --strict`, and an identity matching the manifest) and swaps it into place. The
  running bundle must be writable and not translocated; ECHO normally lives in
  `~/Applications`. An app that is translocated or cannot write its folder
  still checks, and on finding a release shows **Move ECHO to Applications to
  update** right away. A failed swap restores the previous app.
- **Linux** asks for an admin password through `pkexec`. The root helper
  `/opt/ECHO/resources/echo-desktop-update-helper` verifies the feed again with
  the key in the root-owned installed identity, checks the package digest and
  its own checkpoint `/var/lib/echo-desktop/update-checkpoint.json`, and then
  reinstalls the package with `apt-get`. Each install attempt has its own id,
  so an earlier attempt's result is never read as this one's. A cancelled
  prompt leaves the app running; a later failure reopens the old app.
  Without `/usr/bin/pkexec` the updater stays off, and the manual reinstall
  remains.

The trust model is the feed's Ed25519 signature and digest, not Apple
notarization. A self-replaced app is not quarantined, so Gatekeeper does not
re-check it, and macOS privacy grants may need to be given again after an
update. macOS App Management may block the swap; that is unverified until a
seat rehearsal, and a blocked swap keeps the old app. On Linux the feed key now
authorizes root-executed packages on enrolled desktops. The helper refuses a
feed older than the last one it installed, and the app refuses one older than
the last one it verified. A Linux seat installed by hand, or a new user,
accepts any unexpired signed feed at or above `minimum_sequence` until its
first helper install, the same bootstrap window the CLI has. macOS has no
helper, and the swap does not check the sequence. A new Mac user, or an app
with no updater state, accepts such a feed at its first check, and installing
it needs only the person's click, with no admin password. The app refuses
older feeds after that first verified check. Desktop installs from before
this change have no updater and need one manual reinstall of a release
package.

## Preparing an approved feed

Build the Person client, each platform kit and each desktop package from a
clean release commit using the existing release workflow. The publisher
requires that commit to be present locally and compares the kit's setup sources
with it. It checks the canonical release record, client/runtime hashes and
materialized client identity.

```sh
node tools/client-update-feed.mjs prepare \
  --config /absolute/path/to/bootstrap-config.json \
  --release /absolute/path/to/accepted-release.json \
  --linux-kit /absolute/path/to/approved-linux-kit.zip \
  --macos-kit /absolute/path/to/approved-macos-cli-kit.zip \
  --macos-app /absolute/path/to/ECHO-mac.zip \
  --linux-deb /absolute/path/to/echo-desktop.deb \
  --sequence 1 \
  --expires 2026-10-01T00:00:00.000Z \
  --out /absolute/path/to/new-feed-bundle
```

Supply all four artifacts: the macOS arm64 and Linux x64/glibc CLI kits, the
macOS arm64 `ECHO.app` ZIP and the Linux x64 `.deb`. `prepare` refuses a
missing option (`missing_argument`). Signing, sealing and publication refuse a
new release missing any of the four (`all_release_targets_required`). All four
must bind the same canonical release, source SHA and Person-client artifact;
each client selects its exact OS, architecture, libc and installation type. For
each desktop artifact, `prepare` also checks that:

- its identity file names this release, its record digest, source SHA, product
  version, Person-client digest and target;
- its `update_bootstrap` equals `--config` except for `installation: "electron"`;
- the Person-client tree inside the app equals, file for file, the release
  tarball the CLI kits carry;
- on macOS, every ZIP entry is under `ECHO.app/` and `CFBundleIdentifier` is
  `org.echobrain.echo-desktop`;
- on Linux, the package is `echo-desktop` for `amd64`, and the root helper's
  bytes equal the helper at `release.source_sha`.

These checks do not cover `app.asar` or the rest of the bundle, so a
compromised build machine is outside what they prove; see the feed guide's
[known limitations](../../deploy/client-updates/README.md#known-limitations).

Historical single-platform and two-artifact feeds remain readable by clients
and auditable through publication status, but cannot be published again.

Choose a sequence at least the bootstrap minimum and strictly higher than the
previously published sequence; choose a future expiry no more than 31 days
after issuance. `prepare` produces `manifest.json`, the public bootstrap
configuration, the canonical release record and all four content-addressed
artifacts.
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
decision. Signing the manifest additionally authorizes its exact artifacts
and channel selection. One final human review may also approve the prepared
manifest digest and, for a replacement, the expected predecessor digest, while
the existing authorization and exact digest approval records retain their
current formats. Neither receipt is generated by this tool. Existing candidate
release decisions remain governed by the Authority operator playbook; general
workflow approval and a staged candidate do not authorize publication.

`seal` verifies the signature and revalidates the artifact and authorization,
then writes `feed.json`. Through the approved publication lane, upload immutable
`artifacts/<sha256>.zip` and `artifacts/<sha256>.deb` files first and publish
the configured feed last. The
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
execution. CLI kit ZIP members are copied as bounded bytes into known regular
files; archive-provided paths and symlinks never control extraction
destinations. The desktop app expands its `ECHO.app` ZIP with `ditto` inside
its private updater folder and checks the staged bundle before the swap. The
Linux root helper copies the package and feed into a root-only folder before
checking them.

Clients persist the highest verified sequence and its payload digest. Older
sequences, changed bytes at the same sequence, expired metadata, and unknown
fields fail closed. A deliberately authorized rollback uses a new sequence
pointing to the retained compatible release. That release must carry all four
targets, each built from its own source SHA. A release from before the first
ADR-0035 release cannot be a rollback target; recovery that would need one
takes a forward fix. The desktop has no rollback button either; on macOS the
previous bundle is kept only until the new one starts. Refresh expiry by
publishing a new signed sequence even when the artifact is unchanged.

This is a single-publisher V1 signature profile, not a complete TUF repository.
Delegated roles, automated key rotation and compromise recovery are outside
this implementation. A publisher trust change uses the authenticated bootstrap
lane. Status reports the exact release ID; product versions need not be used as
an ordering mechanism.

The private `updater/.lock` serializes updates. An interrupt (SIGINT, SIGTERM or
SIGHUP) before the installer starts releases the lock and any partial download
and leaves the installed release unchanged. An interrupted/uncertain installer
retains that lock and staging evidence; inspect whether the installer is still
running, the stable wrapper and retained release before recovery. Do not remove
locks speculatively. Recover to a retained release through the reviewed installer
and recheck its build and authenticated reads. A network or metadata error
alone does not trigger rollback or alter the session.

Acceptance: publish B; a supported seat on A reports B during a normal Person
command while its wrapper and command build identity remain A. Then an explicit
`echo-brain update` installs B without file copying or a new login, and the seat
reads Stout's MRD/PRD. A must already implement check-only automatic behavior
to prove that policy; an older client's existing behavior is separate rollout
evidence. Offline tests cover checks without artifact downloads or activation,
cached notices, explicit installation, platform selection, signature/freshness
failures, bounded downloads, concurrent starts, installation races and session
preservation. Offline proof does not establish that this live acceptance test
has occurred.

Desktop acceptance: publish B; an updater-capable app on A shows **New version
· Restart**. Selecting it installs B and restarts the app, with an admin
password on Linux. The tray then shows `Build <sha7>` for B's source SHA, and an
authenticated read passes. This needs one native macOS arm64 seat and one
Ubuntu 24.04 x64 seat with a polkit agent. CI cannot show a polkit prompt or a
real macOS swap.
