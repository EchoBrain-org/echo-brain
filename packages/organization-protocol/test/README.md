# Organization protocol tests

The package suite covers the current public protocol responsibilities:

- authority descriptor validation, independent pin comparison, signing-key
  binding, and canonical digest behavior exercised through envelope and receipt
  verification;
- approval and rejection payload validation against the shared decision-brief
  conformance fixture;
- restricted-reviewer and organization-member-readable policy commitments,
  release-draft projections, and Slack-reaction presentations;
- Person content-policy reader selectors and frozen consequence digests;
- provider-neutral and private Slack Block Kit human-action inputs;
- version-4 record envelope provenance, lineage, predecessor, semantic
  idempotency, digest, and detached-signature joins;
- version-2 append receipt position, record-head, event, policy-fact, and
  signature joins; and
- the package export, asset, and dependency boundary.

The tests pin representative canonical hashes and signature inputs and reject
cross-version, key, lineage, policy, action, provenance, digest, hostile-object,
and duplicate-identity substitutions. Runtime persistence, transaction
atomicity, Slack API calls, delivery, and reader authorization remain service
responsibilities and are not claimed by this package suite.
