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

## Organization record submission

`record/` holds the member half of the organization decision record. The
submitter owns no store of its own: a decision node's write-once slot files are
the whole state machine, so `sweep()` is safe to repeat from anywhere. It runs
at composition startup, at the start of every product cycle, and immediately
after a Slack approval or rejection resolves. A failed sweep never stops the
local pipeline — organization ingest is a second egress path beside delivery,
not a gate on it.

`record/*.ts` stays protocol-free and works through injected ports;
`record/adapters/` holds the concrete protocol-backed envelope builder, and
`client/http-organization-record-client.ts` the ingest client. An excluded
source produces no envelope of either event type, and an exclusion list that
cannot be read exactly stops product startup rather than shipping everything.

`echo-brain approvals` now shows each node's organization-record state beside
its local decision, including the accepted receipt's position and record hash
or the terminal rejection code.

Local product files never import the central service. The product package
bundles only the three shared protocol/API workspaces.
