# Organization API tests

The suite verifies exact request shape, canonical installation signing,
signature verification, and request hashing. Server transport behavior is
tested with the authority service.

The record ingest suite covers the dedicated ingest path, the record-specific
raw body limit against the unchanged shared limit, both event types through the
submission DTO, the accepted-record response, and the terminal/retryable split
in the rejection code vocabulary. It reads the organization-protocol golden
fixture so the transport DTOs are exercised against real signed documents
rather than hand-built shapes.

Two cross-contract cases pin the ends the API package cannot import: the exact
key set of the member-side approval-action authorization evidence (including
its `action`, matched to each event type) and the record core's receipt payload
field names, asserted against the signed receipt that accepted-response
validation must accept.
