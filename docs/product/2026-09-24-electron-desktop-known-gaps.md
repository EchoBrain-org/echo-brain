# ECHO desktop (Electron): known gaps

Prepared 2026-09-24 on `feat/echo-desktop-core-loop`. The founder's direction
is "keep it as simple as possible": build a solid foundation for basic core
use now, and add features only after the Mac-specific Swift product is fully
retired. Everything below is known and deliberately not built yet. Each entry
says what a person sees today and what the fix would be when it is needed.

Core use is covered by specs against the real person client and a fixture
Authority: signing in (including the weekly re-sign-in), Home, reading a
project, Ask with sources, writing a note or sending a file, resolving an
unconfirmed save, the sidebar, the Account menu (in the window and the tray),
and signing out or switching account.

## Writing and files

| Gap | What happens today | Fix when needed |
| --- | --- | --- |
| File names in decomposed Unicode (NFD) | A file named with decomposed accents, for example one copied from an old HFS+ volume, is refused: "That cannot be sent." The API accepts only NFC names and titles. | Normalize the file name and title to NFC in the person client before upload. That is a shared client change. |
| Kept upload copies are capped at 10 | An unconfirmed upload keeps a private copy for `documents retry`. "Write new" or quitting leaves that copy behind. After 10, every new upload fails with `snapshot_limit`, shown as "Something went wrong." | Run `documents abandon` on Start over, give `snapshot_limit` its own message, and reconcile `documents pending` at launch. |
| The unconfirmed-save record lives in memory | After Quit Anyway or a crash, nothing reminds the person about a save that may not have arrived. The quit dialog warns first. | Persist the pending request id and show it again at launch. |
| Quit dialog wording | It says "A note may not have been sent." even when the item is a file. | Word it for either. |
| Drafts are not kept across quit | Escape keeps a draft only while the app runs. | Persist drafts locally, only if people ask for it. |

## Projects and Ask

| Gap | What happens today | Fix when needed |
| --- | --- | --- |
| A project page shows its 10 newest items | There is no "Older" paging. | Copy Home's More pattern, using the feed cursor. |
| No document rows or reader on a project page | Uploaded documents cannot be read in the app. | Add rows from the document feed and a text reader (`documents read-v2`). |
| Approved-decision citations cannot be opened | They show as a plain "Approved decision" row. The Swift app opened them with `person records`. | Add a record reader keyed by `record_sha256`. |
| No search on Home | Out of v1 by decision. | Add it back after Swift is retired, if needed. |

## Account and sign-in

| Gap | What happens today | Fix when needed |
| --- | --- | --- |
| No organization People admin | The owner cannot invite employees, reissue invitations or revoke access from the app. The Swift app had this in its sidebar and under the menu bar's Organization → People. | Use the operator CLI meanwhile; add a tray entry when a new person needs to join. |
| An invitation file that is not private | Open invitation… needs the owner's file as exported: owned by you, mode 0600, unchanged. A copy that lost its permissions on the way (some transfers do) is refused with "Sign-in did not finish. Try again, or ask your organization owner for a new invitation." The client's own advice (`chmod 600`) is client text, which the page never shows. | Give the client's refusal a code and say how to fix it, or have main copy the file privately first. |
| A sign-out that cannot reach the Authority | The session is removed from this computer and the window shows sign-in, but nothing says the Authority did not end it there. The refresh token is gone from this computer, so it expires unused. The Swift app said "Account status was not verified." | Report the client's failed revocation on the signed-out page. |
| No Cancel while waiting for the browser | A closed sign-in tab means up to 10 minutes before "Sign-in did not finish." | Add Cancel. The client's loopback wait must be made abortable. |
| Browser launch is not confirmed | Main never reports whether `shell.openExternal` actually opened a browser, so with no default browser the page waits. | Reply from main to the host with the result. |
| An organization address with a path | `https://host/login` is refused with the generic "Sign-in did not finish." | Say that the address is wrong. |
| A process killed mid-refresh | Its refresh claim stays behind, and the person is signed out until they sign in again. Quit waits up to 5 s for a refresh in progress, which avoids this for the app itself. | Recover a stale claim on its deadline, or restore it in the client. |

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
