# Organization protocol tests

The package suite covers exact document and schema validation, public-key and
signature binding, frozen canonical bytes, document bounds, enrollment
cross-bindings, active-lease freshness, monotonic sequence handling, and
terminal revocation.

The organization record suite adds the golden approval/rejection/receipt chain,
creation replayed over the exact canonical payload bytes, envelope digest and
canonical-byte helpers, receipt-to-envelope binding, rejection of the reserved
`correction` type, required allow-decision authorization evidence whose action
matches the event type, the schema-version-1 intent pin, unique participant
ids, the 2 KiB organization-visible rejection reason bounded in UTF-8 bytes
including a multibyte value the structural schema cannot bound, and the exact
256 KiB canonical boundary — including the check that the shared 16 KiB default
has not moved for anything else.

Receipt coverage pins the record core's field names (`position`, no restated
signing key) and proves the pinned-key comparison is against
`integrity.key_id`: a receipt naming a foreign key fails the pin, and a
tampered receipt still fails the signature.

The private D3-1 leaf suite freezes the approved-snapshot, installation-free
human-act reference, approved/rejected event, and semantic-idempotency bodies.
The event digest uses its own schema-and-kind commitment wrapper rather than
hashing an unversioned event directly. The suite reuses the retained payload
grammar, pins representative canonical hashes, and proves exact policy,
action, and coordinate joins without exporting or selecting a new envelope,
receipt, persistence, or live writer.
