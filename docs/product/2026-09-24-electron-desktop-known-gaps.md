# ECHO desktop (Electron): known gaps

Prepared 2026-09-24 on `feat/echo-desktop-core-loop`, and checked again on
2026-09-25 against every flow in the design canvas and every visible
capability of the Swift branch (`feat/overlay-flow-refinement` at `07a7ce8`).
The founder's direction is "keep it as simple as possible": build a solid
foundation for basic core use now, and add features only after the
Mac-specific Swift product is fully retired. Everything below is known and
deliberately not built yet. Each entry says what a person sees today and what
the fix would be when it is needed.

Core use is covered by specs against the real person client and a fixture
Authority: signing in (including the weekly re-sign-in), Home, a project's
feed of notes and documents (and its place when you come back to it), the
reader (a note's text, who can read it, a document's text pages, Save
original…, and moving an original between projects), a project's People,
Ask as a thread with sources and Copy answer, capturing a note or a file
and choosing who can read it (with a few projects or twenty), dropping a
file on a project row, the Capture sheet or the window, resolving an
unconfirmed save or project change, the sidebar, the bar's scope chip and
live matches, New project (its people and files), People & invites for owners
(from the sidebar or the tray), the Account menu (in the window and the tray),
reopening ECHO while it runs, and signing out or switching account.

## Capture and files

| Gap | What happens today | Fix when needed |
| --- | --- | --- |
| One project per capture | Capture files a note or a file in one project at most: the one picked in Who can read, or the project Capture was opened for. The Swift app's picker filed it in up to 20 projects at once, readable by "Members of selected projects". | Let Who can read pick several projects, and send them as `--association-project-ids-json` (and `--audience projects` with `--audience-project-ids-json` for their members). The client already takes both. |
| Only me in another project | A project in Who can read means its members can read the capture, and files it there. Only me and Organization file it in the project Capture was opened for (the page's, or the row a file was dropped on), or in none. To keep a private note filed in another project, open that project first. | A separate "filed in" choice, if people ask for one. |
| Find a project sees only loaded projects | Past eight projects, Find a project narrows the pills to the names that contain what is typed, among the projects loaded so far: Home's first page, and each page More projects adds. A project on a later page shows only after More projects. When nothing matches, only Only me and Organization are left, and nothing says so. | Read the remaining pages as someone types, or search project names in the API. |
| No Discard | Escape or Close puts a draft away, and ⌘⇧E or ⊕ brings it back; nothing throws it away in one step. You clear its text or remove its file. The Swift app asked "Discard this note?" when a draft was closed. | Add Discard to Capture, if people want to drop a draft in one step. |
| File names in decomposed Unicode (NFD) | A file named with decomposed accents, for example one copied from an old HFS+ volume, is refused: "That cannot be sent." The API accepts only NFC names and titles. | Normalize the file name and title to NFC in the person client before upload. That is a shared client change. |
| Kept upload copies are capped at 10 | An unconfirmed upload keeps a private copy for `documents retry`. Start over removes it (`documents abandon`), and Sign out and Switch account wait until it is settled, but Quit Anyway, a crash, or the account changing from the terminal while it is unconfirmed leaves it behind. After 10, every new upload fails with `snapshot_limit`, shown as "Something went wrong." | Give `snapshot_limit` its own message, and reconcile `documents pending` at launch. |
| The unconfirmed-save record lives in memory | After Quit Anyway or a crash, nothing reminds the person about a save, a project change or a new project that may not have arrived. The quit dialog warns first ("A note may not have been sent.", "A project change may not have finished."). The Swift app kept an unconfirmed save or project change (a create included) in its preferences, and offered Check status or Retry after a relaunch. | Persist the pending request id (and, for a project change, the change) and show it again at launch. |
| Drafts are not kept across quit | A draft put away is kept only while the app runs. | Persist drafts locally, only if people ask for it. |
| ⌘⇧E with ECHO in front on a project page | A new capture starts on Only me, as it does from another app. The Swift app started it on the project on screen. ⊕ and the sidebar's Capture do start on the project. | Have main tell the page whether its window was in front when ⌘⇧E was pressed. |
| Capture after losing a project | While Capture is open, its pills keep their places when the window comes forward and the list is read again: a project new to the list joins at the end, and one the list no longer has keeps its pill until Capture closes. A draft filed in a project keeps that project's pill even while Capture is hidden. Saving to a project whose access was lost fails. The Swift app cleared such a draft and closed Capture when project access changed, unless its save was unconfirmed. | Clear and close a draft filed in a project the refreshed list no longer has, unless its save is unconfirmed, and turn off a lost project's pill where it is. |
| No drop outline on the whole window | While a file that would be taken hovers, project rows and the Capture sheet light up, but the rest of the window takes the drop with no outline. The Swift app drew a 1 pt gold border around the content area. | Outline the content area while such a file hovers, if people miss where a drop will land. |
| ⌘⇧E while New project is open | ECHO comes forward on New project, which stays open so files dragged from Finder land on it once the project is created; Capture does not open over it. | Open Capture once New project closes, if people ask for it. |

Capture from the design canvas also needs server work, and is not built:
an Undo on the "Saved" toast (deleting or undoing a save), narrowing who can
read something after it is saved, and a note plus a file in one save. The
toast has no Undo, and the Organization choice warns inline instead.

## Projects and Ask

| Gap | What happens today | Fix when needed |
| --- | --- | --- |
| Live matches leave documents out | A project's documents show in its feed and open in the reader, but the bar's live matches find notes only, in all context and in a project. The Swift app's results also listed documents (`documents search-v2 --query`, with `--project-id` in a project). | Search documents beside the notes in `search.run`, and open a document match in the reader. |
| Coming back does not read the project again | After another app was in front, a project page shows the rows and the original it had, in the same place. ECHO reads the account and the bar's matches again on return, but the project only on the next open, More, Try again or save. The Swift app read the project, its list and the open item again, and went Home if the project no longer opened. | On return, read the feed's first pages quietly (as after a save), and go Home when the project is refused. |
| Link changes have no Undo | Remove from this project and Add to project are instant, and each reverses the other, but the toast after them offers no Undo, as the proposed design had. The Swift branch had none either. | Put Undo on the toast: the opposite link change, under a new request id. |
| People are added after Create | New project is one page: a name and Create, then People, then Files (optional). People and Files show from the start but turn on only once the project exists, because the directory only searches within a project; a file dropped before Create is refused ("Create the project first."). The design canvas showed people before Create. | An organization-wide directory in the API. |
| Ask leaves out some Swift details | A question sent while another is on its way waits in the bar with send disabled, and nothing says why. The Swift app said "ECHO is still answering your earlier question." Cancel shows no "Cancelled" line. Chips name the meeting without the Swift app's date ("1  Tuesday sync", not "· Sep 15, 2026"). A failed question offers Try again only when trying again can help; the Swift app offered Retry after every failure. An original's evidence is read again each time its chip is chosen; the Swift app kept it for the answer while the window had focus. The source pane always sits beside the answer and narrows with the window, so Escape or Back leaves the whole thread; below 1,000 px the Swift app covered the answer with the pane, and Back closed the pane first. | Add the status lines, the date or the evidence cache if people miss them. |
| Live matches stop at 10 | The bar shows the first 10 matches, with no More. In all context those are your newest saved notes (V3) first, then older ones (V2); each version is searched on its own. The Swift app paged a project's search with "More results". | Add More with the search cursor when someone misses a match. |
| No clear button in the bar | Escape empties the bar's text and its matches. The Swift app also showed a small × (Clear search) while the bar had text. | Add the × if people look for one. |
| No "Not live yet" | An Authority without the projects API refuses the list, and Home shows a failure with Try again. The Swift app read that 404 as "Projects · Not live yet" and turned New project off. The founder's Authority has projects. | Give a not-found project list its own state, if an older Authority is ever used again. |

Two ideas from the proposed direction were not built here, nor on the Swift
branch: Home as "recent across projects" (Home lists your projects, the
founder's Messages-style list), and typing `@project` to narrow the bar (a
click on a project in the sidebar narrows it).

## Account and sign-in

| Gap | What happens today | Fix when needed |
| --- | --- | --- |
| An employee change whose outcome is unknown | Invite, reissue and revoke carry no request id, so Try again could issue a second invitation or cancel the first. As in the Swift app, People & invites empties its list and says what may have happened; Refresh, or coming back to ECHO, reads the list again and settles it. An invitation that did land is in the folder the owner chose. | Request ids for employee changes in the API, then Try again. |
| Reissue is confirmed in the save dialog | Reissue invitation… opens the save dialog, whose message says the previous invitation stops working; Cancel there changes nothing. The Swift app asked "Replace invitation for …?" before its folder picker. | Ask first as well, if an owner reissues by mistake. |
| Connected tools only reads | Connected tools… lists the organization's tools and whether your own account is linked, as the Swift window did, but it has no Connect Slack or Disconnect Slack. That needs the Slack browser link flow (`slack-connect-begin`, polling `slack-connect-status`, `slack-connect-cancel`) and a confirmed `slack-disconnect`. | Port the Swift Slack controller's flow when someone needs to link Slack from the app; the terminal commands work meanwhile. |
| An invitation file that is not private | Open invitation… needs the owner's file as exported: owned by you, mode 0600, unchanged. A copy that lost its permissions on the way (some transfers do) is refused with "Sign-in did not finish. Try again, or ask your organization owner for a new invitation." The client's own advice (`chmod 600`) is client text, which the page never shows. | Give the client's refusal a code and say how to fix it, or have main copy the file privately first. |
| A sign-out that cannot reach the Authority | The session is removed from this computer and the window shows sign-in, but nothing says the Authority did not end it there. The refresh token is gone from this computer, so it expires unused. The Swift app said "Account status was not verified." | Report the client's failed revocation on the signed-out page. |
| No Cancel while waiting for the browser | A closed sign-in tab means up to 10 minutes before "Sign-in did not finish." The Swift Account menu had Cancel sign-in. | Add Cancel. The client's loopback wait must be made abortable. |
| Browser launch is not confirmed | Main never reports whether `shell.openExternal` actually opened a browser, so with no default browser the page waits. | Reply from main to the host with the result. |
| An organization address with a path | `https://host/login` is refused with the generic "Sign-in did not finish." | Say that the address is wrong. |
| A process killed mid-refresh | Its refresh claim stays behind, and the person is signed out until they sign in again. Quit waits up to 5 s for a refresh in progress, which avoids this for the app itself. | Recover a stale claim on its deadline, or restore it in the client. |

People & invites from the design canvas also needs server work, and is not
built: an emailed invitation link in place of the private folder the owner
sends, and finding the organization from the email address at sign-in.

Refresh rule, for reference: a refresh whose request never left the machine
(no connection was made) keeps the session. Any other failure signs the
person out cleanly, as ADR-0002 §4 requires.

## App and platform

| Gap | What happens today | Fix when needed |
| --- | --- | --- |
| macOS arm64 only, ad-hoc signed | It is not notarized, and there are no Windows or Linux builds. | Phases 5–7 of `2026-09-24-electron-desktop-v1.md`. |
| Default Electron icon | Finder and About show Electron's icon. The Swift app had none either. | Add an `.icns`. |
| Shortcut conflicts are not detected | If another app holds ⌘E or ⌘⇧E, both apps respond. This mattered only while Swift ECHO ran. When registering does fail, only the tray says so ("⌘⇧E is used by another app"): the sidebar's Capture row still shows ⌘⇧E, where the Swift app hid it. | Detect the known holder, or register one alternative chord. Tell the page whether ⌘⇧E was registered, and show the hint only then. |
| A tiny exit window | Electron could still show its main-process error box if a late macOS notice lands in the last 10–20 ms of exit. It was never seen in more than 300 runs after the quit fix. | Install an error handler for the exit period if it is ever seen. |

## Retirement and release

- **Swift retirement in code.** Deleting `product/echo-overlay` and
  `product/echo-onboarding`, making the onboarding kit CLI-only, and adding a
  desktop CI job all wait for the founder's explicit go-ahead. The installed
  Swift app was retired from the founder's Mac on 2026-09-24, and its bundle
  is in the Trash.
- **Unmerged branch.** The branch is not pushed or merged. It needs a PR, and
  the Electron app needs a CI job before main runs its tests.
