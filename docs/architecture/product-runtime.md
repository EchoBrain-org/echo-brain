# Product runtime architecture

**Status:** Current

The machine product is the standalone Person client. It authenticates one
human to one organization Authority, keeps that session private, and sends
bounded authenticated requests. Meeting processing and organization data live
on the server.

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

## Artifact boundary

`tools/pack-person-client.mjs` builds the Person client and only its protocol
dependency closure. The tarball contains no Authority service, processing
runtime, provider adapter, LaunchAgent code, JSONL outbox, or root product
package.

CI installs the exact tarball offline on macOS arm64 and checks version, help,
and absent-session behavior. Server deployment is a separate Authority
container workflow.

## Product boundary

The product has two operational artifacts:

- the organization-operated Authority container; and
- the thin Person CLI tarball.

The repository root is workspace orchestration only. It is private and has no
runtime export or executable.
