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
membership/session state on the server.

Legacy installation enrollment and access rows remain readable server-side
while record and approval bindings are re-keyed. They are not a machine-client
identity mode and no installation client ships in the product.

## Owner People interface

The same `ECHO.app` serves owners and employees. Its menu bar exposes
**Organization → People** when the installed Person client's current status
identifies an owner. The native window lists employee membership and invitation
status, creates employee invitations, replaces pending or expired invitations,
and revokes employee access. Owners are identified in the window header;
the employee roster does not list owner memberships.

`product/echo-overlay/people.swift` invokes the exact release-installed CLI with
literal arguments. It adds no browser service, alternate session store, role
assignment endpoint, or server polling loop. Opening/refocusing the window and
**Refresh** fetch current data. Invitation files are written by the existing CLI
into a newly created private folder and handed to the employee separately from
the shared setup package. The panel never renders invitation contents.

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

The installed app's **Account** menu and graphical setup use the same Person
CLI and session store. An existing member can sign in through Google without
another invitation; a new member chooses the private invitation file. Sign-out
and switching accounts are explicit actions. The app remembers the organization
address for returning sign-in, but does not store another copy of credentials.
Account readiness requires a successful permission-aware record read after
login. A local status response alone is not proof of organization access.

Account changes cancel pending answer/source reads and clear the displayed
conversation. People mutations block a simultaneous account transition while
their outcome is pending. Browser login can be cancelled from the Account menu.

Ask distinguishes invalid generated output (`invalid_output`, HTTP 502) from
availability failures (`unavailable`, HTTP 503). Both use the existing sanitized
error envelope. The CLI preserves code/status, exits nonzero, and gives the
native app a fixed message for invalid output; it never displays model or
provider bodies. A valid model `answer: null` remains a successful canonical
insufficient-evidence response. Malformed output is never converted to null or
retried automatically.

Ask retains validated citations, groups them by record digest, and loads source
cards through `person records --record-sha256 <digest>` while the panel has focus.
Each readable card appears as its sequential read completes; a failed read does
not discard other readable cards. The **Based on** chips acquire meeting titles and
available dates after their reads complete. Selecting a chip opens its approved record alongside the answer;
when another source read is still pending, a selected unread chip restarts the
remaining sequence with that record first. On narrow displays the source pane
occupies the panel until **Back to answer**.
Escape closes the source pane before hiding the panel. A missing source does not
prevent other readable cards from loading.

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
including names in chips, are cleared when the app loses focus or the conversation
changes and reloaded on return. Runtime processing and telemetry are unchanged.

## Connected tools

**Account → Connected tools** reads the organization's supported tools and the
signed-in person's connection status from the Authority. Slack is supported
today. Each connected tool offers **Disconnect**; an unconnected tool offers
**Connect**. Slack connection opens the browser, and the app checks completion
automatically through the installed Person client.

**Disconnect Slack** removes only the current person's Slack identity link.
It keeps the organization's Slack installation, Person membership, and approved
records. Ask and Sources continue to use the Person session. The server resolves
the caller rather than accepting a target membership, revokes the current link,
and invalidates pending linking attempts so they cannot restore it later.
The app refreshes server state after the operation; connecting again requires
a new browser sign-in.

## Artifact boundary

`tools/pack-person-client.mjs` builds the Person client and only its protocol
and provider-client dependency closure. The Slack client fragment owns wire
contracts and commands without acquiring server code. The tarball contains no
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

The neutral client and account shell use `/v3/person/tools`, a bounded generic
status contract. Provider commands and native actions are composed at explicit
entrypoints. Supported v2 routes remain in the Slack provider for existing
clients; the native disconnect action decodes that retained response there.

## Deliberate context uploads

`person updates submit` saves one explicitly selected UTF-8 file unchanged,
with `--visibility only-me|team` (default Only me). `status` returns the durable
receipt and optional enrichment progress. `search` and `read` retrieve original
uploads under current membership and stored visibility, without Slack approval
or a model dependency. Content/search releases revalidate the session and audit
before returning. Unknown submissions require the same request ID and exact
file, title, and visibility on retry; no local queue or automatic upload exists.

The current bounded text carrier does not decide the context taxonomy. Optional
LLM search hints remain derived metadata. Existing records/Ask/native Sources
continue to use approved decision records; connecting uploads to those surfaces
requires a separately qualified retrieval/evidence contract. Shared source
admission alone does not enable those reads. See the
[historical upload scope](../product/2026-09-21-person-update-inbox-v1.md).

The native menu bar's **Uploads…** window wraps these four commands through
the release-installed Person client. Owners and employees can choose a file,
enter its title, select Only me or Team, and explicitly upload it. Search results
open through a fresh permission-aware `read`, and **Check upload status** shows
whether the original is saved and optional metadata is ready. The window states
that Ask currently uses approved records.

The legacy text-upload window snapshots its selected input for explicit retries
and keeps an account-bound last-attempt locator for status. The document
extension below adds persistent, bounded original snapshots and recovery
commands; the earlier temporary-file-only description does not govern those
document requests. Neither path silently uploads files or runs a background
uploader.

Each operation checks the exact membership and Authority before and after the
CLI call. Account changes and deactivation clear fetched content and invalidate
read callbacks. A submitted upload finishes while the window is hidden, with its
outcome retained, and blocks simultaneous in-app account switching. Provider
diagnostics and credentials never enter the native upload window.

## 2026-09-23 document recovery extension

The refined native project interface invokes the installed
`person documents` CLI for text/Markdown, PDF and Word `.docx` files up to
25 MiB. Audience and project association are selected independently. Explicit
multi-file selection is a bounded foreground interaction; the native queue is
not a durable background processing service. Authority retains accepted
originals and performs extraction through the shared Person source adapter.

Before a document submission, the CLI retains an immutable private copy with
the exact request metadata, scoped to the captured Authority and membership.
The copy survives restart so `documents retry --request-id` does not depend on
the original source pathname. `documents pending` lists local retained requests
without a network call or revealing paths. A matching full or minimal saved
receipt resolves the local attempt. A minimal receipt confirms admission after
project access is lost without returning document content or access coordinates.

`documents abandon --request-id` explicitly removes only local retry material.
It cannot cancel or delete a possibly completed Authority upload. The native
recovery flow exposes status, retry and explicit abandonment when starting
another upload. A user must check status/search before creating a replacement
request if the earlier outcome remains unknown. Known input/quota/snapshot
rejections are presented as known non-submissions, not uncertain saves.

Document linking and unlinking retain their exact account-bound request for an
uncertain retry after restart. Dismissing the local reminder does not cancel a
server mutation. Reader refresh tolerates extraction completing between its
metadata/text requests only while immutable original identity and session
fences still match. No fetched search corpus, decision model or approval state
is made authoritative on the client. See
[project documents](../features/project-documents-v1.md) and
[ADR-0014](../decisions/ADR-0014-unified-source-ingestion-and-document-custody.md).
