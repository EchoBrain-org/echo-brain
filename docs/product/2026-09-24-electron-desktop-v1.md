# ECHO desktop on Electron: migration plan (2026-09-24)

Proposed home: `docs/product/2026-09-24-electron-desktop-v1.md`. This is a new dated doc. It replaces two lines in `deploy/release/README.md`: `:931` ("Windows … outside this scope") and `:1018` ("There is no Linux desktop app"). Older design docs stay as they are. Where this doc and [ADR-0015](../decisions/ADR-0015-global-and-project-scoped-person-ask.md) disagree, the ADR wins. It removes the organization People sidebar row, so parity row H14 is dropped. (The 2026-09-23 UI refinements doc it records was removed; see Git history.)

Parity reference: `.worktrees/overlay-refine-int` at `07a7ce8`. That tree is `main` (`658b233`) plus changes to 9 Swift and proof files. Every repo citation below points at that tree.

Citation keys:
- `[EF §n]`: the electron-facts inventory.
- `[CH §n]`: the client-host design.
- `[RR §n]`: the retire-release inventory.
- `[parity X]`: a row in the parity inventory.
- `xplat-maps.md:n`: the prior research file.

---

## 1. Decision and what changes

We replace the native Swift/AppKit app with one Electron app, written in TypeScript, for macOS, Windows and Linux. The app covers three Swift products, about 10.8k lines in total [RR §1a]:
- the overlay (`product/echo-overlay/*.swift`)
- the Slack connected-tools window (`providers/slack/client/swift/slack-connected-tools.swift`)
- ECHO Setup (`product/echo-onboarding/main.swift`)

Today the app starts the CLI as a separate process 3 times for every action (`projects.swift:225-235`). The new app loads the existing TypeScript person client inside itself instead. Every Authority reply is then checked once, by the codecs that already check it.

macOS ships first and fully replaces Swift. Linux follows, then Windows, then signed distribution.

**What "disposable data, no live users" lets us skip:**
- **Data migration.** The session moves to a new per-OS folder, `person/v2`, and the founder signs in once. The `UserDefaults` recovery stores (`projects.swift:320-479`; `uploads.swift:132-196`) are dropped.
- **A dual-running period.** There is no feature flag and no staged rollout to users.
- **The app/CLI pair.** The app embeds the client, so these go:
  - the pair-swap installer with its rollback and backup copy (`start-person-onboarding-kit.sh:155-493`)
  - `--quit-running-overlay`
  - the old bundle id
  - the Setup app
- **Staging data.** It may be reset.

**What we keep:**
- Every safety behaviour, SF1–SF21 in the appendix. Only their storage format changes.
- The build provenance rules (`tools/build-echo-overlay.mjs:122-160,231-240`).
- The Authority and the release record, both unchanged [RR §2].
- A command-line client on the owner's machine. The operator lane runs `person records` and the founder's candidate-client checks from that CLI (`onboard-clean-v1.sh:2099,2124`; `authority-staging-release.mjs:154-155`). At cutover the CLI ships as a small operator kit (§2).

## 2. Target architecture

```
            global shortcut ─┐    ┌─ tray/menu-bar icon · hidden Edit menu (roles)
 single instance --show/--capture │ ┌─ native dialogs → opaque handles
                             ▼    ▼ ▼
    ┌────────────────── MAIN PROCESS (broker; never holds a token) ─────────────────────┐
    │ windows · tray · shortcuts · dialogs · clipboard write · openExternal · app://     │
    │ resolves the person-state folder ONCE and passes it to the host                    │
    │ IPC: 'rpc' + 'event'; per-window method allowlist, sender-frame check, byte bounds │
    │ lifecycle module: conceal/resume, capture, quit (waits for the refresh gate)       │
    │ host supervisor: restart on exit, never while a refresh is in progress             │
    └───────┬────────────────────────────────────────────────────┬───────────────────────┘
            │ contextBridge: window.echo.{rpc, on, dropFile}      │ parentPort (MessagePortMain)
    ┌───────▼────────────────────────────┐        ┌───────────────▼───────────────────────────┐
    │ RENDERERS (sandbox, contextIsolation│        │ UTILITY PROCESS "echo-person-host"        │
    │ no Node, CSP, app:// from asar)     │        │ @echo-brain/person-client/host (unbundled │
    │ • Main: preloaded hidden, never     │        │   package from the one packed tarball)    │
    │   destroyed; Home, project, Ask,    │        │ • ~25 PersonClient methods + codecs       │
    │   compose layer always mounted      │        │ • expected-account check on every write   │
    │ • Organization People window        │        │ • one refresh gate; CLI-path calls too    │
    │ • Connected tools (Slack) window    │        │ • recovery records; only reader/writer    │
    │ Fixed message table (desktop-owned) │        │   of person/v2; fetch → Authority (HTTPS) │
    └─────────────────────────────────────┘        └───────────────────────────────────────────┘
```

### Client host

The client runs in an Electron utility process [CH §1]. That way a slow synchronous hash of a 25 MiB file, or a hang, never freezes menus or shortcuts.
- The utility process is not sandboxed. That is the same trust level as today's CLI process [EF §2].
- We ship no second Node runtime, and `RunAsNode` stays off [EF §0.2].
- **Environment.** A custom `env` wipes the inherited environment [EF §2]. So main resolves the state folder and passes the absolute path in. The host never resolves it itself.
- **Environment allowlist:** HOME, USERPROFILE, TMPDIR, TEMP, TMP, SystemRoot, LOCALAPPDATA, XDG_DATA_HOME, the proxy variables, and LANG. NODE_EXTRA_CA_CERTS is passed only in dev builds, because the release fuses ignore it anyway [EF §3].
- **stdin** is injected, because `stdio` covers only stdout and stderr [EF §2].
- **Packaging.** The client is **not bundled**.
  - The app embeds the person-client package exactly as packed. That means its `dist`, its `package.json` and its bundled workspace dependencies, all extracted from the one tarball whose digest the release records.
  - This keeps the build-identity lookup in `package-identity.ts:12-16,56-72` working.
  - esbuild bundles only main, preload, renderer and a small host bootstrap.

### Refresh safety

A refresh moves the live session file aside before its network call (`session-store.ts:396-414`). Dying at that moment signs the user out (`:344-366`). So:
- The supervisor never kills or restarts the host while the refresh gate is held, and the watchdog pauses during a refresh.
- `before-quit`, and any update install, waits for the gate for up to about 10 s.
- The gate also covers the calls that go through `runPersonClientCli` (sign-in, `start`, Slack). The host runs `ensureFresh()` first and holds the gate so that no refresh overlaps them. This matters because that path builds its own client (`commands.ts:867`; `client.ts:802-806`).
- The refresh claim records a pid and a start time (client change 3), so a live claim can be told from a stale one:
  - **Live claim:** "busy". Wait up to the refresh call's own timeout, then show a fixed retryable error.
  - **Stale claim:** signed out, with "Sign-in was interrupted. Sign in again." It never becomes an endless busy state.

### Account check on every call (SF1, SF2)

1. The renderer sends the account epoch it is showing. Before the call, the host reads the session file locally and compares it with that epoch.
2. The refresh runs through the shared gate. The user can never cancel a refresh.
3. **Writes carry an `expected_account`** (authority origin and id, organization, membership, session family) into the client. The client compares it with the stored session right before sending. On a mismatch it throws `not_submitted` (client change 7).
   - This extends the existing document check (`client.ts:438-443`) to `withContextSession` (`:410-431`), and to the Ask, employee and tool paths.
   - Replays from recovery records carry the recorded account.
4. The call runs under `AbortSignal.any([cancel, timeout])`.
5. After the call, the host reads the session again. If the account changed, a write is reported as "may have completed".

Sign-in and sign-out are refused while a write is running (AC6). This check replaces 3 Node launches per action with 2 file reads.

### Renderer contract

- **What the renderer gets:** checked, token-free objects. Errors arrive as `{code, retryable, mutation_outcome, request_id}` only.
- **Error messages:** the renderer maps each code to its own fixed message table, built from `projects.swift:159-172` and `people.swift:281-346`. It never shows a forwarded string. Today the CLI forwards `error.message` (`commands.ts:480,1287-1293`); the app does not.
- **Sign-in phases** carry only `{phase, expires_at, browser_opened}`. The sign-in URL never reaches the renderer.
- **File paths.** The renderer never sees a path.
  - Dialogs return opaque single-use handles.
  - For a drop, the preload calls `webUtils.getPathForFile`, which returns `""` for virtual files [EF §9]. Main then `lstat`s the path and accepts it only if it is non-empty, a regular file, not a symlink, and at most 25 MiB. Main passes the path to the host like a dialog path, and the client's existing snapshot checks apply (`document-file.ts:38-47,127-160`).
  - Invitation files are copied privately (0600) into `<state>/incoming/` and deleted after `start` finishes. This is the same approach as `person-onboarding-ui.mjs:62-85`.

### Windows and keys

- **No Dock icon on macOS.** The app runs as an accessory app, as today (`Info.plist:25`, `main.swift:2305-2325`), using `LSUIElement` [EF §7].
- **⌘E** toggles the main window.
- **⌘⇧E (Capture).**
  1. In the shortcut callback, main sends `capture.open`.
  2. The renderer's compose layer is always mounted, so it switches to compose, places the caret and replies.
  3. Main then shows the window and focuses it with `app.focus({steal:true})`. If no reply arrives within 50 ms, main shows it anyway.
  4. The window uses `backgroundThrottling:false` and `paintWhenInitiallyHidden` [EF §7].
  5. The pending-save state (C12) is pushed to the renderer ahead of time. Capture never reads the clipboard (`projects.swift:3800`).
- **Shortcut conflicts.** `register()` fails silently, so the app checks `isRegistered()` [EF §4]. On Windows and Linux the app tries 2–3 candidate chords, picked in Phase 0, and uses the first one that registers. Labels and the tray always show the chord that is actually in use.
- **A launcher that always works.** A "Capture" launcher entry (a `.desktop` file on Linux, a Start-menu item on Windows) runs `echo-desktop --capture`. There is always a path the user can bind. The executable is named `echo-desktop` so it never shadows coreutils `echo`.
- **Close** hides the window. A single instance is enforced with `requestSingleInstanceLock` [EF §6].

### What the CLI remains

It is the operator and scripting tool. It is built from the same tarball and shares `person/v2`, and the refresh and logout claim files make it safe to run alongside the app (`session-store.ts:376-473`). It ships two ways:
- **The operator CLI kit, from Phase 4:** CLI only, with a bundled Node, for darwin-arm64 and linux-x64. It is derived from today's Linux terminal kit, with no app and no Swift.
  - On macOS it installs to `~/Library/Application Support/ECHO/bin/echo-brain`, the path the operator text already uses (`onboard-clean-v1.sh:2099,2124`).
  - Its tarball digest is the release's `person_client_sha256`, so the staging release gate (`authority-staging-release.mjs:154-155`) is unchanged.
- **The existing offline bundle,** for machines that already have Node (README:1079-1138; `install-person-client-clean-v1.sh:42`).

There is no Windows CLI kit and no shim installed by the app.

### Build identity

Each app carries one file, `echo-desktop-build-identity-v1`, in `resources/` outside the asar [CH §7; RR §2]. It holds:
- `product_version`, `source_sha`, `source_kind`
- `platform`, `architecture`
- `electron_version`, `node_version`
- `person_client {product_version, source_sha, artifact_sha256}`, plus the update public key if Phase 7b ships

Build rules:
- `person_client.source_sha === source_sha`.
- `artifact_sha256` is the digest of the tarball that was embedded.

The host's `app.status` reports it the same way `person status` does (`commands.ts:1132-1162`).

### Storage per OS

One pure resolver, `personStateDirectory({env, platform, home})`, replaces `SESSION_DIRECTORY_PARTS` (`session-store.ts:26-31`).

| OS | Person state (tokens, snapshots, recovery, incoming) | Chromium `userData` |
|---|---|---|
| macOS | `~/Library/Application Support/ECHO/person/v2` | sibling `…/ECHO/chromium` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/echo/person/v2` | `${XDG_CONFIG_HOME:-~/.config}/ECHO` |
| Windows | `%LOCALAPPDATA%\ECHO\person\v2`, with the root resolved through `realpathSync.native` | `%LOCALAPPDATA%\ECHO\chromium`, set explicitly because the default roams [CH §6] |

**Test isolation.** Unpackaged builds accept test overrides for both the state folder and `userData`, and the Playwright fixture always sets them to temporary folders. Tests therefore never read the founder's real session, never send its tokens to the mock, and never collide with the running app's single-instance lock. The canary test also checks that the real folder is never opened.

## 3. Repo layout and tooling

```
product/echo-desktop/                  npm workspace @echo-brain/echo-desktop
  package.json                         electron 44.4.x (→ current major before Phase 5), electron-builder 26.x,
                                       @playwright/test (dev); preact (runtime)
  tsconfig.main.json / .renderer.json  Node+Electron types / DOM+JSX; referenced from tsconfig.workspaces.json
  electron-builder.config.mjs          mac zip, linux deb, win NSIS per-user; executableName echo-desktop; fuses
  build/                               icons (open-licensed set), entitlements, Info.plist extras
  src/main/                            lifecycle, windows, tray, shortcuts, dialogs+handles, app://, broker, supervisor
  src/preload/                         window.echo.rpc / on(name, cb(payload)) / dropFile(File) only
  src/renderer/                        Preact screens, one store with a modal stack, ids.ts (data-testid = Swift mark() ids)
  src/shared/                          method table (per-window allowlist + byte bounds), event types, fixed message table
src/product/person-client/host.ts      exported as @echo-brain/person-client/host [CH §2]
src/product/person-client/state-directory.ts
providers/slack/desktop/               new workspace: Connected-tools view (own boundary allows preact)
tools/build-echo-desktop.mjs           provenance-bound build from --person-client-tarball (replaces build-echo-overlay.mjs; drops getuid :73)
tools/echo-capture-latency/            chord injector + scorer (Appendix I)
tests/desktop/                         Playwright specs, store/broker unit tests, mock-authority.mjs
tests/fixtures/desktop-v1/             route-keyed HTTP fixtures (Ask, evidence, documents, employees, tools, refresh, login)
tests/person-client/host*.test.ts      host tests (Node 22 and Electron's Node)
```

**Packaging: electron-builder 26.x, not Forge.**
- One tool covers NSIS, deb, notarization, Azure Artifact Signing (`win.azureSignOptions`) and electron-updater [EF §10–§12].
- Forge 7.11 has no first-party NSIS maker. Its Windows update path is Squirrel.Windows, which has had no release since 2020 [EF §10].
- electron-builder does not use `@electron/packager`, so its asar-integrity setup is not the one [EF §3] documents. Phase 0 therefore proves it on macOS and on a Windows NSIS build.

**UI library: Preact with TSX.**
- The UI has about 60 stateful controls, a modal stack, and rules for replaying actions after a load finishes [parity PP8]. That needs a component model.
- Preact is about 4 KB with one runtime dependency, and it has React's API, which coding agents write fluently.
- Styling is plain CSS with dark-theme tokens [parity AP9].

**Build and toolchain** (Phase 1, about 0.5 ew):
- **Bundling:** esbuild, already in the repo (`package.json:79`), bundles main, preload, renderer and the host bootstrap.
- **Type checking:** the desktop package gets its own composite tsconfigs. `tools/build.mjs:118-127` runs `tsc -b` on every workspace, and the root `tsconfig.json` covers only tests.
- **Lint:** extend the eslint globs to `product/**/*.{ts,tsx}`. Today `eslint.config.js` reaches only `src`, `providers` and `tests`.
- **Node types:** `electron@44.4.5` depends on `@types/node ^24.9.0`, while the repo pins 22.15.3 (`package.json:76`). An npm `overrides` entry, or per-tsconfig types, keeps one set of Node types, and `npm run check` must pass with it.
- **Electron download:** set `ELECTRON_SKIP_BINARY_DOWNLOAD=1` in the Authority Dockerfile and in every workflow that runs `npm ci` outside the desktop job, including `authority-recovery-helper-bundle.yml:23`.
- **Pins to update:** the Dockerfile COPY list (`deploy/organization-authority/Dockerfile:4-22`, pinned by `ci-workflow.test.ts:116-136`) and the workspace-graph pin in `workspace-boundaries.test.ts`.

**Boundaries:**
- The `echo-desktop` package may import only `electron`, `preact`, and later `electron-updater`.
- Only the host bootstrap may import `@echo-brain/person-client`. Main and the renderer may use `import type` from `organization-api` only.
- The boundary rule bans clipboard-read and selection APIs anywhere in desktop code (SF16).
- The Slack view does not go in `providers/slack/client`. That package is Node-only, allows no external packages, and ships in the CLI tarball and the Authority image. It gets its own `providers/slack/desktop` workspace, loaded from a desktop bootstrap entry, which keeps INV-ADAPTERS-005.

**Shared with the CLI:**
- The whole person-client package.
- The exported error envelope `contextCliFailure` (`commands.ts:473-491`), so codes match. The host drops its `error` text.
- The `organization-api` codecs and `validatePersonQueryText` (`person-query.ts:9-36`). This also removes the control-character difference between Swift and TypeScript (`main.swift:979-994`).
- `tests/fixtures/project-context-v1`, and the fetch-injection pattern (`echo-projects-cli-bridge.mjs:28-30`).

## 4. Phases

All estimates assume one engineer working with coding agents and are in engineer-weeks (ew).
- **Total:** 20–30.5 ew without auto-update, or 22–33.5 ew with it.
- **macOS cutover:** after 15–22.5 ew.
- **Calendar:** starting 2026-09-28, the program ends between about February and May 2027.
- **Signing:** Apple and Microsoft enrolment runs on calendar time from Phase 0.

### Phase 0: Spike (1.5–2.5 ew)

- **Goal:** settle the unknowns before writing product code.
- **Scope:**
  - Run the 5 client suites (28 files, 455 tests; already green on Electron 42 [CH §9]) on `electron@44.4.5`'s Node, on macOS and Ubuntu.
  - On Windows, run `probe-node24.mjs` and list the expected W1-class failures. The mode-bit checks in `session-store.ts:98-110` reject Windows folders until Phase 6.
  - Run `utilityProcess.fork` on the **unbundled** person-client package inside an asar, including its `import.meta.url` identity read (`package-identity.ts:12-16`). If that fails, use a 5-line CommonJS bootstrap that loads the ESM package with a dynamic `import()`.
  - Check that the environment allowlist resolves the same state folder as a terminal CLI.
  - Check `fs.watch`, loopback sign-in and cancel.
  - **Fused builds:** a mac zip and a Windows NSIS build, each launched with `--smoke`. A tampered asar must be refused on both.
  - **Throwaway Mac shell:** accessory mode, preloaded window, hidden Edit-menu roles, tray template icon, idle memory.
  - **Latency baseline:** build the Capture latency harness (Appendix I) and measure the Swift app alone, then the Electron shell alone. The founder removes Swift from login items for the Electron run, because both apps claim ⌘E/⌘⇧E exclusively (`main.swift:2234-2278`).
  - **Chords:** pick 2–3 candidate chords each for Windows 11 and Linux, tested on US, DE and FR layouts.
  - Start Apple Developer enrolment and check eligibility for Azure Artifact Signing.
- **Exit:** a spike report in the dated doc recording:
  - macOS: p95 at most Swift + 30 ms, zero lost characters, 100% focus on arrival. If not, budget a native addon (+1–2 ew), written in Objective-C++ with a registered source assembly, because Phase 4 bans `.swift`.
  - Suites green on macOS and Ubuntu; the Windows failures listed.
  - The identity read works inside the asar.
  - Idle memory accepted by the founder.
  - Chord candidates chosen.
- **Deleted:** nothing. The spike branch is thrown away.

### Phase 1: Foundation plus a thin daily loop (5–7 ew)

- **Goal:** a Mac dev build the founder can try, with all security and host plumbing in place.
- **Scope:**
  - `host.ts`: method table, account check with `expected_account`, refresh gate (also held around the CLI paths), cancel through a wrapped fetch, error envelope without text, canary test, host-side recovery store. Client changes 1–8 (Appendix D).
  - `personStateDirectory()` and `person/v2`. A new ADR supersedes ADR-0002's storage clause (`ADR-0002…:244-245`), and the docs sweep covers `README.md:30`, `identity-and-onboarding.md:45`, `person-client-architecture.md:28` and `deploy/release/README.md:1068`.
  - Broker with per-window allowlists and handles, preload, `app://` with confinement and CSP, fuses (release builds only), single instance with `--show`/`--capture`, accessory mode, shortcuts with fallback candidates.
  - A first-run screen that signs in through `login`/`start` in the host [CH §5].
  - The toolchain work from §3.
  - `tools/build-echo-desktop.mjs`.
  - **CI:** new jobs `person-client-pack`, `desktop` (macOS leg) and `desktop-assemble`, all added to `required-checks` now. That means `ci.yml:408`, `ci-workflow.test.ts:69-82` and `RB-OPERATIONS-003:78-85` change together (Appendix E). `person-client-package` stays until Phase 4.
  - An Electron-Node lane for the client suites.
  - The mock Authority, and the `desktop-v1` fixtures for Ask, evidence, refresh and login.
  - **Vertical slice:** H1, H3; AK1, AK4 (global Ask); C1, C3, C4, C10 (⌘⇧E text capture, Only me).
- **Exit:**
  - The founder installs the build and signs in from first run with an invitation or an organization URL, then sees Home, asks, and captures.
  - Host tests pass for SF1–SF6, SF9, SF10, SF12, SF18–SF20. That includes an SF2 test: the account switches between the gate and the send, `calls.jsonl` shows zero write requests, and the outcome is `not_submitted`.
  - The refresh tests pass: a Slack poll plus a projects call produce exactly one refresh, and killing the host after a claim gives the fixed signed-out message.
  - A first-run spec runs `start` against the mock and reaches `ready`.
  - The canary passes.
  - The packaged fused `--smoke` confirms the fuses, the identity (read from inside the asar), and that the test hook is absent.
- **Deleted:** the home-based session path (`session-store.ts:26-31`; `document-file.ts:81`) and the "This Mac" wording (`commands.ts:730`).
- **Swift** is frozen for bug fixes. It keeps working, because the CLI it launches now resolves `person/v2`.

### Phase 2: Mac parity, P0 rows (4.5–6.5 ew)

- **Goal:** the whole daily loop at Swift quality, including privacy on app switch.
- **Scope:**
  - Every P0 row except H14, which is dropped. Pulled forward from P1 so the exit specs can close: AK16, PP5, and a minimal AC1 (Sign in with Google…, Sign out…; needed by H2).
  - A tray skeleton: Open, Capture, Quit.
  - Conceal and resume, following the rule in §5.
  - `store.test.ts`, `broker.test.ts`, `security.spec.ts`.
  - The `desktop-v1` documents fixtures.
- **Exit:**
  - These Playwright specs are green on macOS: P:ui-round-trip, ui-access-loss, ui-search-controls (without the owner-People step), ui-back and ui-home-back (without their New-project steps, which move to Phase 3), ui-home-empty-return, ui-refresh*, ui-capture-return, ui-drop (plus symlink, folder and virtual-file cases), ui-documents, ui-upload-sharing, ui-upload-unknown, ui-upload-rejected, ui-recovery*, ui-associate; U:window*; and the S UI modes.
  - SF7, SF8, SF11 and SF13–SF17 pass.
  - The real-event conceal test is green.
  - The latency gate still passes when re-run.
  - The macOS manual checklist passes.
  - The founder signs off the P0 screens and switches daily use to Electron.
- **Deleted:** nothing.

### Phase 3: Mac parity, P1 rows (2.5–4 ew)

- **Scope:**
  - H6, H15, PP7, PP13, SR4
  - PS1–PS8, NP1–NP8, AC2–AC7, OP1–OP6, SL1–SL4
  - OB2–OB6 as in-app first run (OB1, "install app and CLI as a pair", is waived)
  - The full AP1 tray menu, AP7–AP9
  - The New-project steps of ui-back and ui-home-back
  - New specs for behaviour that has no proof today [parity §4]
  - The `desktop-v1` employees and tools fixtures
  - OP3 keeps the owner's folder picker. Main returns a vetted handle, and the host creates the private `ECHO-invitation-…` subfolder inside it, as `people.swift:598-611` does today.
- **Exit:**
  - P:ui-people, ui-member, ui-create, ui-create-skip, ui-create-read-fail and ui-create-account are green.
  - The E, A and OB cases pass at host level.
  - SF21 passes.
  - Every P1 row passes or is waived in the dated doc.
- **Deleted:** nothing.

### Phase 4: Mac cutover and Swift deletion (1.5–2.5 ew)

- **Goal:** one Mac app, landed in one PR.
- **Scope:**
  - Delete RR §1a–1d.
  - Turn the kit builder, verifier and smoke into the **operator CLI kit** for darwin-arm64 and linux-x64 (0.5–1 ew):
    - Remove their app and Mac branches.
    - Remove the Swift import at `create-person-onboarding-kit.mjs:4,235` and the pin at `linux-person-kit.test.ts:132`.
    - Rewrite `person-onboarding-smoke.mjs` (hard-coded `ECHO.app.zip` at `:76`) so `ci.yml:40-41` stays green.
  - **Operator text:**
    - Rewrite `onboard-clean-v1.sh:2090-2128` so the kit build no longer takes `--app`, the owner installs the desktop app plus the operator kit, and `person slack-link` becomes the app's Connected tools.
    - Rewrite `PB-OPERATIONS-001:92-106`.
    - Update their pins (`authority-operator-playbook.test.ts:33-39`; `organization-authority-deployment-profile.test.ts:482-612`) in the same PR.
  - **CI:** move the neutral steps of `person-client-package` into `person-client-pack` and delete the job, editing the same three files as Phase 1. In `package.json`, delete `:44` and `:47` and add the desktop scripts. Remove `product/source-boundary.v1.json:49-50`.
  - Rewrite the docs in Appendix G.
- **Exit:**
  - `required-checks` is green.
  - No `.swift` file remains under `product/` or `providers/`. From here on, `tools/lib/source-assemblies.mjs:90-93` fails any new one.
  - A staging release canary runs `person records` from the operator kit and passes `authority-staging-release.mjs`.
  - The founder has used only the Electron build for at least 1 week.
- **Deleted:** about 17.8k lines (§10).

### Phase 5: Linux x64 (2–3 ew)

- **Scope:**
  - First, upgrade Electron to the current stable major, Chromium 154 or later (0.5 ew). This brings the GNOME tray fix for #53213 and moves off 44, which reaches end of life on 2027-03-02 [EF §1, §5]. Re-run the spike checks for the portal, fuses and tray.
  - Add a Linux CI leg under `xvfb-run -a`, using the Ubuntu 24.04 user-namespace sysctl [RR §4].
  - Package a `.deb` that installs a reverse-DNS `.desktop` file, with `desktopName` set for the shortcut portal [EF §4].
  - Install a "Capture" launcher entry that runs `/usr/bin/echo-desktop --capture`.
  - L7: fall back to copying where hard links fail.
- **Exit:**
  - P0 specs green on Linux, and P1 specs green or waived.
  - The conceal real-event test (xdotool) is green.
  - Latency and focus gates (Appendix I) pass on X11 and KDE. On GNOME Wayland, the portal path and the custom-shortcut path are both measured, and the one with the higher focus rate becomes the default.
  - `dpkg -S /usr/bin/echo` still reports coreutils.
  - The manual checklist passes on Ubuntu 26.04 GNOME 50 Wayland, KDE 6, and Ubuntu 24.04 (fallback shortcut).
- **Deleted:** only the text "There is no Linux desktop app" (README:1016-1018). The Linux kit lives on as the operator CLI kit.

### Phase 6: Windows x64 (2.5–4 ew, plus signing lead time)

- **Scope:**
  - Client port: W1, W3, W4, W6, W7, W10–W12, W14 (1–1.5 ew) [CH §10], plus `.gitattributes` with `* text=auto eol=lf`.
  - A per-user NSIS installer that stops the running app before swapping files (`xplat-maps.md:96`).
  - Authenticode signing through Azure Artifact Signing.
  - A first-run tip about the tray overflow area.
  - A Windows CI leg.
- **Exit:**
  - P0 specs green on Windows. `tests/person-client` green on `windows-latest` on both Node 22.22.1 and Electron's Node.
  - The conceal real-event test and the latency and focus gates pass.
  - The signed installer installs without admin rights on a clean Windows 11 VM, and the manual checklist passes.
- **Deleted:** the "Windows outside scope" text (README:926-934).

### Phase 7: Distribution (7a: 0.5–1 ew; 7b, optional: 2–3 ew)

- **7a, macOS notarization:**
  - Developer ID, hardened runtime, JIT entitlements, then `notarytool` and stapling in CI [EF §11].
  - It can run any time after Phase 4 once Apple enrolment lands. Until then, the current ad-hoc, private-channel model continues (README:778-782).
  - **Exit:** a notarized build opens on a fresh macOS 15 machine with no override.
- **7b, auto-update (deferrable):**
  - electron-updater 6.8.x with a generic HTTPS feed. The bucket objects are public and immutable, and no bucket credential ships in the app.
  - Trust comes from an **Ed25519-signed `desktop-release.v1.json`**. The public key is compiled into the app and recorded in the build identity, and the app verifies the signature on every OS before `quitAndInstall`.
  - **Linux: notify only** (no pkexec install) until there is a signed apt repository.
  - Includes one more Electron major upgrade (0.5 ew).
  - **Exit:**
    - An update from N to N+1 applies on macOS and Windows.
    - A consistently re-hashed tampered artifact is refused on all three OSes.
    - A downgrade is refused.
- **Deleted:** the ad-hoc signing path (after 7a). The manual-update text (README:720-721) goes only if 7b ships.

## 5. Testing strategy (capped)

- **Host tests** (vitest, on Node 22 in `check` and on the Electron-Node lane). The host is plain Node, tested with an injected fixture `fetch` and `now`, the same pattern as `echo-projects-cli-bridge.mjs:22,28-30`.
  - They cover the scen, cli and session modes (Appendix B): the account check, SF2, recovery, replay, overflow, cancel, strict replies, and refresh interruption.
  - Parse modes stay mostly in the `organization-api` codec tests, with one negative case per class at the host boundary.
- **Canary.** No outgoing message may contain any of these:
  - any secret fixture value (access and refresh tokens, `oib_…`, `psf_…`, `login_grant`, the loopback token)
  - the state-folder or home path
  - a `LEAK-SENTINEL` string placed in fixture error bodies and in thrown error messages

  It runs in the host tests and over the broker traffic recorded in every Playwright spec.
- **Renderer store tests** (`tests/desktop/store.test.ts`, with a fake rpc). They cover the UI state Swift kept in `ProjectSession` (`projects.swift:792-823`): switch-project, account-clear, demoted, de-duplicating paged rows, dropping late replies while concealed, and source display truncation (`main.swift:803-852`).
- **Broker tests** (`broker.test.ts`): one test per rule. An unknown method, the wrong window, oversized parameters and a subframe sender must each be refused.
- **UI tests** (Playwright `_electron`, experimental [EF §13]). They run against the unpackaged app, because a fused build blocks `--inspect` [EF §3].
  - A test hook, compiled out of release bundles, injects `fetch`, `now` and the state and `userData` overrides.
  - `mock-authority.mjs` serves `project-context-v1` plus `desktop-v1`, route-keyed, and writes `calls.jsonl`.
  - `data-testid` values equal the Swift `mark()` ids, and spec titles keep the Swift mode names.
  - OS events go through the main-process `lifecycle` module, which specs call with `evaluate` [EF §13].
  - `security.spec.ts` checks:
    - `app://echo/%2e%2e/…` returns 400
    - navigation and `window.open` are denied
    - permission requests, including `clipboard-read`, are denied
    - every window has sandbox and contextIsolation on and nodeIntegration off
- **Conceal on app switch, tested with real OS events.** The rule:
  - macOS: `did-resign-active`.
  - Windows and Linux: `browser-window-blur`, with no ECHO window focused after 150 ms. The rule is suppressed only while a dialog ECHO opened is still open.

  One real-event test per CI leg: `osascript` activating Finder, `xdotool windowactivate` under xvfb, and a PowerShell `SetForegroundWindow` helper. Each asserts the concealed DOM within 250 ms. If the Windows runner refuses to hand over the foreground, that case becomes manual.
- **Capture latency and focus** use the injector harness (Appendix I). It is re-run at the Phase 0, 2, 4, 5 and 6 exits, and the numbers go into the dated doc.
- **Packaged smoke.** The fused build runs with `--smoke`, which checks:
  - fuses and asar integrity
  - the identity file, read inside the asar through `app.status`
  - that the host starts
  - that the test hook is absent
  - that a launch with `--remote-debugging-port` exits

  On macOS it also runs `codesign --verify`. An unfused copy with the same asar layout runs the first-run `start` spec.
- **Budget.** Per-file caps are in Appendix H, for about 7.2k new lines in total. That is more than the ~5.1k lines of Swift proofs and drivers being retired [RR §1c], because the new suite covers three OSes, security and first run, which Swift never tested.
  - About 159 source-text pins are retired, not ported (`xplat-maps.md:162`).
  - `tests/architecture/desktop-test-budget.test.ts` fails `npm run check` when any file exceeds its cap.
  - When a cap is hit, SF-row cases are kept first, then P0 cases. Anything else is retired in the dated doc with a reason.
- **Manual checklist** (per OS, per release, about 30–45 minutes):
  - The chord from another app, with the caret in the body.
  - The shortcut-in-use warning, and the fallback chord.
  - The tray menu, including the owner-only People item.
  - Close hides the window; reopen from the Dock or taskbar.
  - Drag from Finder, Explorer or Nautilus.
  - Save and open dialogs.
  - Browser sign-in; Slack connect.
  - VoiceOver announcement; IME input.
  - Linux: portal consent on GNOME and KDE, the Capture launcher on Ubuntu 24.04, the tray.
  - Windows: tray overflow, signed-installer prompts.

## 6. Security baseline

**Fuses (release builds)** [EF §3]:
- Off: RunAsNode, NodeOptions (this also disables `NODE_EXTRA_CA_CERTS`), NodeCliInspect, GrantFileProtocolExtraPrivileges.
- On: EmbeddedAsarIntegrity (macOS and Windows; it has no Linux support) and OnlyLoadAppFromAsar.
- A launch with `--remote-debugging-port` exits, because no fuse covers it.
- Dev and test builds stay unfused (`tools/authority-local.mjs:803`).

**Renderer:**
- sandbox, contextIsolation, nodeIntegration off, webSecurity on, no `<webview>`.
- CSP: `default-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'`.
- The `app://` handler serves from the asar only. It resolves `path.resolve(rendererRoot, decodeURIComponent(pathname))` and rejects anything outside `rendererRoot` or outside an extension allowlist.
- `will-navigate` and `setWindowOpenHandler` deny everything.
- The permission handler denies everything, explicitly including `clipboard-read`.
- Answer and source text are rendered as text nodes only.

**IPC:**
- Two channels.
- Main checks that the sender is the top frame at `app://echo/`, that the window is known, that the method is on that **window's** allowlist, and that the parameters fit the byte bounds (Appendix C).
- The preload's `on(name, cb)` passes the payload only, never the IPC event.
- Copy answer goes through `clipboard.writeAnswer` in main and writes only on click.
- Nothing reads the clipboard or the selection, and a boundary rule enforces this (SF16).

**Tokens:**
- Only the host holds them, and a boundary rule enforces that.
- Outgoing objects come from per-method whitelists, and errors carry codes, not text.
- At rest, credentials stay plain JSON in the private folder: POSIX 0700/0600, and the default owner access list on Windows [CH §10 W2].

**openExternal:**
- Only the host triggers it: `https:` only, no userinfo (`organization-api/src/person-session.ts:154-186`).
- The renderer has no "open URL" capability.
- `showItemInFolder` works only for a folder the host created in this session.
- Google sign-in never runs in an in-app window [CH §5].

**Updates (7b only):**
- An Ed25519-signed manifest, checked before install on every OS: signature, same product, a newer `source_sha`, and the artifact sha256. The private key stays offline or in a CI secret.
- electron-updater's own checks (the macOS code signature, the Windows `publisherName`) are extra layers [EF §12].
- Linux is notify only, because electron-updater checks nothing for `.deb` beyond a hash from the same bucket and then installs as root through pkexec [EF §11, §12].

## 7. Platform limits the founder must accept

- **Wayland shortcuts** work only through the GlobalShortcuts portal, on GNOME 48+ and KDE [EF §4].
  - On GNOME the user must approve the chord, and ECHO cannot detect conflicts.
  - Ubuntu 24.04 (GNOME 46) and wlroots desktops have no portal. There, the user binds the Capture launcher (`/usr/bin/echo-desktop --capture`) as a custom shortcut.
  - Under XWayland on GNOME 49+, shortcuts fire only while ECHO has focus.
- **Wayland focus.** Chromium drops the portal's activation token (`global_accelerator_listener_linux.cc:366-388`), so GNOME may show "ECHO is ready" instead of raising Capture [EF §8]. The instant, Snapchat-like Capture is not guaranteed there. It is measured, and the better path becomes the default.
- **GNOME tray.** It needs the AppIndicator extension. It is fixed only in Chromium 154 or later (#53213) [EF §5]. On Linux the launcher is the reliable way in, and no copy may say "menu bar" (`main.swift:2276`).
- **Windows:**
  - New tray icons land in the overflow area.
  - There is no hide-from-taskbar mode.
  - There is no Win-key modifier [EF §4]. Ctrl+E and Ctrl+Shift+E collide with common apps, and Ctrl+Alt collides with AltGr, so chords differ per OS and fall back through a candidate list.
  - Focus is granted after a hotkey press [EF §8].
  - SmartScreen warns until the signature builds reputation [EF §11].
- **macOS.** `type:'panel'` is buggy (#53889), so Capture is a normal preloaded window. Electron 44 needs macOS 13+ [EF §1, §7].
- **Linux updates** are notify only unless we run a signed apt repository.
- **Memory:** about 150–400 MB idle (`xplat-maps.md:571`), plus about 60 MB for the host. That is well above Swift.
- **Cadence.** A new major every 8 weeks, and end of life for 44 on 2027-03-02 [EF §1]. Two Electron upgrades are budgeted (Phase 5 and 7b).
- **Node 22** reaches end of life on 2027-04-30, inside the program window (Decision 11).

## 8. Decisions needed (recommended default in bold)

| # | Decision | Default |
|---|---|---|
| 1 | Swift freeze point | **Merge 07a7ce8 to main; freeze Swift from Phase 1; delete it at Phase 4** |
| 2 | Capture technique on macOS | **Pure Electron preloaded window; an Objective-C++ addon only if Phase 0 misses the gate** |
| 3 | Dock icon on macOS | **Accessory (no Dock icon), as today** |
| 4 | Chords | **⌘E/⌘⇧E on macOS; 2–3 candidates per OS elsewhere, first one that registers wins and labels show it; a Capture launcher entry; no settings screen in v1** |
| 5 | Credentials at rest | **Plain JSON in the private folder, owner access list on Windows; not safeStorage** |
| 6 | CLI | **Operator CLI kit with bundled Node for macOS and Linux from Phase 4; offline bundle kept; no shim; no Windows CLI kit** |
| 7 | Linux package | **.deb, `executableName: echo-desktop`; amend README:1022-1024's "no sudo"; no AppImage** (`xplat-maps.md:179`) |
| 8 | Apple Developer ID ($99/yr) | **Enrol now; run 7a as soon as a second Mac account is planned; ad-hoc private channel until then** |
| 9 | Windows signing | **Azure Artifact Signing (about $9.99/month) if eligible; otherwise OV in a cloud HSM** [EF §11] |
| 10 | Auto-update | **Defer 7b; if built, Ed25519-signed manifest and Linux notify only** |
| 11 | Node 24 move | **Outside this program; owner: founder; must land before 2027-04-30. The Electron-Node lane covers the app until then** |
| 12 | Sidebar People entry | **Follow 2026-09-23: tray only; drop H14** |
| 13 | Scope extras | **Unread badges, Linux arm64 and Windows arm64 are out of parity scope** |

**Founder decision, 2026-09-24: keep it as simple as possible.** The priority is a solid foundation for basic core use. Features get added only after the Mac-specific product is fully retired. That settles the open v1 questions:

- Home rows show the project name and a Lead tag. There is no preview line and no unread badge.
- Capture opens empty, with no project, set to Only me.
- The Write sheet has one To picker (canvas v6), not a project picker plus "Who can read".
- There is no sidebar and no People entry (row 12).

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Capture feels slower or loses keystrokes | Injector harness gates at 5 phase exits; compose layer always mounted; addon budget |
| The owner loses the operator CLI at cutover | Operator CLI kit in Phase 4; the release canary runs from it before the exit |
| Identity read fails inside the packaged app, so first-run reports failure after using the invitation | Unbundled client package; identity read moved before session install (client change 8); first-run spec plus the identity check in `--smoke` |
| Write sent under another account after a switch | `expected_account` in the client; the SF2 host test |
| Interrupted refresh signs the user out | Supervisor and quit wait for the gate; CLI-path calls hold the gate; pid-stamped claims |
| Tests touch the founder's real session | Mandatory state and userData overrides; the canary checks the real folder |
| Linux updater gives root to whoever controls the bucket | Signed manifest; Linux notify only |
| Error text or sign-in URLs leak to the UI | Code-only errors; extended canary with sentinels |
| Privacy: conceal misses a real app switch | Written rule, real-event tests on every leg |
| Electron and Node end of life inside the window | Two upgrades budgeted; Decision 11 dated |
| First runtime npm dependencies (`source-boundary.v1.json:19-38`) | Explicit allowlist; lockfile review |
| Test budget creep | Per-file caps enforced by an architecture test |
| Signing lead time (Apple; Azure 1–20 business days) | Start both in Phase 0 |
| Ubuntu 24.04 AppArmor blocks the sandbox for non-.deb installs | .deb only; CI uses the sysctl [RR §4] |

## 10. Deletion list and release changes

**Deleted at Phase 4 (about 17.8k lines)** [RR §1]:
- The Swift product: 10,782 lines.
- `tools/build-echo-overlay.mjs`, `tools/lib/swift-source-assembly.mjs`, and the Swift branch in `source-assemblies.mjs:5,68-73`.
- Proof fixtures (3,055 lines), architecture tests (1,956 lines), and the swiftc case in `cli-http.test.ts:208-240`.
- `start-person-onboarding-kit.sh`, `person-onboarding-ui.mjs` / `.d.mts` (their state machine is ported first), `person-onboarding-ui.test.ts`, and the kit tests at `organization-authority-release-record.test.ts:1450-1764`.
- The app and Mac branches of the kit builder and verifier (about 210 lines). The rest becomes the operator CLI kit.

**Kept and changed:**
- The Linux kit script and its tests become the operator CLI kit (darwin-arm64 and linux-x64).
- `person-onboarding-smoke.mjs` is rewritten.

**Release record:** no change (`tools/clean-v1-release.mjs:76-89`). The Authority needs no change [RR §2].

**Retired schemas:**
- `echo-overlay-build-identity-v1`
- `echo-person-onboarding-app-v1`
- the app fields of the kit manifest (`desktop_app_archive_sha256`, `create-person-onboarding-kit.mjs:345-361`)

The operator kit keeps the Linux kit's existing manifest kinds.

**New schemas:**
- `echo-desktop-build-identity-v1`, inside each app.
- `echo-desktop-release-v1`: one per release, written by the release lane against the accepted record. It is canonical JSON, never replaced once published (`create-person-onboarding-kit.mjs:437-445`), and Ed25519-signed if 7b ships.

**What the operator sends:**
- To each person: the OS installer, the `desktop-release.v1.json` digests over the private channel, and the invitation.
- To the owner: also the operator CLI kit.

---

## Appendix

### A. Parity rows by phase

| Phase | Rows |
|---|---|
| 1 (slice) | H1, H3, AK1, AK4, C1, C3, C4, C10 (text, Only me) |
| 2 (P0 plus pulls) | H1–H5, H7–H13, H16–H18; PP1–PP6, PP8–PP12; SR1–SR3, SR5–SR11; AK1–AK16; C1–C17; AP2–AP6; AC1 (minimal); tray skeleton |
| 3 (P1) | H6, H15; PP7, PP13; SR4; PS1–PS8; NP1–NP8; AC1 (full)–AC7; OP1–OP6; SL1–SL4; OB2–OB6 (OB1 waived); AP1, AP7–AP9 |
| Dropped | H14 (per [ADR-0015](../decisions/ADR-0015-global-and-project-scoped-person-ask.md); `projects.swift:4241-4244`) |
| 4 | R1 (via `build-echo-desktop.mjs`), R3 (per-OS architecture check in `--smoke`). R2 replaced by the OS installer plus `desktop-release.v1.json`, and R4 has no separate Setup; both waived with reason |
| 5, 6 | Phase 2 and 3 specs re-run on the Linux and Windows legs; §0b exceptions apply |

**Safety rows by phase:**
- Phase 1: SF1–SF6, SF9, SF10, SF12, SF18–SF20
- Phase 2: SF7, SF8, SF11, SF13–SF17
- Phase 3: SF21

**Do not port:**
- The dead first-name label (`main.swift:1121,1846-1875`).
- `--show-ask`; `--show` is implemented instead.
- The hand-built Edit-key overrides (`projects.swift:1948-1966`, `people.swift:382-403`).
- `NSRunningApplication` retirement.
- The Swift validators, the 3 status decoders and the 5 hard-coded CLI paths.

### B. Where each proof mode goes

| Family | New home |
|---|---|
| P scen: round-trip, unsupported, inaccessible, uncertain-mutation, restart-recovery, restart-create, malformed-recovery, recovery-store-failure, switch-account (fence half), uncertain-overflow | `host-projects.test.ts` |
| P scen: switch-project, account-clear, pagination, demoted, switch-account (UI half) | `tests/desktop/store.test.ts` |
| P cli-* | `host-projects.test.ts` (real client, fixture fetch) |
| P parse | one negative case per class in the host; the rest stays in the codec tests |
| P ui-* | `projects.spec.ts`. The New-project steps of ui-back and ui-home-back are split into Phase 3 cases; the owner-People step of ui-search-controls is dropped with H14 |
| U session | `host-uploads.test.ts` |
| U window* | `capture.spec.ts`, plus drop cases for a symlink, a folder and a virtual file |
| D (17 modes, newly in CI) | `host-documents.test.ts`, including SF2 (expected account on upload, retry, link change and replay); download and pagination also in ui-documents |
| S parse modes | `host-ask.test.ts`; large-source (display truncation) goes to `store.test.ts` |
| S UI modes | `ask.spec.ts` |
| E (28) | `host-people.test.ts`; private-folders uses the owner-chosen folder |
| A tools-fixtures, login-read, origin-app | `host-account.test.ts` |
| A pins, O pins, B | retired; the source-assembly gate, the identity provenance test and the boundary bans replace them (SF16 now proven by the clipboard ban plus `security.spec.ts`) |
| O installer tests | retired with the Mac kit; `--smoke` and codesign cover R3 |
| OB (15) | `host-first-run.test.ts` (logic from `person-onboarding-ui.mjs:138-224`) |
| new | `broker.test.ts`, `security.spec.ts`, `first-run.spec.ts`, conceal real-event specs |

### C. IPC allowlist, per window

All byte bounds live in `src/shared/methods.ts`. The largest are `updates.submit` (16 KiB) and `clipboard.writeAnswer` (12,000 characters). Handles are opaque, single-use, expire after 10 minutes, and are bound to the window that asked for them.

- **Main window:**
  - Host methods:
    - `app.status`, `account.logout`
    - `signin.begin{authority_url | invitation_handle}`, `signin.cancel`
    - `projects.list/read/members/directory/addMember/setMember/removeMember/create/feed/search/readContext`
    - `updates.submit/status`
    - `documents.upload{file_handle,…}/retry/pending/abandon/status/read/search/download{…, save_handle}`
    - `ask.run{question, scope: {kind:'global'} | {kind:'project', project_id}}`. The scope is required and has no default. A missing or unknown scope is refused as `invalid_request` before any network call.
    - `ask.source`
    - `recovery.list/retry/abandon`
  - Main methods:
    - `dialog.openDocument` → `{handle, display_name, size}`; `dialog.openInvitation` → handle; `dialog.saveOriginal` → handle
    - `drop.accept` (from the preload's `dropFile`) → handle
    - `clipboard.writeAnswer{text}`
    - `window.openPeople`, `window.openTools`, `window.hide`, `app.quit`
    - `prefs.setSidebar{open}`
- **People window:**
  - `app.status`
  - `employees.list`, `employees.invite{name, email, folder_handle}`, `employees.reissue{…, folder_handle}`, `employees.revoke`
  - `dialog.chooseInvitationFolder`, `reveal.invitationFolder{handle}`
- **Tools window:** `app.status`, `tools.status`, `slack.connect/disconnect/cancel`.
- **Events:**
  - `account.changed{epoch, display}`
  - `signin.phase{phase, expires_at, browser_opened}`
  - `slack.phase{phase}`
  - `host.restarted`
  - `lifecycle.conceal`, `lifecycle.resume`
  - `capture.open` (which the renderer acknowledges)
- **CLI path:**
  - `signin.*` and `slack.*` run `runPersonClientCli` with these injected values: `stdout`, `stderr`, `home_directory`, `fetch`, `read_input` (always throws), and `open_authorization_url` (main's `shell.openExternal`) (`commands.ts:28-40`).
  - Every such call runs under the refresh gate.
- **Time limits, unchanged (SF10):** Ask 145 s, status 5 s, sources 15 s, projects and People 45 s, documents 720 s, Slack 80 s.

### D. Client changes [CH §3, §10]

1. Export the error envelope. The host strips its text.
2. Add a `signal` to the CLI dependencies, so that `close()` rejects `wait()` (`browser-login-handoff.ts:237-249`).
3. `PersonSessionStore.read()` returns a busy error while a claim exists (`session-store.ts:344-347`). Claims record the pid and start time (`:376-392`), which gives the stale-claim rule.
4. `personStateDirectory({env, platform, home})`.
5. win32 branches W1, W3, W4, W6, W7, W10–W12, in Phase 6.
6. Neutral wording (`commands.ts:730`; `onboarding-invitation.ts:211-213`).
7. `expected_account` on `PersonClient`. The check that `assertDocumentAccount` does today (`client.ts:438-443`) extends into `withContextSession` (`:410-431`) and the Ask, employee and tool paths. A mismatch throws `not_submitted` before sending.
8. `start` reads the build identity before `completePersonLogin`, not after it (`commands.ts:1121`), so a failed identity read can never leave a used invitation behind.

Invitations need no new reader. The host passes a private 0600 copy under `<state>/incoming/` to `start --invitation`.

### E. CI shape

- **`person-client-pack`** (ubuntu): packs the tarball once and uploads it. From Phase 4 it also absorbs the neutral steps of `ci.yml:60-149`.
- **`desktop`** matrix, with fail-fast off:
  - macOS from Phase 1; Ubuntu (xvfb and the sysctl) from Phase 5; Windows from Phase 6, which also runs `tests/person-client` on win32.
  - Each leg builds from the downloaded tarball, then runs host tests on Electron's Node, store and broker tests, Playwright, electron-builder, and `--smoke`. The macOS leg also runs codesign.
- **`desktop-assemble`:** collects the legs' artifacts and writes a *draft* `desktop-release.v1.json` against CI's synthetic record, to test its shape only. The real file is written in the release lane (`authority-staging-release.mjs`) from the accepted record and the same tarball.
- **`required-checks`:**
  - From Phase 1: `[check, person-client-package, person-client-pack, desktop, desktop-assemble, authority-container, authority-recovery-infrastructure]`.
  - At Phase 4: `person-client-package` is dropped.
  - Each time, `ci.yml:408`, `ci-workflow.test.ts:69-82,170-180` and `RB-OPERATIONS-003:78-85` are edited together.

### F. `desktop-release.v1.json`

```
{ kind: "echo-desktop-release-v1", release_id, source_sha, release_record_sha256,
  product_version, person_client_artifact_sha256, electron_version,
  artifacts: [{ platform, architecture, file, sha256,
                format: "zip"|"nsis"|"deb",
                signing: "adhoc"|"developer-id"|"authenticode"|"none" }] }
+ detached Ed25519 signature (7b only)
```

### G. Docs to rewrite

**Phase 1:**
- A new ADR superseding ADR-0002's storage clause (`:244-245`).
- `README.md:30`
- `docs/architecture/identity-and-onboarding.md:45`
- `docs/architecture/person-client-architecture.md:28`
- `deploy/release/README.md:1068`

**Phase 4:**
- `deploy/release/README.md:703-875, 877-962, 1013-1077`
- `docs/architecture/person-client-architecture.md:55-65,109,172,213-255`
- `docs/architecture/organization-workspace-boundaries.md:39-45`
- `docs/invariants/INV-ADAPTERS-005…:14,70-74`
- `docs/components/operations-release.md:58-63`
- `docs/components/README.md:71`
- `RB-OPERATIONS-003:78-85`
- `PB-OPERATIONS-001:92-106`
- `onboard-clean-v1.sh:2090-2128` and its `README:484`
- The pins in `authority-operator-playbook.test.ts:33-39` and `organization-authority-deployment-profile.test.ts:482-612`
- Re-aim `workspace-boundaries.test.ts:1213-1222` and `github-governance.test.ts:51` at the desktop and Slack desktop paths

### H. Test caps (enforced by `desktop-test-budget.test.ts`)

| File | Cap (lines) |
|---|---|
| host-projects | 500 |
| host-uploads + host-documents | 550 |
| host-ask | 250 |
| host-people | 350 |
| host-account + host-first-run | 350 |
| host-refresh + canary | 200 |
| store.test | 600 |
| broker.test | 250 |
| projects.spec | 1,200 |
| capture.spec | 600 |
| ask.spec | 600 |
| security.spec + first-run.spec | 250 |
| mock-authority.mjs | 400 |
| Windows port tests | 300 |
| latency harness + smoke | 450 |
| updater tamper test (7b) | 150 |
| **Total** | **~7.2k** |

Fixture JSON under `desktop-v1` is capped at 60 files. It is authored from the `organization-api` codec test data (0.5–1 ew, spread across Phases 1–3).

### I. Capture latency and focus harness

- **Injection.** `tools/echo-capture-latency/` sends the chord, then types a sentinel at 0, 30 and 60 ms:
  - macOS: `CGEventPost`
  - Windows: `SendInput`
  - X11: `xdotool`
  - Wayland: by hand
- **Measurement.** A test build logs when the chord arrives and when the first input reaches the body. The score is the time to the first sentinel character in the body, plus the number of lost characters.
- **Conditions:** at least 100 runs each for:
  - right after launch
  - warm, after a hide
  - after 10 minutes hidden
  - after an app switch away from a concealed Ask page
- **Gates:**
  - Zero lost characters and 100% focus on arrival on macOS, Windows, X11 and KDE.
  - p95 at most Swift + 30 ms on macOS, with the same absolute budget on Windows.
  - GNOME Wayland is measured, not gated.

### J. Estimate roll-up (engineer-weeks)

| Phase | Low | High | Cumulative (low–high) |
|---|---|---|---|
| 0 Spike | 1.5 | 2.5 | 1.5–2.5 |
| 1 Foundation | 5 | 7 | 6.5–9.5 |
| 2 Mac P0 | 4.5 | 6.5 | 11–16 |
| 3 Mac P1 | 2.5 | 4 | 13.5–20 |
| 4 Cutover + operator kit | 1.5 | 2.5 | 15–22.5 |
| 5 Linux (incl. Electron upgrade) | 2 | 3 | 17–25.5 |
| 6 Windows | 2.5 | 4 | 19.5–29.5 |
| 7a Notarization | 0.5 | 1 | 20–30.5 |
| 7b Auto-update (optional) | 2 | 3 | 22–33.5 |


---

## Changes from review

- **Operator lane.** An operator CLI kit (bundled Node, darwin-arm64 and linux-x64) replaces both old kits at Phase 4. The operator text, playbook and pins are rewritten in the same PR, and `slack-link` moves into the app.
- **Host packaging.** The host is no longer bundled; the client package ships unbundled from the tarball. `start` reads the identity before installing the session (client change 8). A first-run spec and the identity read in `--smoke` prove it.
- **SF2.** `expected_account` is added in the client, sign-in and sign-out wait for writes, and SF2 is a Phase 1 exit test.
- **Linux updates.** Phase 7 is split into 7a (notarize) and 7b (optional auto-update with an Ed25519-signed manifest and a compiled-in key). Linux updates are notify only, and the bucket is public and holds no credential.
- **Capture gate.** An injector harness with at least 100 runs per condition, lost-character and focus gates on every OS, re-run at 5 exits. The capture flow is specified (always-mounted compose, acknowledge then show). Swift and Electron are measured apart.
- **Estimates.** Re-baselined to 22–33.5 ew (Mac cutover at 15–22.5). Phase 1 is now 5–7 ew, and the tray and conceal work moved to Phase 2.
- **Phase gates:**
  - Phase 0 requires green only on macOS and Ubuntu, plus a fused Windows NSIS build with a tamper check.
  - Phase 2 pulls AK16, PP5 and a minimal AC1; the New-project steps are split into Phase 3.
  - H14 is dropped in favour of the 2026-09-23 doc.
  - Every SF row now has a phase.
- **Linux kit breakage.** Phase 4 edits `create-person-onboarding-kit.mjs:4,235` and `linux-person-kit.test.ts:132` and rewrites the smoke.
- **Fixtures.** A route-keyed `desktop-v1` fixture set is budgeted. The test hook injects `fetch` and `now`, is compiled out of release builds, and `--smoke` checks it is absent.
- **Test isolation.** State and userData overrides are mandatory in tests, and the canary checks that the real folder is never opened.
- **Environment.** Main resolves the state folder and passes it in; the environment allowlist is stated; the resolver is a pure function.
- **Refresh.** No kill or quit during a refresh, CLI-path calls run under the gate, and claims are pid-stamped with a defined stale outcome.
- **Slack view.** It moves to its own `providers/slack/desktop` workspace.
- **Toolchain.** tsconfigs, eslint globs, the `@types/node` override, the binary-download skip in every workflow, and the workspace pin.
- **Release manifest.** The tarball is packed once, `desktop-assemble` is a required job, and the real manifest is written in the release lane.
- **Electron and Node end of life.** Two Electron upgrades are budgeted (one before Phase 5, for the tray fix). Node 24 is placed outside the program with an owner and a deadline.
- **Executable name.** `echo-desktop`, with a coreutils check and a Capture launcher entry.
- **Errors.** Codes only, with the message table owned by the renderer. The canary is extended with sentinels, and `signin.phase` is trimmed.
- **`app://` and CSP.** Path confinement and a tighter CSP, covered by `security.spec.ts`.
- **IPC.** A per-window allowlist lists every method; dialogs return handles; `clipboard.writeAnswer` is added; the preload passes payloads only; broker tests cover each rule.
- **Ask scope.** `ask.run` requires an explicit scope with no default.
- **Drops.** Drops are vetted paths (`getPathForFile` then `lstat` in main) instead of bytes, so SF17 holds and there are no stray copies.
- **Tests.**
  - Renderer store tests are added.
  - Per-file caps are enforced, with a rule for when a cap is hit.
  - `desktop` is a required check from Phase 1.
  - App-switch hiding has a written rule and a real-event test on each CI leg.
  - Chords fall back through a candidate list with an honest label.
- **Lows:**
  - The folder picker is kept for invitations.
  - The SF16 clipboard ban is added.
  - The native addon, if needed, is written in Objective-C++.
  - The asar-integrity reasoning is corrected.
  - The ADR-0002 docs sweep is added.
  - The invitation goes to `start` as a private copy.
  - Notarization (7a) can move up to right after Phase 4.
