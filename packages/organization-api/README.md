# Organization API

**Status:** stable onboarding/access transport contract

This package owns the versioned ordinary transport DTOs for the narrow
single-organization onboarding/access slice. It references signed organization
protocol documents, but database rows and authority domain objects never become
transport types.

It also owns creation and verification of the installation-signed access-lease
request. That request is an authenticated API command, not a durable
organization trust fact. Exact replays are idempotency keys; the authority
rejects divergent request-ID reuse and stale previous-state heads.

The package contains no server implementation, authentication provider,
persistence, UI, administrator secret, or private-key implementation.
