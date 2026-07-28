# Organization protocol

**Status:** stable onboarding/access protocol

This package owns the stable facts that cross the installation/authority trust
boundary:

- an unsigned authority descriptor pinned through an authenticated bootstrap
  channel;
- an installation-signed enrollment request that carries its public signing key
  and proves possession of the matching private key;
- an authority-signed enrollment receipt bound to the exact signed request; and
- a sequence-numbered authority-signed installation access state that is
  short-lived while active and terminal when revoked.

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

The stable enrollment shape intentionally does not copy the experimental
identity-manifest and publication-policy fields. Those are product-local and
ingest-era evidence. Enrollment remains self-contained; their later central
registration belongs to the separate ingest promotion.

It depends only on `@echo-brain/federation-protocol`. It owns no transport
routes, invitation delivery, database rows, admin commands, signing
implementation, or UI. Invitation representation and transport remain
deferred rather than becoming an implicit signed-document format. Signed admin
transition events, ingest batches, and batch receipts also remain deferred.
