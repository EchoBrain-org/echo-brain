# Organization API

**Status:** internal Authority HTTP contract package

This package owns the versioned data-transfer types, route constants,
validators, and canonical byte encoders used at the Organization Authority
HTTP boundary. It contains no server, persistence, provider client, UI, secret,
or private-key implementation.

## Current contract areas

- Person OIDC login, session refresh, and session revocation routes and DTOs.
- Person Slack identity-link challenge requests, responses, and results.
- Person-owned meeting-ingestion exclusions, including the bounded
  administrator break-glass read contract.
- Authority descriptors plus administrator membership, overview, and audit
  DTOs.
- Installation-authenticated Slack identity-link DTOs.

Person Slack identity linking and installation Slack identity linking are
different contracts. The Person flow proves a signed-in Person's Slack
identity. The installation flow is signed by an enrolled installation and also
carries its installation and adapter coordinates.

Meeting-ingestion exclusion names describe the behavior: they prevent a
selected source or meeting from being admitted. Existing HTTP paths, JSON
fields, and wire `kind` values retain their versioned `member-exclusion`
spelling for compatibility.

The package depends only on the federation and organization protocol packages.
Database rows and Authority domain objects never become transport types.
