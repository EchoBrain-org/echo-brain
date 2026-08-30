# Organization protocol

**Status:** stable authority-pinning, approval-policy, and signed-record
contracts

This package owns the canonical documents and validation rules shared across
the organization Authority, approval surfaces, record service, and record
readers. Its public entry point exposes five responsibility groups:

- an unsigned organization-authority descriptor and a process-local proof that
  the descriptor matched an independently trusted pin;
- the approval and rejection payload shapes that carry exactly the meeting
  facts a person reviewed;
- restricted-reviewer and organization-member-readable content policies;
- deterministic release drafts and explicitly Slack-reaction approval
  presentations for the two version-1 approval policies; and
- authority-signed organization record envelopes and append receipts.

The package does not own enrollment, access leases, user sessions, HTTP
routes, database rows, signing-key storage, source adapters, processing
adapters, Slack API calls, or UI state.

## Authority descriptor pinning

`validateOrganizationAuthorityDescriptor` verifies descriptor syntax and
public-key self-consistency. It does not authenticate the descriptor.
`verifyOrganizationAuthorityPin` compares the descriptor with a digest obtained
through an independently trusted channel and returns a frozen, process-local,
non-serializable `PinnedOrganizationAuthority`. A process must repeat that
comparison after restart rather than reconstructing the proof from stored JSON.

## Approval and visibility policy contracts

`person-content-policy-v2.ts` defines the two reader-selection contracts used
by current Person retrieval:

- restricted reviewer: only the exact approving principal and membership
  tenure may read the released record; and
- organization member readable: any current active owner or employee in the
  record's organization may read it.

The consequence text and its digest are contract bytes, not editable UI copy.
The selected policy is committed by the approved or rejected human action and
carried into the signed record.

The version-1 Slack-reaction approval contracts remain provider-specific by
design. Their source names say `slack-reaction`; their frozen wire kinds and
policy identifiers remain unchanged. Each flow has:

- a release-draft projection containing the exact title and ordered decision,
  action, and rationale lines exposed for review; and
- a deterministic Slack Block Kit presentation, fallback text, reaction pair,
  transport options, and canonical digest.

The private Slack Block Kit flow has its own signed action witness in
`private-slack-block-approval-record-input-v1.ts`. Raw Slack request bodies and
response URLs never enter the record contract.

## Organization record contract

`record-envelope-v4.ts` binds one approval or rejection to:

- its authority, organization, and state lineage;
- the semantic idempotency commitment for the human action;
- the predecessor record position and digest;
- meeting-source and decision-processor provenance; and
- the Authority signing key and canonical record digest.

The envelope accepts either the provider-neutral human-action input or the
private Slack Block Kit approval witness. Validation recomputes every joined
digest and rejects mismatched provenance, event, policy, or predecessor facts.

`organization-record-receipt-v2.ts` acknowledges the exact envelope, appended
position, resulting record head, event outcome, and any appended content-policy
fact. Receipt verification pins the Authority and recomputes the envelope and
receipt commitments before accepting the signature.

Record payloads may be up to `MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES` because
approved evidence can exceed the package's ordinary document limit. The
`fixtures/organization-record-payload-conformance.v1.json` fixture pins the
restated decision-brief contract against the core validator without creating a
runtime dependency between the two components.

The package depends only on `@echo-brain/federation-protocol`. It owns no
transport implementation, persistence, hash-chain storage, key provider, or
approval/delivery implementation.
