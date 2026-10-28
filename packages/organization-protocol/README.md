# Organization protocol

**Status:** stable authority-pinning, approval-policy, and signed-record
contracts

This package owns the canonical documents and validation rules shared across
the organization Authority, approval surfaces, record service, and record
readers. Its public entry point exposes four responsibility groups:

- an unsigned organization-authority descriptor and a process-local proof that
  the descriptor matched an independently trusted pin;
- the approval and rejection payload shapes that carry exactly the meeting
  facts a person reviewed;
- restricted-reviewer, project-members-readable and
  organization-member-readable content policies, plus the approval-decision
  proof and owner-choice rules; and
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

`person-content-policy-v2.ts` defines three reader-selection contracts that
Person retrieval honors:

- restricted reviewer (`restricted-reviewer-person-v2`): only the exact
  approving principal and membership tenure may read the released record;
- project members readable (`project-members-readable-person-v1`): current
  active members of the projects frozen in the approval consequence's
  `audience_project_ids` may read it, including people who join later; and
- organization member readable (`organization-member-readable-person-v2`): any
  current active owner or employee in the record's organization may read it.
  The provider-neutral human-act input still accepts it; the approval-decision
  proof below refuses it.

The consequence text and its digest are contract bytes, not editable UI copy.
The selected policy is committed by the approved or rejected human action and
carried into the signed record.

A meeting approval decided in the approval core, on the desktop or through the
Slack DM copy, is recorded with one neutral proof:
`approval-decision-record-input-v2.ts` (`echo-approval-decision-ref-v2`). Raw
Slack request bodies and response URLs never enter the record contract.
A decision routes each decision and action to a destination, and each
destination group is its own record: it holds only its items, names the
proposal and the snapshot the reviewer saw, and carries a record approval id
derived from the proposal, its projects and its private flag
(`approvalRecordIdV2(…, isPrivate)`). It accepts only restricted reviewer (Only
me) or project members readable (Projects), so new meeting approvals never
record organization member readable. Its event's consequence names only that
audience, which is also the record's association, except for a record kept
private inside its projects: it binds the restricted reviewer with no project
audience, and its projects as association only (ADR-0049). No record carries
a transcript choice or source (ADR-0046). It validates the
confirmed action owners with `approval-owner-choice-v1.ts`, the one owner rule
every approval surface shares.

## Organization record contract

`record-envelope-v4.ts` binds one approval or rejection to:

- its authority, organization, and state lineage;
- the semantic idempotency commitment for the human action;
- the predecessor record position and digest;
- meeting-source and decision-processor provenance; and
- the Authority signing key and canonical record digest.

The envelope accepts the provider-neutral human-action input, plus any input
codec the caller registers, such as the approval-decision proof above.
Validation recomputes every joined digest and rejects mismatched
provenance, event, policy, or predecessor facts.

`record-append-factories-v4.ts` builds and verifies the signed envelope and
receipt for every approval surface.

`organization-record-receipt-v2.ts` acknowledges the exact envelope, appended
position, resulting record head, event outcome, and any appended content-policy
fact. Receipt verification pins the Authority and recomputes the envelope and
receipt commitments before accepting the signature.

Record payloads may be up to `MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES` because
approved evidence can exceed the package's ordinary document limit. The
test-only `test/fixtures/organization-record-payload-conformance.v1.json`
fixture holds accepted and rejected decision briefs for the approval payload
validator.

The package depends only on `@echo-brain/federation-protocol`. It owns no
transport implementation, persistence, hash-chain storage, key provider, or
approval/delivery implementation.
