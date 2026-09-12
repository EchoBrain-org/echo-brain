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

The machine owns only the signed-in Person session below
`~/.local/share/echo-brain/person/`. The directory is `0700`; session files are
`0600`. Refresh is single-claim: once a refresh credential is taken for a
request it cannot be replayed after an ambiguous transport outcome. Logout
removes local session authority even if the remote outcome is unknown.

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
