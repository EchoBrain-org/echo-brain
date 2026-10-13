# ECHO desktop

The app shares its TypeScript client, host, renderer and Electron main process
across macOS and Linux. Packages currently target macOS arm64 and Linux x64.
Windows packaging is not implemented.

Global Ask includes live Jira reads through the person's connected account and
shows ticket citations that open directly in Jira. Project Ask includes Jira only through a saved project mapping. Mine excludes Jira.

Home shows only what waits on you, under **Needs you**. Each row is one of:

- **Approve**: a meeting waiting for your decision. It opens the decision,
  where you choose its audience, owners and transcript sharing.
- **Checking**: a meeting you approved, while its record publishes and its
  impact check runs. It has no action and is not counted.
- **Check failed** (verb **Retry**): "Approved · the check did not finish". It
  opens the decision with the reason and **Try again**.
- **Send**: your impact check found items the decision changes.
  **Tell the owners?** sends each to its owner (or **Pick a person**).
- **Update**: an item that waits on you as its owner: sent to you, or left to
  you because the people ahead of you have left. Each item row has three
  lines: "ECHO-12 · Pilot launch doesn't match the decision yet", what it says
  now and what the decision needs ("Due Oct 30 → decision needs: launch next
  week"), and, muted, what it is and where it came from ("Jira ticket · Pilot
  planning meeting, approved Oct 6"). **Open in Jira** (or the item's tool)
  when you can open it, and **Mark updated** when you may close it, act on the
  row itself.
- **Update**, once ECHO's last check saw the item change and it still doesn't
  match ("· changed since you got it, still doesn't match"), and **Review**
  for an item someone else owns that changed since you sent it ("Mina's to
  update · changed since you sent it"): the row opens the item's card first:
  whose it is to update, the decision, what the item says **Now** beside what
  **The decision needs**, what ECHO saw when it last checked, then **Mark
  updated** and **No change needed** when you may close it. Nothing on the row
  itself closes the item.

Under the rows, and on an empty Home, a footer says how many of your items
match their decision now, how many items you sent wait on others, and when
ECHO last checked ("1 matches its decision now · 2 waiting on others · ECHO
checked 2 h ago"). **View** opens **Your open items**: a status view of your
open items, each with what the decision needs, its status (Matches now, Not
updated yet, Changed, still doesn't match, ECHO couldn't read it, Not checked
yet) and its owner. A match you may close has **Close**, and **Close all N
that match** appears when two or more can be closed.

An approved decision shows its Impact line ("Impact · 1 open · 1 handled ·
1 couldn't read · checked just now"), and a project the items still open
across its decisions ("4 open items · from 2 decisions · checked today",
counted from the project's whole summary). An item that matched its decision,
or that ECHO couldn't read, is not counted as open; the project line stays
while any item is unsent or open. Both lines offer **Check now** when they
have items: it re-checks that decision's or project's open items, shows
"Checking…" until the check ends, then opens their open items as **Open
items** ("Nothing open to check" when none is left; "Check failed · Try
again" when it fails). Home also re-checks your own open items by itself:
when the Authority says they are due, Home asks for a sweep and starts it
after any waiting impact check. A sweep makes no Home row and changes no
item's state; it only records each item's latest verdict. Items on a Slack
message are not re-checked: ECHO cannot read a Slack message yet, so they
stay "not checked yet". Reassigning an item after Send is not on the desktop
yet (the CLI's `assign` does it). Projects and archived projects live in the
sidebar.

Tools → Granola manages folder watching and individual meeting imports. Home and
decision content is covered while another app is in front, and unfinished checks
refresh when ECHO returns.

## Develop

Use the repository's pinned Node and npm versions. The app loads the Person
client built in this checkout, so build it at the root first. From the
repository root:

```sh
npm ci
node tools/build.mjs --person-client
cd product/echo-desktop
npm ci
npm start
```

`npm start` builds the app and runs it against the test fixture Authority in a
throwaway home and app-data directory, deleted on exit; it never reads or
writes your real ECHO session. `npm start -- <mode>` selects one of the
fixture's test modes in `src/host/test-authority.ts`.

`npm run typecheck` checks the app's TypeScript. `npm test` builds the app,
then runs the unit tests (`test/unit`, Vitest) and the Electron end-to-end
tests (`test/e2e`, Playwright). The root `npm run check` runs none of these.

## Build

Use the repository's pinned Node and npm versions. From the repository root:

```sh
npm ci
cd product/echo-desktop
npm ci
npm run package:linux
```

The Linux build host needs `binutils` (the `ar` command), `tar` and `xz-utils`;
install these through the system package manager before packaging. Running the
app or its tests also requires a graphical session and Electron's system libraries.

Packaging requires a clean committed checkout. It builds and embeds the same
provenance-bound Person-client tarball as macOS and compiles out test fixtures.
It never publishes a release. `npm run package` defaults to the build machine's
OS; `npm run package -- --mac` explicitly selects macOS arm64.

A release package also takes `--release`, `--artifact` and `--update-config`,
all as absolute paths: the canonical release record, its exact
`person-client.tgz` and the feed's bootstrap config with
`installation: "electron"`. It embeds that tarball and writes
`echo-desktop-identity.v1.json` beside the app, which is what turns the updater
on. Build it from the release commit after `npm run build` at the repository
root; see the
[release guide](../../deploy/release/README.md#desktop-release-packages). A
package built without these inputs never updates.

Linux outputs are in `dist-app/`:

- `ECHO-<version>-linux-amd64.deb`: Debian/Ubuntu installer with the Electron
  runtime, dependencies, desktop launcher, sandbox integration and the update
  helper. It depends on `python3` and `openssl` and recommends `pkexec`;
  without `/usr/bin/pkexec` the updater stays off.
- `ECHO-<version>-linux-x64.tar.gz`: the app directory for manual distribution;
  the receiving system must supply Electron's system libraries and permit its
  sandbox. It never updates itself. Prefer the deb on Ubuntu, where the
  installer supplies an AppArmor profile.
- `linux-unpacked/echo-desktop`: the executable used by the package smoke test.

The macOS output is a ZIP of `ECHO.app` in `dist-app/`.

Build Linux packages on Linux for a reproducible native test environment.
Building an archive on macOS does not validate Linux execution.

## Install and verify on Linux

On an x64 Debian/Ubuntu desktop, install the deb with the system package manager:

```sh
sudo apt install ./ECHO-0.1.0-linux-amd64.deb
echo-desktop
```

The package version stays `0.1.0` across releases, so every release's deb has
the same file name and version. When a seat already has ECHO installed, apt can
report "already the newest version" and leave the old app, including its
embedded Person client, in place. Once installed, a release package updates
itself (see [Updates](#updates)). When you install by hand over an existing
ECHO, the first time or after a failed update, use `--reinstall`:

```sh
sudo apt install --reinstall ./ECHO-0.1.0-linux-amd64.deb
```

Then prove the installed build rather than its version string: run
`npm run smoke -- /opt/ECHO/echo-desktop` (described below) from the release's
clean build checkout, or check that the tray menu's `Build <sha7>` matches the
release's source SHA.

The application appears as **ECHO** in the desktop launcher. The executable is
`echo-desktop`, so it does not replace the system's `echo` command. The installed
desktop filename matches `desktopName` in `package.json`, which provides the
identity used by Wayland's shortcut portal.

From a build checkout on Linux, `npm run smoke` verifies the packaged executable's
release fuses, isolated startup, client identity, clean source commit, and refusal
of remote debugging. `npm run smoke -- /opt/ECHO/echo-desktop` checks the installed
deb. These checks use temporary app state and never sign in to an Authority.
For a headless Linux runner, prefix the smoke command with
`xvfb-run -a dbus-run-session --`.

## Install on macOS

Unzip the release's ZIP and move `ECHO.app` to `~/Applications`, the
Applications folder inside your home folder; create it if it is missing. That
folder is yours to write, so ECHO can replace itself there when it updates.
In a folder it cannot write, or when macOS runs it from a read-only copy
(translocation), ECHO still checks. When it finds a release it shows **Move
ECHO to Applications to update** right away, instead of updating. Check that
the tray menu's `Build <sha7>` matches the release's source SHA.

## Updates

A release package updates itself from the signed client feed
([ADR-0035](../../docs/decisions/ADR-0035-desktop-updates-from-the-signed-feed.md)).
It asks every ten minutes, but contacts the feed at most once an hour after its
last completed check, even across relaunches. Relaunching does not force a
check, so a new release can take up to about 70 minutes to show. It only tells
you; nothing installs until you choose to.

One row above your account in the sidebar shows where things stand:

| State | Row |
| --- | --- |
| A release is available, or newer files are already installed | **New version · Restart** |
| Downloading, verifying, waiting for the password | **Updating** with the busy dots |
| The install failed | **Couldn't update · Try again** |
| A release is available, but the macOS app is translocated or in a folder it cannot write | **Move ECHO to Applications to update** |

Select **New version · Restart** to install. ECHO won't install while it still
has unfinished work, just as it won't sign out then. It checks the update, quits
and reopens on the new version. On macOS it replaces its own `ECHO.app` without
asking for a password. On Linux the system asks for an administrator password;
a helper running as root then checks the update again before reinstalling the
package. If another person on the same Linux machine already updated ECHO, the
row also reads **New version · Restart**, and restarting uses the new version.
**Restart** sets ECHO to reopen only once the quit is certain. If you cancel
the quit when ECHO asks about unfinished work, ECHO stays open, and a later
quit does not reopen it.

An update fails safely:

- If you cancel the password prompt, ECHO keeps running the version you had.
- A failed background check shows nothing, and the current version keeps
  running.
- If the install fails, ECHO keeps or reopens the old version and shows
  **Couldn't update · Try again**.
- On macOS, a failed swap puts the previous app back. macOS App Management may
  block the swap; that keeps the old app too.
- On Linux without `/usr/bin/pkexec`, the updater stays off and the manual
  reinstall remains.
- ECHO refuses a feed older than the last one it verified, and the Linux
  helper one older than the last one it installed. A seat installed by hand, or
  a new user, has no such record until its first helper install, so it accepts
  any unexpired signed feed at or above its sequence floor. Undoing an update
  takes a newer release.

After an update on macOS, you may have to grant ECHO's macOS privacy
permissions again, because each build has a new code identity.

If updating keeps failing, install the release by hand. On Linux:

```sh
sudo apt install --reinstall ./ECHO-0.1.0-linux-amd64.deb
```

On macOS, quit ECHO and replace `~/Applications/ECHO.app` with the release's
app. A desktop installed before this change also needs this once, with a
release package, before it can update itself.

Only release packages update. The `.tar.gz`, development runs (`npm start`) and
test builds never do. Update files live in
`~/Library/Application Support/ECHO/desktop/updater` on macOS and
`~/.config/ECHO/desktop/updater` on Linux.

## Compatibility evidence and remaining desktop checks

The initial Linux x64 assessment ran the unchanged application under X11/Xvfb:
357 Person-client tests passed (one pre-existing platform skip), and 30 of 31
selected desktop tests passed. The only failure expected a Mac shortcut label;
the app correctly displayed `Ctrl+Shift+E`. Tests now use the platform's actual
Control/Command modifier and shortcut labels. No application runtime code change
was needed for those workflows.

The full Linux run also exposed a timing assumption in the cancellation fixture:
its delayed answer could arrive before a slower runner clicked Cancel. The test
now explicitly releases that response after cancellation. This fixture is
compiled out of release builds; application behavior is unchanged.

The `desktop-app` CI matrix runs on macOS 15 arm64 and Ubuntu 24.04 x64 in
parallel. Whenever CI selects it, both runs are required; a failure on one does
not cancel the other.
Each typechecks the desktop, runs unit and full Electron end-to-end tests,
builds the platform's packages, and verifies release fuses and packaged startup.
Linux uses Xvfb and additionally installs the deb, validates its desktop entry,
and smokes the installed executable under Ubuntu's default user-namespace
restriction, so it starts only through the deb's AppArmor profile. It then
reinstalls the deb over itself, as the update helper does, and checks that the
AppArmor profile, the root-owned helper and the smoke test survive. macOS
verifies the app's code signature.
A pull request into `main` selects the matrix when its tested merge changes the
desktop inputs listed in
[`tools/ci-select-jobs.mjs`](../../tools/ci-select-jobs.mjs) or `main`'s own
required check has not passed; a manual dispatch or an unverified push to
`main` always does.

CI caches npm downloads and Electron/packaging-tool downloads separately by
OS, architecture and lockfile. After a lockfile change, a pull request starts
from the newest Electron/packaging-tool entry saved on `main`. CI rebuilds the
application from the current commit on every run that selects it. Packaging
already compiles and checks the release bundles, so CI does not repeat that
build before packaging. All repository, CLI and Authority checks keep their
independent jobs; `CI required checks` gates them and both desktop targets.

Xvfb exercises X11, not a complete GNOME/KDE desktop. Before claiming support
for a particular Wayland desktop, check portal consent, global capture shortcuts,
tray visibility, window focus, native file dialogs, drag-and-drop and browser
sign-in on that desktop. Reopen ECHO through the desktop launcher if its tray or
global shortcut is unavailable. Linux ARM64 is outside this package target.

CI cannot show a polkit password prompt or a real macOS app swap. The desktop
update still needs one A-to-B update on a native macOS arm64 seat and one on an
Ubuntu 24.04 x64 seat with a polkit agent, each followed by `Build <sha7>` in
the tray and an authenticated read.


A project's **Tools** (in its title bar, the line above its feed, or the
project menu) is one sheet for every tool a project can read: a Jira project
key and up to 20 Confluence spaces. Each row shows your own connection; a tool
you have not connected has **Connect** in its row, which waits on the browser
and then shows the pick, without leaving the sheet. A project lead's **Save**
writes every changed setting and closes the sheet; a member sees what the
project reads and can connect their own account. Project Ask uses the saved
settings for live reads and citations, under each asker's own connection; a
project with none includes no Jira or Confluence evidence. The settings retain
only project coordinates.

**Create** in New project opens the project at once. The people picked are
added and the files saved behind it, with a toast saying how far it got; the
sheet comes back only for one whose outcome needs you (Try again, Check status,
Skip…), and otherwise closes by itself. Toasts that confirm something go after
a few seconds; warnings stay until the next page.
