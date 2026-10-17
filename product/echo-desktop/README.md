# ECHO desktop

The app shares its TypeScript client, host, renderer and Electron main process
across macOS and Linux. Packages currently target macOS arm64 and Linux x64.
Windows packaging is not implemented.

Global Ask includes live Jira reads through the person's connected account and
shows ticket citations that open directly in Jira. Project Ask includes Jira only through a saved project mapping. Mine excludes Jira.

While a global or project Ask works (ADR-0039), one line says what it is
doing (Searching, Reading, Checking access, Writing) beside its timer and
Cancel. Under it, at most three rows say what it searched ("Searched meetings
and Jira · 22 found", source kinds, never the words searched) and what it read
("Read Tuesday sync, ECHO-48 +2"), each item named only after ECHO checked you
may open it. The first three seconds look as they always did, and an Authority
that sends no steps keeps "Thinking…". When the answer comes, the rows fold
into one line above it, "Looked through 14 items · 48s", which opens the rows
the Authority audited. Cancel, a timeout or a refused answer removes them all.

Every name, and every source of an answer, opens beside Ask, which keeps
working: a meeting's decision, action or rationale opens its meeting with that
item lit; a note, document or imported meeting its cited passages; a
transcript its meeting; a Jira ticket, Confluence page or Slack message its
"Open in …". Once the answer has come, **Open** goes to the item's own page in
the reader (leaving Ask, so it is hidden while Ask works).

Home shows only what waits on you, under **Needs you**. Each row is one of:

- **Approve**: a meeting waiting for your decision. Its card shows what was
  decided, numbered (a decision still proposed or unresolved says so), and
  what is to be done, with a due date when the meeting set one and an owner
  you can retype where ECHO proposed one; what was said in the meeting, and
  the reasons given, open on demand. On the right sit **Seen by** (Only me or
  projects; it starts on the projects the meeting suggests, ticked, when any
  is one of your active projects), transcript sharing, **Approve** (off while
  Projects is chosen and none is ticked) and **Reject**, and who was in the
  meeting. The card reads the proposal text the Authority sends, where every
  line after the first of a text or quote is indented, so the meeting's own
  words never read as another item; a text it cannot read shows as written.
- **Checking**: a meeting you approved, while its record publishes and its
  impact check runs. It has no action and is not counted.
- **Check failed** (verb **Retry**): "Approved · the check did not finish". It
  opens the decision with the reason and **Try again**; once the check
  finishes, the page shows the meeting's follow-ups in one line ("Follow-ups ·
  4 not sent"), the whole line opening their list.
- **Send**: a meeting you approved has follow-ups not sent yet ("Launch the
  pilot next week — 4 follow-ups to send"). It opens that meeting's
  follow-ups.
- **Update**: a follow-up that waits on you as its owner: sent to you, or left
  to you because the people ahead of you have left. **Review**: one someone
  else owns that ECHO saw change since you sent it, and that still doesn't
  match. Each row has up to three lines: the title ("ECHO-12 · Pilot launch";
  a meeting's action is its own words), for a document what it says now and
  what the meeting needs ("Due Oct 30 → decision needs: launch next week"),
  and, muted, what it is, its meeting and whose it is ("Jira ticket · Pilot
  planning meeting, approved Oct 6 · Mina's to update"). The whole row opens
  the follow-up's page; nothing on Home closes an item.

Home shows each part as soon as it is read, so quick rows never wait for slow
ones: the tools are read beside everything else (only the meeting reviews wait
on them), and what waits on you is read first from ECHO's own fields alone,
which shows its rows at once, and then, only while Home itself shows (not
under a follow-ups list or page), with each document opened live in its tool;
back on Home after a change, only the rows new to it are read live. Until a
row's live read answers, a document's title says what it is and its meeting,
faintly ("Jira ticket · Pilot planning"); then its title and what it says now
fill in. A live read that fails shows no error: those rows say "A Jira ticket
ECHO couldn't read just now".

A follow-up is an action the approved meeting decided (a **Meeting action**)
or an existing document its impact check found the meeting affects. Each has
one status: **Not sent**, **Open**, **Done** or **Dismissed**, and every count
is by status ("1 open · 4 not sent · 2 done", whatever ECHO's last check
found). "Open" is one status only: a total of not sent and open together is
"4 follow-ups".

A **follow-ups list** is a meeting's (from its Send row, its line in the
reader, its decision page, or a follow-up's page), a project's (from the line
above its feed), or **Follow-ups**: everything you sent, own or last handed
on, in every status, from the sidebar or Home's footer (on an Authority
without that list, what you sent or own). When that list is already open
under what shows, its links go back to it, ticks and place kept, instead of
opening it again. Rows are grouped Not sent, Open, Done and Dismissed, each
group counted over the whole list, the meeting's actions first; each row
shows its title, one faint line (what it is, its meeting when the list spans
meetings, "matches now" when ECHO's last check found it so) and its owner.
Current work (Not sent and Open) shows first, a page at a time with its own
**More**, so it is never behind closed rows; Done and Dismissed show once it
is read to its end, each with a **More** of its own. A meeting's list opens
with every group open and reads them all together; Follow-ups and a project's
list start Done and Dismissed closed ("Done · 12"), and a group's rows are
read only once it opens. Each page shows at once from ECHO's own fields, and
then that page is read live, its documents faintly named ("Jira ticket ·
Pilot planning") until the read answers; live reads wait while another app is
in front. A read of rows that fails says so, and **Try again** repeats that
read; a live read that fails only leaves its rows saying ECHO couldn't read
them just now. A meeting's list says when it was approved:
"Approved Oct 6", a faint link to its decision page (over the list, so Back
returns to it, and its follow-ups line goes back to the list) when you
approved it. A Not sent row you may send has a tick, and a meeting's list
ticks them all when it opens; **Send N** sends the ticked rows to their
owners and **Dismiss N** dismisses them, the rest stay Not sent. The owner
chip changes the owner at once, before or after sending, from a people picker
that offers you first ("You"); a dashed **Pick owner** means ECHO found no one
(faint words when you may not pick). The list stays where it is: after a
change to one row, that row and the list's counts are read again from ECHO's
own fields only, and the row moves to its group in place; after **Send N** or
**Dismiss N**, the list's rows are. Each row keeps what it last said, so a
change opens nothing in its tool, and a foot that stays at the bottom while
anything is ticked or said says what happened ("Sent to Mina", "Owner
changed to Rafael", "Sent 2 · 1 not sent, try again"), taking the focus when
the button that had it went; a picker that closes hands the focus back to its
owner chip. A send whose reply was lost is settled by that read: one that
went says so, one that did not replays the same send on Send again. A
meeting's or a project's list has a faint **Check now** while something is
open: it re-checks their open items, shows "Checking…" until the check ends
and reads the list again ("Check failed · Try again" when it fails); any
other read of the list clears what it said.

A row opens the **follow-up's page**: its title and status, what it is and
the meeting it came from ("Meeting action · from Pilot planning, Oct 6",
which opens or goes back to that meeting's list; "Sent by Mina" when you
cannot read the meeting), for a document why it is here (what it says now,
with the tool's status, due date and assignee in one faint line, beside what
the meeting decided, and **Open in Jira** when ECHO opened it for you), its
history (found; sent to its owner or dismissed at Send; its owner set; done,
dismissed, reopened, or sent later for one Send dismissed; and by whom),
ECHO's last check in one faint line, its owner, and one next step: **Send to
Mina** (or **Keep it myself**) and **Dismiss** while it is not sent, **Mark
done** and **Dismiss** while it is open, **Reopen** once closed (**Send to
Mina** for one Send dismissed and nothing reopened since). The page shows
its row at once (the row it was opened from, with what that list or Home read
live of it, or the row the change check read for a notification), then reads it
again from ECHO's own fields, and live only while nothing says yet what it
says now (never a meeting's action). After a change the page stays and says
what happened ("Done · Undo"), showing what the Authority answered at once,
then the item read again from ECHO's own fields only, keeping what it says
now; a change whose reply was lost is settled by that read. Giving an item away so you no longer see it says so,
with Back. A page whose read fails offers **Try again**, including when its row
already shows and a temporary outage prevented reading its details. Back returns to where it was opened, read again when something
changed, at the same place, with the row it was opened from in focus; Ask
and another app in front keep that place too. The window's title names the
list (Follow-ups, the meeting or the project) or the item shown.

While you are signed in, ECHO asks the Authority what moved in your own
view (the change check, ADR-0036): one fingerprint each for your projects,
the follow-ups you are involved in, and the meetings waiting for your review,
never any content. It checks at sign-in (which only learns), at the pace the
Authority sets (a minute today, 15 s to an hour, up to five minutes apart
after failures), whenever you come back (the window on screen and in front
again: from another app, the tray or the shortcut, minimized, or covered by
other windows), when you open a page (at most once in 10 s), and when the
machine wakes. At sign-in every page of your projects is read, which fills
the sidebar and is what the first check learns from. Projects moved: every
page is read again, so a project you were added to is told however far past
the sidebar's pages it sorts; the sidebar shows as many pages of that read as
it showed, the open project's header follows its row, and a project you can
no longer open goes Home, saying so. Follow-ups moved: every page of the open
follow-ups you sent, own or last handed on, and of those closed since the
newest change seen, is read again side by side, rows only; each open one is
compared with the last read, one that left them is settled by the closed
read or else read by its id, and one sent and closed between two checks is
told. Then whatever shows of them (Home, Follow-ups, an item page, a
project's or a meeting's line) is read again quietly. Reviews moved: Home
and the decision page. Coming back reads the page on screen again once, with
what its check found moved (and the sidebar, when its last read failed or
the check could not say whether projects moved), keeping what it shows. While the window is hidden, minimized or covered, or
another app is in front, checks go on, and what shows is read once it can be
seen. An Authority without the change check: ECHO scans what you sent or own,
rows only, every five minutes and on wake, and notifies what someone else did
among them; the sidebar is read again on each return, and Follow-ups lists
what you sent or own.

What someone else did to a follow-up you are involved in (handed to you, done,
not relevant, reopened, or handed on, for one you sent or last handed on) and
being added to a project come as one system notification per check ("Mina
handed you Pricing page", "3 follow-ups changed", "You were added to
Comet"). Your own changes from any device, checks, meetings and reviews,
removals and role changes never notify, and neither does an item whose page
is open while you look at it (its page is read again instead). Clicking a
notification brings the window forward and opens that item's page, a list of
exactly the follow-ups a summary counted (at most 100, each read again by its
id, one you can no longer read left out), or the project; only what this
account was told of opens, and a sheet or Capture that is up stays.
desktop.log records `lifecycle conceal|resume|shown|wake`, `changes moved
<areas>` (by area name only) and `changes unsupported`.

Under the rows, and on an empty Home (with no projects too), a footer says how
many items you sent wait on others and when ECHO last checked ("2 waiting on
others · ECHO checked 2 h ago"), with **Follow-ups**. An approved meeting
and a project each show a follow-ups line counted by status ("Follow-ups · 1
open · 4 not sent"), which opens that list and keeps what it last said while
it is read again; a meeting's row in a project's feed says how many of its
follow-ups are not closed ("4 follow-ups"). Home also
re-checks your own open items by itself: when the Authority says they are
due, Home asks for a sweep and starts it after any waiting impact check. A
sweep makes no Home row and changes no item's status; it only records each
item's latest verdict. A meeting's actions and items on a Slack message are
never re-checked. Projects and archived projects live in the sidebar.

Tools → Granola manages folder watching and individual meeting imports. Home and
decision content is covered while another app is in front, and is read again,
unfinished checks included, when ECHO returns.

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

Only a release package updates itself: one built with `--release`,
`--artifact` and `--update-config` as the
[release guide](../../deploy/release/README.md#desktop-release-packages)
describes.

Linux outputs are in `dist-app/`:

- `ECHO-<version>-linux-amd64.deb`: Debian/Ubuntu installer with the Electron
  runtime, dependencies, desktop launcher, sandbox integration and the update
  helper. It depends on `python3` and `openssl` and recommends `pkexec`;
  without `/usr/bin/pkexec` the updater stays off. What runs as root, or
  grants root, must equal reviewed source in `linux/`: `postinst`, `postrm`,
  the AppArmor profile, the update helper and `deb-relationships.json`.
  `postinst` never makes `chrome-sandbox` setuid, so the system must allow
  unprivileged user namespaces; Ubuntu 24.04 does through the AppArmor
  profile. `scripts/check-deb.mjs PACKAGE.deb` checks a built deb against
  `HEAD`, including
  [the rest of the deb gate](../../docs/features/client-updates-v1.md#preparing-an-approved-feed),
  such as what may sit outside `/opt/ECHO`.
- `ECHO-<version>-linux-x64.tar.gz`: the app directory for manual distribution;
  the receiving system must supply Electron's system libraries and permit its
  sandbox. It updates itself only when placed as
  [the updater requires](../../docs/features/client-updates-v1.md#desktop-app).
  Prefer the deb on Ubuntu, where the installer supplies an AppArmor profile.
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
ECHO, the first time or after a failed update, first quit ECHO from its tray
(Quit ECHO) in every seat signed in on the machine, then use `--reinstall`.
The deb installs ECHO for the whole machine, so one reinstall covers every
seat on it:

```sh
sudo apt install --reinstall ./ECHO-0.1.0-linux-amd64.deb
```

Then prove the installed build rather than its version string: run
`npm run smoke -- /opt/ECHO/echo-desktop` (described below) from the release's
clean build checkout, or check that the tray menu's `Build <sha7>` (also on the
Account menu's version line, `ECHO 0.1.0-internal.1 · 038f099`) matches the
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
In a folder it cannot write, on another volume than its settings, or when macOS
runs it from a read-only copy (translocation), ECHO still checks. When it finds
a release it shows **Move ECHO to Applications to update** right away, instead
of updating. Check that the tray menu's `Build <sha7>` matches the release's
source SHA.

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
| A release is available, but the macOS app is translocated, in a folder it cannot write, or on another volume | **Move ECHO to Applications to update** |

Select **New version · Restart** to install. ECHO won't install while it still
has unfinished work, just as it won't sign out then. It checks the update, quits
and reopens on the new version. On macOS it replaces its own `ECHO.app` without
asking for a password. On Linux the system asks for an administrator password;
a helper running as root then checks the update again before reinstalling the
package. If another person on the same Linux machine already updated ECHO, the
row also reads **New version · Restart**, and restarting uses the new version.
If you cancel the quit when ECHO asks about unfinished work, ECHO stays open.
When newer files were already installed, a later quit does not reopen it. When
ECHO had downloaded an update, the update gives up after two minutes and the
row shows **Couldn't update · Try again**.

An update fails safely:

- If you cancel the password prompt, ECHO keeps running the version you had.
- A failed background check shows nothing, and the current version keeps
  running.
- If the install fails, ECHO keeps or reopens the old version and shows
  **Couldn't update · Try again**. On Linux, a rare failure after the new files
  are unpacked reopens the new version instead.
- On macOS, a failed swap puts the previous app back. macOS App Management may
  block the swap; that keeps the old app too.
- ECHO refuses a feed older than the last one it verified, within the
  [limits ADR-0035 records](../../docs/decisions/ADR-0035-desktop-updates-from-the-signed-feed.md#consequences).
  Undoing an update takes a newer release.

After an update on macOS, you may have to grant ECHO's macOS privacy
permissions again, because each build has a new code identity.

If updating keeps failing, install the release by hand: on Linux with
`--reinstall` as in [Install and verify on Linux](#install-and-verify-on-linux),
and on macOS by quitting ECHO and replacing `~/Applications/ECHO.app` with the
release's app. A desktop installed before this change also needs this once,
with a release package, before it can update itself. Development runs
(`npm start`) and test builds never update.

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
Linux uses Xvfb and additionally checks the deb with `scripts/check-deb.mjs`
against the commit, then installs it, validates its desktop entry,
and smokes the installed executable under Ubuntu's default user-namespace
restriction, so it starts only through the deb's AppArmor profile. It then
reinstalls the deb over itself, as the update helper does, and checks that the
AppArmor profile, the root-owned helper, a non-setuid `chrome-sandbox` and the
smoke test survive. macOS
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

CI cannot show a polkit password prompt or a real macOS app swap, so the
[desktop update check](../../deploy/client-updates/README.md#verify-the-desktop-update)
still needs native macOS arm64 and Ubuntu 24.04 x64 seats.


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
