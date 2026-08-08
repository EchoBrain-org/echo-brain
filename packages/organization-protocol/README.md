# Organization protocol

**Status:** stable onboarding/access protocol; V1 decision record contract

This package owns the stable facts that cross the installation/authority trust
boundary:

- an unsigned authority descriptor pinned through an authenticated bootstrap
  channel;
- an installation-signed enrollment request that carries its public signing key
  and proves possession of the matching private key;
- an authority-signed enrollment receipt bound to the exact signed request;
- a sequence-numbered authority-signed installation access state that is
  short-lived while active and terminal when revoked; and
- the organization decision record contract: two installation-signed event
  envelopes and the authority-signed receipt that acknowledges one of them.

Descriptor validation proves only syntax and key self-consistency. It never
authenticates the descriptor. V1 callers pin its exact canonical digest out of
band. Before any downstream create or verify call, the caller must compare the
descriptor with that independently stored digest through
`verifyOrganizationAuthorityPin`. The resulting authority handle is
process-local, frozen, non-copyable, and non-serializable; restart recovery
deliberately reconstructs it by repeating the comparison. All later documents
bind the verified authority key ID.

Active access states are leases. A verifier supplies the maximum accepted TTL,
trusted current time, bounded clock skew, and previously accepted state. It
fails closed on expiry, rollback, divergent sequence reuse, or progression
after revocation. The previous state must be passed explicitly; `null` is valid
only for sequence 1. Losing the retained high-watermark therefore fails closed
and requires recovery or re-enrollment rather than accepting a later snapshot
as a fresh bootstrap. A valid result is only an installation-level organization
gate; user-session and record-audience authorization remain separate.

The stable enrollment shape intentionally never copied the identity-manifest
and publication-policy fields of the product-local founder federation, which
is now deleted. Where those fields exist at all, they are historical evidence
in preserved state and backups, not current product-local evidence. Enrollment
remains self-contained.

## Decision record contract (V1)

One human act is one envelope. Both event types share a `kind` of
`echo-organization-record-envelope` and differ only by `event_type`:

- **approval** carries the resolved decision node exactly as approved — the
  `DecisionBrief` with its verbatim evidence spans, a typed source locator, the
  reviewed timestamp, and the approval surface — plus `intent`.
- **rejection** carries the act only: the source locator, the meeting id, the
  rejection time, an optional organization-visible reason bounded to 2 KiB
  UTF-8, and an optional `reconsider_after`. No brief content ever travels on a
  rejection, and rejections carry no `intent`.

`correction` is a reserved `event_type`. The V1 validators reject it by name so
a later payload-tombstoning family cannot silently reuse it.

Every envelope requires complete reviewer authorization evidence: an allow
decision from the existing approval-action authorizer, bound to this exact
approval id, installation, principal, membership, and **action**, with both
attribution identifiers present. The evidence's `action` must match the
envelope's `event_type` exactly -- `approve` for an approval, `reject` for a
rejection -- so an allow decision for one act can never authorize the other.
Whether that evaluation actually exists in the authority's integration audit
is still an audit lookup the authority application performs; the wire contract
enforces only that the quoted decision is for the act being submitted. The
verified principal and membership are the identity of record; `reviewed_by` is
display only and never load-bearing.

`intent` records approver intent, never a resolved reader list. Both fields are
permanent contract, but schema version 1 pins them to
`CONSERVATIVE_ORGANIZATION_RECORD_INTENT` -- exactly `restricted: true` and
`reconsider_after: null`. No approval surface can express either value, so any
other value on the wire would be an unattributed claim about what a human
intended. Relaxing the pin when an affordance ships changes the validator and
two schema constants, not the shape. `alternatives` and `links` are carried for
shape stability and pinned to empty and null on the same reasoning: V1 derives
nothing from either, so accepting content nothing validates would put
unreadable facts in an immutable log.

Participant ids in an approved brief must be unique. This is deliberately
stricter than core, which tolerates repeats: derive keys a participant
observation by (meeting snapshot, participant), so a repeated id would either
collide on a strict projection insert or silently drop a distinct observation.
Every protocol-valid payload must be derivable.

Record documents are the one exemption to
`MAX_ORGANIZATION_PROTOCOL_DOCUMENT_BYTES`: a brief with verbatim evidence
routinely exceeds 16 KiB, so envelopes are bounded by
`MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES` (256 KiB) at the exact call sites that
need it. Receipts keep the shared 16 KiB default, and so does every other
document in this package.

The payload schema necessarily restates the `DecisionBrief` shape core
validates, because core imports no packages. The two are pinned by the shared
positive and negative cases in
`fixtures/organization-record-payload-conformance.v1.json`, exercised by this
package's suite and by `tests/core/organization-record-payload-pinning.test.ts`
— not by shared code. This side is never looser than core's validator, and
where it is deliberately stricter the fixture's `record_only_invalid` cases
enumerate exactly where: the core suite asserts core still accepts them, so the
divergence is a tested fact rather than a comment.

Receipts are signed with the authority key member machines already pin. The
signed payload carries its own `kind` and `schema_version` for domain
separation with the shared `signed-document` primitive, and binds the exact
envelope id, canonical envelope digest, installation, idempotency key,
`position`, and record hash — `position` named exactly as the record core names
it. The signing key is not restated as a payload field: `integrity.key_id`
already carries it, and verification compares that value directly with the
pinned authority signing key before checking the signature. Verification also
recomputes the envelope digest from the exact canonical signed bytes rather
than trusting the receipt's copy.

It depends only on `@echo-brain/federation-protocol`. It owns no transport
routes, invitation delivery, database rows, admin commands, signing
implementation, log storage, hash chain, or UI. Invitation representation and
transport remain deferred rather than becoming an implicit signed-document
format. Signed admin transition events, ingest batches, and batch receipts also
remain deferred.
