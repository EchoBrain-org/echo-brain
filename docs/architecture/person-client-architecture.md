# Person client architecture

**Status:** Current

The machine-installed Person client authenticates one human to one
Organization Authority, keeps that session private, and sends bounded
authenticated requests. Meeting processing and organization data live on the
server. Other machine-installed interfaces may invoke this client, but they
are separate components with their own lifecycle and packaging boundaries.

## Composition

```text
echo-brain person <command>
  -> private Person session store
  -> pinned Authority descriptor
  -> public organization API request
  -> server-side identity and authorization
```

The client has no background runtime, adapter registry, local processor,
approval store, delivery outbox, database, installation key, access lease, or
service manager.

The opt-in [client updater](../features/client-updates-v1.md) runs a bounded
release check before command dispatch. Its public publisher trust and local
release checkpoint are separate from Person authorization state. macOS arm64
and Linux x64 CLI-kit activation reuse their platform installers; the desktop
app's updates belong to its own packaging. The standalone Mac CLI root is
separate from the retired Swift app's paired CLI. This adds no background
runtime or automatic Person-request replay.

## Desktop app

The Electron app in `product/echo-desktop` is the graphical interface, packaged
for macOS arm64 and Linux x64; it replaced the retired Swift app. Its person
host, an Electron utility process, loads this client's `composition.js` and
runs the same commands in process, as the terminal CLI would. The host is the
only process that reads the session or holds a token. It sends the app window
token-free view models and failure codes, never a sign-in URL, grant, or
provider body. Each account-scoped call is fenced: the host reads status before
and after the command and refuses the result if the account changed, reporting
a write's outcome as unknown. A packaged app carries the Person client package
produced by `tools/pack-person-client.mjs`.

The sidebar's **Mine** row, under New project, opens a page that reads
`person list --mine`
([ADR-0024](../decisions/ADR-0024-person-list-open-and-mine-scope.md)): the
notes the person saved, the files they uploaded and the meetings they approved,
newest first, each with the names of their projects it is filed in, and More
for the next page. A project page reads `person list --project`, and the reader
opens every list row and live match with `person open --ref`, joining a
meeting's split parts across pages; Ask's sources still read as described
under Ask below. On Mine the bar asks with the Mine chip, shows no
live matches and has no ⊕, and a dropped file is not taken. A save toast that
no project page shows opens Mine. A 401 on a project's list means the person
is no longer a member: the page says "This is no longer available to you." and
status and projects are read again once per visit, without signing out.
Signing out leaves Mine and clears it.

## Local state authority

The machine's authorization state is the signed-in Person session below
`~/.local/share/echo-brain/person/`. The directory is `0700`; session files are
`0600`. Refresh is single-claim: once a refresh credential is taken for a
request it cannot be replayed after an ambiguous transport outcome. Logout
removes local session authority even if the remote outcome is unknown.

The document client also retains bounded, account-scoped immutable retry
snapshots for explicitly selected uploads. These are local recovery material,
not source custody or permission authority. They cannot make a user readable on
the server, run background processing or redirect a request to another account.
The 2026-09-23 extension below defines their explicit cleanup/retry lifecycle.

Granola, Slack service, and model-provider credentials are server-owned. They
must not enter the Person session, CLI output, or package artifact.

## Identity

External OIDC establishes the human identity. The Authority binds the verified
OIDC subject and approved email to an organization principal and membership,
then issues a rotating Person session family. Each request re-resolves current
membership/session state on the server. No installation client or
installation identity mode ships in the product.

## Owner People interface

The same desktop app serves owners and employees. When the Person client's
current status identifies an owner, the app shows **People & invites** under
Organization, in its sidebar and in the menu bar icon's menu. The page lists
employee membership and invitation status, creates employee invitations,
replaces pending or expired invitations, and revokes employee access. The
employee roster does not list owner memberships.

The desktop host runs the existing `person employee` commands with literal
arguments. It adds no browser service, alternate session store, role
assignment endpoint, or server polling loop. Opening the page and **Refresh**
fetch current data. The owner chooses where an invitation is saved; the app
creates a new private folder there and the client writes the invitation into
it, to be handed to the employee separately. The page never renders invitation
contents.

Local role information controls presentation only. Every list, invite, reissue,
and revoke request reaches the existing `/v1/person/employees` API, where the
Authority resolves the current session and active membership and requires an
owner. Modifying the app or claiming an owner role in a request does not grant
that permission. Failed authorization, unavailable reads, and identity changes
clear the roster. A confirmed input rejection can retain the previously fetched
roster and explain how to correct the input. Local identity is checked again
before displaying results. Mutations are never automatically retried after an
uncertain outcome. A confirmed invitation issuance followed by a local save
failure is reported separately, so the owner can refresh and reissue it.

The invitation state **Onboarded** means the invitation was redeemed. It does
not claim that the employee is currently online or has a live device session.

## Account and answer Sources

Ask uses the agentic routes ([ADR-0022](../decisions/ADR-0022-agentic-ask-only.md));
the earlier `/v1` and `/v2/person/ask` routes are retired. The default CLI Ask and
desktop Mine Ask use `/v3/person/ask` with V4 answers. Desktop global and project Ask
selects `person ask --tickets`, using `/v4/person/ask` with V5 answers so the
person's connected Jira account can contribute live evidence when enabled by
the Authority. Ticket citations open directly in Jira; they are not retained
originals. Project leads configure one Jira project from the project settings menu;
the server validates it and bounds each project Ask to that stable Jira project ID
under the asker’s own connection. Unmapped projects never fall back to global Jira.
Ask keeps the
[global/project Ask](../features/global-project-ask-v1.md) scope rules: global
scope includes authorized originals and approved records; explicit project
scope is restricted to readable associated context. Uploaded sources remain
unapproved evidence. The source-card behavior below describes approved
records; original evidence uses its exact source/revision/representation
coordinates and a fresh authorized read.

With the Mine chip, the desktop sends `person ask --mine`: Ask reads only the
person's own notes and uploads and the meetings they approved, and no Slack or
shared transcript. A cited original from that answer is read under global scope,
which contains mine.

The desktop app's **Account** menu uses the same Person client and session
store. An existing member can sign in through Google without another
invitation; a new member chooses the private invitation file. Sign-out and
switching accounts are explicit actions that the app asks to confirm. The app
does not store another copy of credentials. A local status response alone is
not proof of organization access; every account-scoped read is authorized by
the Authority.

Account changes clear account-scoped pages, answers and sources. A save,
project change or People change that is still running, or whose outcome is
unknown, holds sign-out until it settles.

Ask distinguishes invalid generated output (`invalid_output`, HTTP 502) from
availability failures (`unavailable`, HTTP 503). Both use the existing sanitized
error envelope. The CLI preserves code/status and exits nonzero; the desktop app
receives only the failure code and shows a fixed message for invalid output. It
never displays model or provider bodies. A valid model `answer: null` remains a
successful canonical insufficient-evidence response. Malformed output is never
converted to null or retried automatically.

Ask retains validated citations, groups them by record digest, and loads source
cards through `person records --record-sha256 <digest>` while the app is shown.
Each readable card appears as its read completes; a failed or missing read does
not discard other readable cards. Citations also carry a `ref` for
`person open`, but the source cards still read `person records` until a
follow-up moves them to open by ref. The answer's numbered sources acquire
meeting titles after their reads complete. Selecting a source's number or row
opens its approved record alongside the answer.

Cards show decisions, actions, rationale, and approved evidence excerpts beside
the statement each excerpt supports. Meeting dates, excerpt timestamps,
participant display names, and the record approver's display name are optional;
absent metadata is omitted. Participants are source observations, not confirmed
attendance. No email or opaque participant ID substitutes for a missing name.
An ECHO record approval does not establish who authorized its business decision.

The client requests optional source metadata with
`X-Echo-Person-Record-Version: 2`. Each readable record may then include
`source_metadata.record_approved_by.display_name`, resolved from the private
Slack approval's exact organization, principal, and membership tuple. The lookup
uses the current directory display name, including historical revoked tenures
when they remain available; it supplies no job title, email, or authorization.
Participants continue to come from the approved brief. The signed envelope and
record schema are unchanged. Older clients receive the original response shape,
and newer clients accept older servers that omit the optional metadata.

Current membership and record visibility are checked again before releasing
the enriched response, whose digest is included in the existing read audit.
Missing and inaccessible records both produce an empty result. Source details,
including meeting titles in the sources, are cleared when the app loses focus or the conversation
changes and reloaded on return. Runtime processing and telemetry are unchanged.

## Connected tools

The desktop app's **Tools** page (the sidebar's Tools row, or **Account →
Connected tools…**) lists every tool the Authority returns from `person tools`,
grouped by the signed-in person's connection: needs attention (revoked),
connected, available, and not turned on. The page names no tool itself, so a
tool the Authority adds appears without desktop changes. Connect, Reconnect and
Disconnect run the same Person CLI tools verbs as the terminal:
`person tools connect --tool <id> --no-wait` opens the tool's page and returns
the attempt, the window reads it with `person tools status --tool <id>
--attempt-id …` every 2 seconds until it settles (a status read is what
completes a Slack link), Cancel or Escape runs `person tools cancel`, and
Manage → Disconnect runs `person tools disconnect --tool <id>`. A failed
attempt's reason code (`account_mismatch`, `identity_conflict`, …) is shown in
the app's own words. On a machine without a browser,
`person tools connect --tool slack --method dm-code --slack-user U…` runs the
DM-code challenge from the terminal. Organization setup stays in the CLI: an
owner sets up the organization's Slack connection with
`person tools setup --tool slack`
([identity and onboarding](identity-and-onboarding.md)).

`person tools disconnect --tool slack` removes only the current person's Slack
identity link. It keeps the organization's Slack installation, Person
membership, and approved records. Ask and Sources continue to use the Person
session. The server resolves the caller rather than accepting a target
membership, revokes the current link, and invalidates pending linking attempts
so they cannot restore it later. Connecting again requires a new sign-in.

## Agents

Claude Code, Codex and other agents use the Person CLI with the session of the
person who runs them; an agent has no membership of its own
([INV-PERMISSIONS-015](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md)).
`person --help` starts with the same order:

- `person status` says who is signed in, from local state only.
- `person list` is the map: the newest notes, documents and approved meetings
  the person can read now, 25 per page, with no text and no counts. Its first
  page names the person, their connected tools and their projects.
  `--project <project-id>` narrows it to one joined project and `--mine` to
  what the person added or approved.
- Pass `next_cursor` back as `--cursor` with the same scope; `null` is the end.
- `notice: "meetings_unavailable"` means meetings are still being indexed and
  come on a later page. A first page with no items and that notice is not the
  end: follow its cursor later. A later page that could only wait answers 503
  `unavailable`; retry the same cursor later.
- `person open --ref <ref>` reads one row or one Ask citation's `ref`.
  Documents, meetings and transcripts page with `--cursor` and the same ref. A
  meeting's first page carries `transcript_ref` when its transcript was shared
  with the reader. Anything the person cannot read is `not_found`.
- `person ask --question <text>` answers with citations in the same scopes.
- With a valid session, a 401 on `--project` means the person is not a member
  or the project does not exist.

## Artifact boundary

`tools/pack-person-client.mjs` builds the Person client and only its protocol
and provider-client dependency closure. The Slack and Jira client fragments own
their wire contracts and commands without acquiring server code. The tarball contains no
Authority service, processing runtime, server provider, native SQLite, LaunchAgent
code, JSONL outbox, or root product package.

CI installs the exact tarball offline on macOS arm64 and checks version, help,
and absent-session behavior. Server deployment is a separate Authority
container workflow.

## Deployment boundary

This repository currently produces two independently operated artifacts:

- the single-organization Authority container, whose hosting and custody model
  is defined by
  [ADR-0008](../decisions/ADR-0008-echo-hosted-authority-by-default.md); and
- the thin Person CLI tarball.

This list describes the Authority and Person-client release boundary, not
every current or future machine interface.

The repository root is workspace orchestration only. It is private and has no
runtime export or executable.

The neutral client uses `/v4/person/tools`, a bounded generic status contract
that adds `organization_setup` for owners; the v3 route strips that field and
keeps serving older clients. Each tool registers its own verbs (`setup`,
`connect`, `disconnect`, `status`, `cancel`) as a `PersonToolProviderV1` at an
explicit entrypoint; `person tools` dispatches to them by `--tool`. Supported
v2 routes remain in the Slack provider for existing clients; the disconnect
command decodes that retained response there.

## Deliberate context uploads

`person updates submit-v3`, which the desktop app also uses, saves one
explicitly selected UTF-8 file unchanged, with
`--audience only-me|team|project|projects` (default Only me; `project` requires
`--audience-project-id`, `projects` requires `--audience-project-ids-json`) and
an independent `--association-project-ids-json` set that does not change the
audience. `status-v3` returns the durable receipt and optional enrichment
progress. `search-v3` and `search` find original uploads, and
`person open --ref note:<context-id>` reads one, under current membership and
stored audience, without Slack approval or a model dependency. Content/search
releases revalidate the session and audit before returning. Unknown submissions
require the same request ID and exact file, title, audience, and project
coordinates on retry; no local queue or automatic upload exists. The V2
`submit`, `status` and `read` commands and `read-v3` left the CLI on
2026-09-30.

The current bounded text carrier does not decide the context taxonomy. Optional
LLM search hints remain derived metadata. Uploads never become approved
decision records; `person records` reads approved records only. The
`/v3/person/ask` route behind `person ask` also retrieves authorized uploads
and usable document extraction as unapproved original evidence, filtered by
stored audience and, for project scope, project association
([ADR-0015](../decisions/ADR-0015-global-and-project-scoped-person-ask.md)).
Generic source admission alone grants no access to raw meeting snapshots or
pending approvals. See the
[historical upload scope](../product/2026-09-21-person-update-inbox-v1.md).

`person list --mine` lists these uploads from custody as soon as they are
saved, in every extraction state, so they appear in Mine before Ask can find
them. Mine is bound to the uploading membership: after a person is provisioned
again, earlier uploads stay readable wherever their audience allows but no
longer appear in Mine.

In the desktop app, **Capture** wraps these commands through the Person
client. Owners and employees write a note or choose a file, choose who can read
it, and explicitly save it. Search results open through a fresh
permission-aware read. The document extension below adds persistent, bounded
original snapshots and recovery commands. Neither path silently uploads files
or runs a background uploader.

Each operation passes the host's account fence before and after the client
call. Account changes clear fetched content. A save that is still running, or
whose outcome is unknown, holds sign-out until it settles. Provider diagnostics
and credentials never reach the app window.

## 2026-09-23 document recovery extension

The desktop app's project pages and Capture invoke the Person client's
`person documents` commands for text/Markdown, PDF and Word `.docx` files up to
25 MiB. Audience and project association are selected independently. Choosing
several files is a bounded foreground interaction, not a durable background
processing service. Authority retains accepted originals and performs
extraction through the shared Person source adapter.

Before a document submission, the CLI retains an immutable private copy with
the exact request metadata, scoped to the captured Authority and membership.
The copy survives restart so `documents retry --request-id` does not depend on
the original source pathname. `documents pending` lists local retained requests
without a network call or revealing paths. A matching full or minimal saved
receipt resolves the local attempt. A minimal receipt confirms admission after
project access is lost without returning document content or access coordinates.
A full `status-v2` receipt never matches a snapshot an older client kept from a
V1 upload; `retry` or `abandon` settles that one.

`documents abandon --request-id` explicitly removes only local retry material.
It cannot cancel or delete a possibly completed Authority upload. The desktop
app offers retry and explicit abandonment of a retained upload. A user must
check status/search before creating a replacement request if the earlier outcome
remains unknown. Known input/quota/snapshot rejections are presented as known
non-submissions, not uncertain saves.

Document linking and unlinking keep their exact account-bound request ID, so an
uncertain change is retried as the same request. Dismissing the local reminder
does not cancel a server mutation. `person open` returns a document's metadata
and text page from one server read, and the client withholds it if the session
changed meanwhile. No fetched search corpus, decision
model or approval state is made authoritative on the client. See
[project documents](../features/project-documents-v1.md) and
[ADR-0014](../decisions/ADR-0014-unified-source-ingestion-and-document-custody.md).
