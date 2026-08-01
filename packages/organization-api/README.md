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

The package contains no server implementation, authentication provider,
persistence, UI, administrator secret, or private-key implementation.
