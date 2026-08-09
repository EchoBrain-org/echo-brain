# Organization API

**Status:** stable onboarding/access transport contract

This package owns the versioned ordinary transport DTOs for the narrow
single-organization onboarding/access slice. It references signed organization
protocol documents, but database rows and authority domain objects never become
transport types.

It also owns creation and verification of installation-signed access-lease and
permission-check requests. Those requests are authenticated API commands, not
durable organization trust facts. Permission checks derive one stable provider
event digest from the exact Slack actor, action, approval resource, and adapter
identity while allowing request IDs and timestamps to change on transport
retries. The digest also binds the organization, enrollment, installation key,
and live Slack bot/app identity. It is correlation evidence, not an
authorization cache. The request carries only an opaque `approval_id`; raw
product processing keys and meeting identifiers never cross the organization
Authority boundary.

The permission-check decision is not itself signed. The request is
installation-signed; `request_sha256` and `provider_event_sha256` bind the
decision to that exact request but do not authenticate it. Authenticity comes
from the transport -- the configured HTTPS origin associated with the pinned
Authority descriptor. Callers verify the request binding regardless.

## Organization record ingest

`ORGANIZATION_API_RECORD_ENVELOPES_PATH` is the dedicated ingest route for the
organization decision record. Its request DTO wraps one signed record envelope
and nothing else; its success DTO wraps the authority-signed receipt. A
replayed envelope returns the stored original receipt unchanged, so the
submitter cannot distinguish a fresh append from a retry -- and does not need
to.

This route is the single exemption to the shared body limit. The canonical
record envelope is capped at 256 KiB; the exact request DTO adds the fixed
20-byte `{"record_envelope":}` wrapper, so
`MAX_ORGANIZATION_RECORD_API_BODY_BYTES` is 256 KiB + 20 bytes and bounds raw
bytes before JSON parsing. An approved brief with verbatim evidence routinely
exceeds 16 KiB. `MAX_ORGANIZATION_API_BODY_BYTES` is unchanged and still
governs every other route.

Ingest outcomes are terminal only when the response carries an exact code from
`ORGANIZATION_RECORD_PERMANENT_REJECTION_CODES`. Everything else -- an expired
lease, a transport fault -- is retryable, so the submitter keeps its frozen
envelope instead of writing a permanent-rejection slot. Terminal classification
is by code, never by matching message text.

This is the one route whose payload carries meeting identifiers and approved
brief content across the Authority boundary. That is deliberate: the record is
the organization's log of what its people approved. The permission-check
boundary above is unchanged -- it still carries only an opaque `approval_id`.

The package contains no server implementation, authentication provider,
persistence, log storage, UI, administrator secret, or private-key
implementation.
