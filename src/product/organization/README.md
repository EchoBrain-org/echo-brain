# Local organization integration

**Status:** local enrollment and access runtime

This module connects one installed Echo Brain to one organization authority. It
owns enrollment preparation, authority pinning, bounded HTTP-client
orchestration, signed-result verification, and the minimum local organization
evidence required by the onboarding/access slice.

It does not own central membership truth, organization signing keys, admin
sessions, meetings, decisions, reasoning, or core processing. Migrations
`0005` through `0007` add four tables to the existing installation database
for the write-once authority identity pin, verified relocatable origin and
optional internal CA, exact enrollment evidence, and atomic access
high-watermark. The raw bearer grant is never persisted.

The supported operator surface is:

```sh
echo-brain organization enroll --config <absolute-path> \
  --invitation <private-absolute-path> \
  --authority-pin <independently-obtained-sha256> \
  [--authority-ca <internal-ca-pem>] \
  --allow-exportable-software-key
echo-brain organization status --config <absolute-path>
echo-brain organization refresh --config <absolute-path>
echo-brain organization rebind --config <absolute-path> \
  --authority-url <new-https-origin> \
  --authority-pin <same-independently-obtained-sha256> \
  [--authority-ca <new-internal-ca-pem>]
```

Enrollment binds the organization membership to this installation ID and its
signing key. Retired local founder identity is never parsed or exercised; its
residue is detected by presence alone and refused. Once an authority is
pinned, product startup and every processing cycle require a current signed
access lease. The running service renews short leases in the background; an
expired lease or durable revocation fails closed before adapter contact.

Local product files never import the central service. The product package
bundles only the three shared protocol/API workspaces.
