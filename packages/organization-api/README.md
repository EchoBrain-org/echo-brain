# Organization API

**Status:** internal Authority HTTP contract package

This package owns the versioned data-transfer types, route constants,
validators, and canonical byte encoders used at the Organization Authority
HTTP boundary. It contains no server, persistence, provider client, UI, secret,
or private-key implementation.

## Current contract areas

- Person OIDC login, session refresh, and session revocation routes and DTOs.
- Person-owned meeting-ingestion exclusions, including the bounded
  administrator break-glass read contract.
- Authority descriptors.
- Person tool discovery, query, update, upload-audience, project-context,
  document, document-association, and answer contracts.

Meeting-ingestion exclusion names describe the behavior: they prevent a
selected source or meeting from being admitted. Existing HTTP paths, JSON
fields, and wire `kind` values retain their versioned `member-exclusion`
spelling for compatibility.

The package depends only on the federation and organization protocol packages.
Database rows and Authority domain objects never become transport types.
