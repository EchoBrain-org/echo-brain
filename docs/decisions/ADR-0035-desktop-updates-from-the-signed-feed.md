---
schema_version: 1
id: ADR-0035
kind: decision
title: The desktop app updates itself from the signed client feed
component_ids:
  - CMP-PERSON-CLIENT
  - CMP-OPERATIONS-RELEASE
created_at: 2026-10-13
reviewed_at: 2026-10-13
reviewed_ref: f0f6cc77e950b47239174f0d717d3535e28a4efd
status: accepted
supersedes: []
superseded_by: []
updates:
  - ADR-0024
---

# ADR-0035: The desktop app updates itself from the signed client feed

Accepted by the founder on 2026-10-13, including the two calls below on Linux
password installation and macOS self-replacement without notarization.
Acceptance does not mean the change is implemented or qualified. Live
qualification on native seats is recorded separately.

## Context and options

The signed client feed ([client updates](../features/client-updates-v1.md))
updates the Person command line on macOS arm64 and Linux x64. The Electron
desktop app carries its own copy of the Person client and has no updater.
Every release therefore needs a manual reinstall on each desktop seat:
`ECHO.app` from a ZIP on macOS, and `apt install --reinstall` of a `.deb` on
Linux. The Linux reinstall also has to work around a package version that stays
at `0.1.0`. [ADR-0024](ADR-0024-person-list-open-and-mine-scope.md) records
that desktops "do not update themselves". The founder wants the desktop to
update like `echo-brain update`: the app announces a release, and one explicit
action installs it and restarts.

Options considered:

1. **Electron's built-in updater or electron-updater.** On macOS these need a
   Developer ID signed app. ECHO ships ad-hoc signed builds, so this needs Apple
   enrolment first. It also adds a second update channel, with its own trust
   root, beside the signed feed.
2. **Notify only.** The removed 2026-09-24 desktop plan chose this for Linux
   until a signed apt repository exists, because one leaked key could otherwise
   run packages as root on every Linux seat.
3. **Extend the signed feed with desktop artifacts.** The app installs them
   with its own adapter. On Linux, a root helper shipped in the package
   re-verifies the signed feed before installing. This is chosen.

The founder made two calls:

- **Linux installs with an admin password prompt.** This overrides the earlier
  notify-only choice. The root helper re-verifies the publisher signature with
  the root-owned key in the installed package and blocks downgrades. That gives
  the protection a signed apt repository would.
- **macOS replaces `ECHO.app` without Apple notarization.** This uses the same
  trust model as the Mac CLI updater: the feed's Ed25519 signature and digest,
  not Apple's.

## Decision and consequences

### One release, four artifacts

Every new publication carries exactly four artifacts for one `release_id`:

| Target (`platform/architecture/libc/installation`) | File | Object key | Content type |
| --- | --- | --- | --- |
| `linux/x64/glibc/cli-kit` | CLI kit ZIP | `artifacts/<sha256>.zip` | `application/zip` |
| `darwin/arm64/native/cli-kit` | CLI kit ZIP | `artifacts/<sha256>.zip` | `application/zip` |
| `darwin/arm64/native/electron` | `ECHO.app` ZIP | `artifacts/<sha256>.zip` | `application/zip` |
| `linux/x64/glibc/electron` | `.deb` | `artifacts/<sha256>.deb` | `application/vnd.debian.binary-package` |

The manifest schema does not change. Enrolled CLIs already accept `electron`
entries and select their own target, so existing seats keep working with a
four-artifact feed. Sealing, signing and publication refuse any new release
that lacks one of the four. Read-only status verification still accepts
historical two-artifact feeds. A CLI-only release can no longer be published,
and each release needs a macOS arm64 machine and a Linux x64 machine to build
the desktop packages.

Each install still updates only itself. `echo-brain update` installs the CLI
kit, and the app installs the app. Both are offered the same signed release.

### Desktop release identity

Release packaging (`product/echo-desktop/scripts/package.mjs`) takes three
inputs, all or none:

- `--release <canonical release.json>`
- `--artifact <the release's exact person-client.tgz>`
- `--update-config <bootstrap config>`

With them, packaging requires:

- a clean `HEAD` equal to `release.source_sha`;
- the tarball digest equal to `release.person_client.artifact_sha256`, checked
  by the existing release-artifact validation;
- the config to parse with `installation: "electron"` and `automatic: true`.

The app embeds that exact tarball instead of packing one from `HEAD`. It then
writes `echo-desktop-identity.v1.json` as an Electron extra resource, outside
`app.asar`: `ECHO.app/Contents/Resources/` on macOS and `/opt/ECHO/resources/`
on Linux. The file is canonical JSON:

```json
{
  "schema_version": 1,
  "kind": "echo-desktop-identity-v1",
  "release_id": "clean-v1-…",
  "release_record_sha256": "<sha256 of release.json>",
  "source_sha": "<40 hex>",
  "product_version": "<release.person_client.version>",
  "person_client_artifact_sha256": "<sha256>",
  "platform": "darwin | linux",
  "architecture": "arm64 | x64",
  "libc": "null | glibc",
  "installation": "electron",
  "update_bootstrap": { "...": "client update config, installation electron" }
}
```

A build without these inputs (development, CI, an ad hoc package) has no
identity file, and its updater is off. The Linux package also ships the root
helper `/opt/ECHO/resources/echo-desktop-update-helper` and declares
`python3` and `openssl` as dependencies. `pkexec` is only recommended: without
it, an install fails safely and the documented manual reinstall remains.

`tools/client-update-feed.mjs prepare` takes `--macos-app` and `--linux-deb`
beside the two kits. For each desktop artifact it checks the following:

- **Identity:** the identity file names this release, its record digest,
  source SHA, product version, Person-client digest and target.
- **Bootstrap:** `update_bootstrap` equals the feed's bootstrap config except
  for `installation: "electron"`.
- **Embedded client:** the Person-client tree inside the app equals, file for
  file, the release tarball the CLI kits carry.
- **macOS:** every ZIP entry is under `ECHO.app/`, and `CFBundleIdentifier` is
  `org.echobrain.echo-desktop`.
- **Linux:** the package is `echo-desktop` for `amd64`, and the root helper's
  bytes equal the helper at `release.source_sha`.

This extends [INV-RELEASE-001](../invariants/INV-RELEASE-001-worktree-bound-artifact.md)
to the desktop. Its embedded identity must match the release claim before
publication.

### The client updater runs both kinds of installation

`runClientUpdate` keeps one implementation of these rules for both the CLI and
the app:

- configuration pinning;
- signature, channel and expiry checks;
- the anti-rollback checkpoint and the state file;
- the lock and the bounded download.

It gains an optional installation adapter. Without one, the CLI behaves
exactly as before. The adapter supplies:

- `installedRelease()` and `installedReleaseSha256()`, for the CLI's
  wrapper-and-release-folder reads;
- `fingerprint()`, the race guard captured before download (the CLI wrapper
  digest);
- `install(input)`, whose input gains the verified feed bytes;
- `activation`: `immediate` for the CLI, or `restart` for the app.

  A `restart` install stages the update and returns the new status `staged`.
  The app activates it after quitting, so no immediate activation check runs.

- the staged archive's file name and download timeout. The desktop allows 15
  minutes and keeps the 256 MiB cap.

Callers can turn off the CLI's signal re-raise, which would otherwise end the
Electron process without its normal quit. `configureClientUpdates` accepts the
adapter too, so the app can pin its embedded bootstrap.

### The app's updater

The Electron main process loads the updater from the embedded, release-bound
Person client (`person-client/package/dist/client-update.js`), the same way the
host loads the client. Per-user state lives in
`<appData>/ECHO/desktop/updater/`:

- macOS: `~/Library/Application Support/ECHO/desktop`
- Linux: `~/.config/ECHO/desktop`

It is created `0700`, next to Chromium's `ECHO/chromium` and apart from the CLI
root.

The updater is on only when all of these hold:

- the build is packaged;
- the app is not running `--smoke`;
- the identity file is valid;
- the installation is supported. That means macOS arm64 with a resolvable,
  non-translocated `ECHO.app`, or Linux x64 running from `/opt/ECHO` with the
  root-owned helper present.

The `.tar.gz` Linux package, development builds and test builds never update.

**First run.** The app pins the identity's `update_bootstrap` as its config. A
later app that carries a different publisher, feed, channel or sequence floor
cannot change that pin. Updates then stop with `already_configured`, as on the
CLI.

**Checks.** The app checks at launch and then every hour, through the existing
`automatic` mode, its interval and `automatic: false`. It only announces. The
running release is the identity read at launch. If the files on disk now name
another release, for example because another Linux user updated `/opt/ECHO`,
the existing `running_release_mismatch` status means "restart to use it".

**What the person sees.** One sidebar row above the account row, and nothing
else:

| State | Row |
| --- | --- |
| A release is available, or newer files are already installed | **New version · Restart** |
| Downloading, verifying, waiting for the password | **Updating** with the busy dots |
| The install failed | **Couldn't update · Try again** |
| macOS app outside a writable folder | **Move ECHO to Applications to update** |

The row avoids the word "Update", which Home uses for open items. Install is
refused while the app holds unresolved work (the same check as sign out). After
staging, the quit runs the normal host drain.

**macOS activation.**

1. After the feed and digest checks, the app expands the ZIP with
   `/usr/bin/ditto -x -k` into the updater folder.
2. It requires the staged bundle to:
   - be the only top-level `ECHO.app`;
   - have the bundle id `org.echobrain.echo-desktop`;
   - pass `codesign --verify --deep --strict`;
   - carry an identity whose release and record digest equal the manifest's.
3. The staging folder must be on the same volume as the running bundle, which
   must be writable and not translocated.
4. The app writes a bash swap helper into the updater folder, starts it
   detached, and quits.
5. The helper waits for the app's process to exit, at most two minutes. It
   renames the bundle to `updater/previous/ECHO.app`, renames the staged bundle
   into place and opens it.
6. If the swap fails, it restores the previous bundle and reopens it.
7. Either way, it writes `updater/outcome.json`.
8. On launch, the app reads and removes the outcome. It deletes the previous
   bundle only when its own release is the expected one; otherwise it shows the
   failure row.

**Linux activation.**

1. After the checks, the app stages the verified `.deb` and the exact feed
   bytes in the updater folder.
2. It writes a bash relauncher there and starts it detached. The relauncher
   runs `pkexec /opt/ECHO/resources/echo-desktop-update-helper install --feed
   F --deb D --wait-pid <app pid>`, with the helper's output going to a
   progress file.
3. The helper runs as root:
   1. It copies both files with `O_NOFOLLOW` into a root-owned `0700` folder
      under `/var/lib/echo-desktop/`.
   2. It reads the trust config from the root-owned installed identity file.
   3. It verifies the Ed25519 signature with `openssl pkeyutl -verify -rawin`.
   4. It checks the manifest's kind, channel, freshness, sequence floor and
      origin.
   5. It checks the `linux/x64/glibc/electron` artifact's size and digest
      against the copied package.
   6. It checks the package control fields.
   7. It checks the root checkpoint `/var/lib/echo-desktop/update-checkpoint.json`.
      The sequence must be greater than the saved one, or equal to it with the
      same manifest digest.
   8. It prints `verified`.
4. Once the progress file says `verified`, the app quits.
5. The helper waits up to two minutes for the app to exit. It then runs
   `apt-get install --reinstall -y` on the copy, saves the checkpoint and
   removes the copy.
6. The relauncher records the outcome and reopens `/usr/bin/echo-desktop`:
   - cancelled prompt (exit 126) or refused authentication (127): the app is
     still open, so the row goes back to available or failed;
   - any later failure: the relauncher reopens the old app.

The helper's exit codes are: 0 installed, 2 invalid input, 3 verification
failed, 4 the app did not exit, 5 installation failed.

### Consequences

- The feed's single Ed25519 key now authorizes root-executed packages on
  enrolled Linux desktops. A leaked key is a fleet-wide root risk, mitigated
  only by the signature, the checkpoint and the explicit password prompt. Key
  rotation remains a separately reviewed bootstrap.
- **macOS risk.** A self-replaced, ad-hoc signed app is not quarantined, so
  Gatekeeper does not re-check it. macOS App Management may block the swap,
  which is unverified until a seat rehearsal. A blocked swap keeps the old app.
  The ad-hoc code identity changes with each build, so macOS privacy grants may
  have to be given again after an update.
- Publication carries about 128 MB plus about 100 MB more per release.
  Publisher timeouts and validity windows scale with object count and size.

## Migration, rollback, and evidence

- **Enrolment.** Desktop installs from before this change have no identity and
  no updater. Each needs one manual reinstall of an updater-capable build, the
  same bridge the Linux CLI kits needed.
- **Old CLI seats.** Older CLIs keep their own behavior. Four-artifact feeds
  remain valid for them.
- **Rollback.** There is no rollback button. A deliberate rollback is a newer
  signed release, as for the CLI. On macOS the previous bundle is kept only
  until the new one starts.
- **Local evidence:**
  - updater core, adapter and feed tooling tests with synthetic desktop
    artifacts;
  - the root helper's verification tests;
  - the macOS swap and Linux relauncher scripts tested against stand-in
    bundles, processes and `pkexec`;
  - desktop unit and end-to-end tests with the update state injected.
- **CI:**
  - packages both apps;
  - reinstalls the Linux package over itself and checks that the AppArmor
    profile and the smoke test survive.

  CI cannot show a polkit prompt or a real macOS swap.
- **Live qualification (outstanding):** one A-to-B update on a native macOS
  arm64 seat and one on an Ubuntu 24.04 x64 seat with a polkit agent, each
  followed by `Build <sha7>` in the tray and an authenticated read.
