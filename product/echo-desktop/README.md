# ECHO desktop

The app shares its TypeScript client, host, renderer and Electron main process
across macOS and Linux. Packages currently target macOS arm64 and Linux x64.
Windows packaging is not implemented.

Global Ask includes live Jira reads through the person's connected account and
shows ticket citations that open directly in Jira. Project and Mine scopes keep
their existing boundaries; Jira project mapping is separate work.

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
parallel. Both runs are required; a failure on one does not cancel the other.
Each typechecks the desktop, runs unit and full Electron end-to-end tests,
builds the platform's packages, and verifies release fuses and packaged startup.
Linux uses Xvfb and additionally installs the deb, validates its desktop entry,
and smokes the installed executable. macOS verifies the app's code signature.

CI caches npm downloads and Electron/packaging-tool downloads separately by
OS, architecture and lockfile. It rebuilds the application from the current
commit on every run. Packaging already compiles and checks the release bundles,
so CI does not repeat that build before packaging. All repository, CLI and
Authority checks keep their independent jobs; `CI required checks` gates them
and both desktop targets.

Xvfb exercises X11, not a complete GNOME/KDE desktop. Before claiming support
for a particular Wayland desktop, check portal consent, global capture shortcuts,
tray visibility, window focus, native file dialogs, drag-and-drop and browser
sign-in on that desktop. Reopen ECHO through the desktop launcher if its tray or
global shortcut is unavailable. Linux ARM64 and automatic desktop updates are
outside this package target.
