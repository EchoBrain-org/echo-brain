# ECHO desktop (Electron): known gaps

Prepared 2026-09-24 on `feat/echo-desktop-core-loop`. The founder's direction
is "keep it as simple as possible": build a solid foundation for basic core
use now, and add features only after the Mac-specific Swift product is fully
retired. Everything below is known and deliberately not built yet. Each entry
says what a person sees today and what the fix would be when it is needed.

Core use is covered by specs against the real person client and a fixture
Authority: signing in (including the weekly re-sign-in), Home, a project's
feed of notes and documents, the reader (a note's text, a document's text
pages, Save original…, and moving an original between projects), a
project's People, Ask with sources, capturing a note or a file, resolving an
unconfirmed save or project change, the sidebar, the bar's scope chip and
live matches, New project (its people and files), People & invites for
owners, the Account menu (in the window and the tray), and signing out or
switching account.

## Capture and files

| Gap | What happens today | Fix when needed |
| --- | --- | --- |
| File names in decomposed Unicode (NFD) | A file named with decomposed accents, for example one copied from an old HFS+ volume, is refused: "That cannot be sent." The API accepts only NFC names and titles. | Normalize the file name and title to NFC in the person client before upload. That is a shared client change. |
| Kept upload copies are capped at 10 | An unconfirmed upload keeps a private copy for `documents retry`. Start over removes it (`documents abandon`), and Sign out and Switch account wait until it is settled, but Quit Anyway, a crash, or the account changing from the terminal while it is unconfirmed leaves it behind. After 10, every new upload fails with `snapshot_limit`, shown as "Something went wrong." | Give `snapshot_limit` its own message, and reconcile `documents pending` at launch. |
| The unconfirmed-save record lives in memory | After Quit Anyway or a crash, nothing reminds the person about a save, a project change or a new project that may not have arrived. The quit dialog warns first ("A project change may not have finished."). The Swift app kept an unconfirmed project change (a create included) in its preferences and offered Retry after a relaunch. | Persist the pending request id (and, for a project change, the change) and show it again at launch. |
| Drafts are not kept across quit | Escape keeps a draft only while the app runs. | Persist drafts locally, only if people ask for it. |
| ⌘⇧E with ECHO in front on a project page | A new capture starts on Only me, as it does from another app. The Swift app started it on the project on screen. ⊕ and the sidebar's Capture do start on the project. | Have main tell the page whether its window was in front when ⌘⇧E was pressed. |
| ⌘⇧E while New project is open | ECHO comes forward on New project, which stays open so files dragged from Finder land on it; Capture does not open over it. | Open Capture once New project closes, if people ask for it. |

Capture from the design canvas also needs server work, and is not built:
an Undo on the "Saved" toast (deleting or undoing a save), narrowing who can
read something after it is saved, and a note plus a file in one save. The
toast has no Undo, and the Organization choice warns inline instead.

## Projects and Ask

| Gap | What happens today | Fix when needed |
| --- | --- | --- |
| Live matches leave documents out | A project's documents show in its feed and open in the reader, but the bar's live matches find notes only. The Swift app's all-context results also listed documents (`documents search-v2 --query`). | Search documents beside the notes in `search.run`, and open a document match in the reader. |
| Link changes have no Undo | Remove from this project and Add to project are instant, and each reverses the other, but the toast after them offers no Undo, as the proposed design had. The Swift branch had none either. | Put Undo on the toast: the opposite link change, under a new request id. |
| People are added after Create | New project takes a name and files first; Add someone appears once the project exists, as in the Swift app, because the directory only searches within a project. The design canvas showed people before Create. | An organization-wide directory in the API. |
| Live matches stop at 10 | The bar shows the first 10 matches, with no More. In all context those are your newest saved notes (V3) first, then older ones (V2); each version is searched on its own. The Swift app paged a project's search with "More results". | Add More with the search cursor when someone misses a match. |

## Account and sign-in

| Gap | What happens today | Fix when needed |
| --- | --- | --- |
| An employee change whose outcome is unknown | Invite, reissue and revoke carry no request id, so Try again could issue a second invitation or cancel the first. As in the Swift app, People & invites empties its list and says what may have happened; Refresh, or coming back to ECHO, reads the list again and settles it. An invitation that did land is in the folder the owner chose. | Request ids for employee changes in the API, then Try again. |
| Reissue is confirmed in the save dialog | Reissue invitation… opens the save dialog, whose message says the previous invitation stops working; Cancel there changes nothing. The Swift app asked "Replace invitation for …?" before its folder picker. | Ask first as well, if an owner reissues by mistake. |
| Connected tools only reads | Connected tools… lists the organization's tools and whether your own account is linked, as the Swift window did, but it has no Connect Slack or Disconnect Slack. That needs the Slack browser link flow (`slack-connect-begin`, polling `slack-connect-status`, `slack-connect-cancel`) and a confirmed `slack-disconnect`. | Port the Swift Slack controller's flow when someone needs to link Slack from the app; the terminal commands work meanwhile. |
| An invitation file that is not private | Open invitation… needs the owner's file as exported: owned by you, mode 0600, unchanged. A copy that lost its permissions on the way (some transfers do) is refused with "Sign-in did not finish. Try again, or ask your organization owner for a new invitation." The client's own advice (`chmod 600`) is client text, which the page never shows. | Give the client's refusal a code and say how to fix it, or have main copy the file privately first. |
| A sign-out that cannot reach the Authority | The session is removed from this computer and the window shows sign-in, but nothing says the Authority did not end it there. The refresh token is gone from this computer, so it expires unused. The Swift app said "Account status was not verified." | Report the client's failed revocation on the signed-out page. |
| No Cancel while waiting for the browser | A closed sign-in tab means up to 10 minutes before "Sign-in did not finish." | Add Cancel. The client's loopback wait must be made abortable. |
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
| Shortcut conflicts are not detected | If another app holds ⌘E or ⌘⇧E, both apps respond. This mattered only while Swift ECHO ran. | Detect the known holder, or register one alternative chord. |
| A tiny exit window | Electron could still show its main-process error box if a late macOS notice lands in the last 10–20 ms of exit. It was never seen in more than 300 runs after the quit fix. | Install an error handler for the exit period if it is ever seen. |

## Retirement and release

- **Swift retirement in code.** Deleting `product/echo-overlay` and
  `product/echo-onboarding`, making the onboarding kit CLI-only, and adding a
  desktop CI job all wait for the founder's explicit go-ahead. The installed
  Swift app was retired from the founder's Mac on 2026-09-24, and its bundle
  is in the Trash.
- **Unmerged branch.** The branch is not pushed or merged. It needs a PR, and
  the Electron app needs a CI job before main runs its tests.
