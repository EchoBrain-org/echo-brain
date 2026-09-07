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
that permission. A failed request clears the roster; local identity is checked
again before displaying results. Mutations are never automatically retried after
an uncertain outcome. The Ask path and runtime observability are unchanged.

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
