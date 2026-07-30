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

The package contains no server implementation, authentication provider,
persistence, UI, administrator secret, or private-key implementation.
