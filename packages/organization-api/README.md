# Organization API

**Status:** internal Authority HTTP contract package

This package owns the versioned data-transfer types, route constants,
validators, and canonical byte encoders used at the Organization Authority
HTTP boundary. It contains no server, persistence, provider client, UI, secret,
or private-key implementation.

## Current contract areas

- Person OIDC login, session refresh, and session revocation routes and DTOs.
- Authority descriptors.
- Person tools and tool connections, query, updates, upload audience,
  project context, documents, and document associations.
- Ask: the request, the V8 answer with its citations (approved records,
  sources, tickets, pages, follow-ups, workspace items), answer layout, the
  previous turn, progress events, the source check, cited-original reads,
  and the evidence desk.
- Lists and opens, meetings, runs and open items, impact cards, sweep
  results, changes, project activity, diagnostics, connector access, and the
  staging research evaluation.

The package depends only on the federation and organization protocol packages.
Database rows and Authority domain objects never become transport types.
