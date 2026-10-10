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

Linux outputs are in `dist-app/`:

- `ECHO-<version>-linux-amd64.deb`: Debian/Ubuntu installer with the Electron
  runtime, dependencies, desktop launcher and sandbox integration.
- `ECHO-<version>-linux-x64.tar.gz`: the app directory for manual distribution;
  the receiving system must supply Electron's system libraries and permit its
  sandbox. Prefer the deb on Ubuntu, where the installer supplies an AppArmor
  profile.
- `linux-unpacked/echo-desktop`: the executable used by the package smoke test.

Build Linux packages on Linux for a reproducible native test environment.
Building an archive on macOS does not validate Linux execution.

## Install and verify on Linux

On an x64 Debian/Ubuntu desktop, install the deb with the system package manager:

```sh
sudo apt install ./ECHO-0.1.0-linux-amd64.deb
echo-desktop
```

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
and smokes the installed executable. macOS verifies the app's code signature.
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
global shortcut is unavailable. Linux ARM64 and automatic desktop updates are
outside this package target.


Project leads can choose **Jira project** from the project menu to save or remove
one Jira project mapping. Each asker connects their own Jira account in Tools.
Project Ask uses the saved mapping for live ticket reads and citations; an unmapped
project includes no Jira evidence. The setting retains only project coordinates.
