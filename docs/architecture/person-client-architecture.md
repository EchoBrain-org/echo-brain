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

Ask retains validated citations and offers **Sources** for the cited approved
records, grouped by record digest. Opening Sources invokes
`person records --record-sha256 <digest>` for each record, using the existing
authenticated record-read route. Current membership and visibility policy are
checked again, and the existing read audit is retained. Missing and inaccessible
records both produce an empty result. The view shows readable meeting titles,
visibility, decisions, actions, and rationales; **Back to answer** restores the
answer. Source details are cleared when the app loses focus or the conversation
changes. Runtime processing and telemetry remain unchanged.

## Artifact boundary

`tools/pack-person-client.mjs` builds the Person client and only its protocol
dependency closure. The tarball contains no Authority service, processing
runtime, provider adapter, LaunchAgent code, JSONL outbox, or root product
package.

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
