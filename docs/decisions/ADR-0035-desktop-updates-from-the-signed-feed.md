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
reviewed_ref: b70742c8d2e621e2eb3968fc022eadb7e861418e
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
  the root-owned key in the installed package, and keeps its own anti-rollback
  checkpoint. Its bootstrap window is under [Consequences](#consequences).
- **macOS replaces `ECHO.app` without Apple notarization.** This uses the same
  trust model as the Mac CLI updater: the feed's Ed25519 signature and digest,
  not Apple's.

## Decision and consequences

### One release, four artifacts

Every new publication carries exactly four artifacts for one `release_id`: the
`cli-kit` and `electron` installations for `darwin/arm64/native` and
`linux/x64/glibc`. The macOS app is an `ECHO.app` ZIP and the Linux app a
`.deb`
([object keys and content types](../../deploy/client-updates/README.md#sign-and-publish-the-first-release)).

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

Release packaging takes the canonical release record, its exact
`person-client.tgz` and the bootstrap config, all or none. With them it
requires:

- a clean `HEAD` equal to `release.source_sha`;
- the tarball digest equal to `release.person_client.artifact_sha256`, checked
  by the existing release-artifact validation;
- the config with `installation: "electron"` and `automatic: true`;
- the Person client and the workspaces the host bundles, which packaging
  rebuilds from that `HEAD`, with a built identity that names the release's
  commit and version.

The app embeds that exact tarball instead of packing one from `HEAD`, and
carries `echo-desktop-identity.v1.json` outside `app.asar`. The identity names
the release, the Person-client digest, the target and the update bootstrap. A
build without these inputs has no identity file, and its updater is off. Before
publication the feed's `prepare` checks each desktop artifact's identity,
bootstrap and embedded Person client against the release. On Linux it also
reads every member of the `.deb`. What runs as root, or grants root, must equal
the reviewed files at `release.source_sha`: the maintainer scripts, the
AppArmor profile, the root helper and the package's dependencies. Nothing may
install outside the app's own files. This extends
[INV-RELEASE-001](../invariants/INV-RELEASE-001-worktree-bound-artifact.md)
to the desktop. Its embedded identity must match the release claim before
publication. [Client updates](../features/client-updates-v1.md#desktop-app)
describes the file and the checks, and the
[release guide](../../deploy/release/README.md#desktop-release-packages) the
build.

### The client updater runs both kinds of installation

`runClientUpdate` keeps one implementation of configuration pinning, the
signature, channel and expiry checks, the anti-rollback checkpoint and state
file, the lock and the bounded download for both the CLI and the app. It gains
an optional installation adapter. Without one, the CLI behaves exactly as
before. The app's adapter uses `restart` activation: it stages the verified
update and returns the new status `staged`, and the app activates it after
quitting.

### The app's updater

The Electron main process loads the updater from the embedded, release-bound
Person client and keeps per-user state apart from the CLI root. It runs only in
a packaged release build on macOS arm64 from an `ECHO.app` bundle, or on Linux
x64 from `/opt/ECHO` with the root-owned helper and `/usr/bin/pkexec`. On first
run it pins the identity's bootstrap, which a later app cannot change. It only
announces, through
[one sidebar row](../../product/echo-desktop/README.md#updates). The row avoids
the word "Update", which Home uses for open items. Install is refused while the
app holds unresolved work. On macOS a detached helper swaps in the checked
`ECHO.app` after the app quits. On Linux the root helper, started through
`pkexec`, re-verifies the feed and the package before `apt-get` reinstalls it.
[Client updates](../features/client-updates-v1.md#desktop-app) has the
conditions, cadence and activation steps.

### Consequences

- The feed's single Ed25519 key now authorizes root-executed packages on
  enrolled Linux desktops. A leaked key is a fleet-wide root risk, mitigated
  only by the signature, the checkpoint and the explicit password prompt. Key
  rotation remains a separately reviewed bootstrap.
- **Downgrade window.** The app refuses a feed older than the last one it
  verified. The Linux helper refuses one older than the last one it began to
  install. It keeps one floor for the whole machine, and saves it after the
  app exits and before `apt-get` runs, so a failed install still raises it.
  Until a seat has those records, it accepts any unexpired signed feed at or
  above `minimum_sequence`, as a newly enrolled CLI does. On Linux that is a
  machine where the helper has never begun an install, such as one where ECHO
  was only installed by hand. A new user on an updated machine may be offered
  an older release, but the helper refuses it. Installing also needs the admin
  password. On macOS there is no root helper, and the swap does not check the
  sequence. The only floor is the app's own checkpoint in its per-user updater
  folder. So a new user, or an app with no updater state, accepts such a feed
  at its first check, and installing it needs only the person's click. Using
  either window needs a compromised feed origin or a TLS interception, and it
  is limited to publisher-signed releases within their validity.
- **What the feed gate proves.** `prepare` checks the identity, `Info.plist`
  and the embedded Person-client tree. On Linux it also binds everything that
  runs as root or grants root to reviewed source at `release.source_sha`:
  - `postinst` and `postrm`, the only maintainer scripts allowed;
  - the AppArmor profile `postinst` loads, and the root helper;
  - the control file's `Depends` and `Recommends`, with no field that lets apt
    remove or replace other packages.

  No package member may be setuid, setgid, a device, a hard link, or writable
  or owned by anyone but root. Outside `/opt/ECHO` the package may hold only
  the desktop entry, its icons and files directly in
  `/usr/share/doc/echo-desktop/` (fpm's changelog), and no symlink may leave
  `/opt/ECHO`.
- **What it does not prove.** The rest of `/opt/ECHO`, including the Electron
  binaries and `app.asar`, and the rest of the macOS bundle are not checked
  against source. They run as the person, with the same trust as `ECHO.app`,
  so a compromised build machine can still change what the app does for that
  person. The same holds for ZIP local-header tricks, such as local file
  headers that disagree with the central directory.
- **Linux sandbox.** `postinst` never makes Chromium's `chrome-sandbox`
  setuid root, unlike electron-builder's default. The app needs unprivileged
  user namespaces: Ubuntu 24.04 grants them through the package's AppArmor
  profile, and older Ubuntu and Debian allow them. A system that disables them
  cannot start the app.
- **Quit and owner actions.** An owner's in-flight invite or revoke is not part
  of the quit's unresolved-work question. This is true of every quit, not only
  the update's.
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
  signed release, as for the CLI. It can only point at a retained release that
  carries all four targets, each built from that release's source SHA.
  Releases from before the first ADR-0035 release cannot be rollback targets,
  so a recovery that would need one takes a forward fix. On macOS the previous
  bundle is kept only until the new one starts.
- **Local evidence:**
  - updater core, adapter and feed tooling tests with synthetic desktop
    artifacts;
  - the root helper's verification tests;
  - the macOS swap and Linux relauncher scripts tested against stand-in
    bundles, processes and `pkexec`;
  - desktop unit and end-to-end tests with the update state injected.
- **CI:**
  - packages both apps;
  - checks the built `.deb` against the commit with the gate's own check,
    before installing it;
  - reinstalls the Linux package over itself and checks that the AppArmor
    profile and the smoke test survive, and that `chrome-sandbox` is not
    setuid.

  CI cannot show a polkit prompt or a real macOS swap.
- **Live qualification (outstanding):** one A-to-B update on a native macOS
  arm64 seat and one on an Ubuntu 24.04 x64 seat with a polkit agent, each
  followed by `Build <sha7>` in the tray and an authenticated read.
