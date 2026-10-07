# Organization API tests

The suite verifies the package's current runtime validators and canonical byte
encoders:

- Person OIDC and session DTOs, including the Person email identity rules
  (`person-session`).
- Versioned Person wire DTOs: answers, citations, source evidence, tools,
  connector access, documents and upload sharing, lists, updates, project
  context and the research evaluation (`person-*-v*`, `project-context-v1`).

Wire compatibility assertions intentionally retain the existing URL paths,
JSON fields, and serialized `kind` values even when source names are more
specific.
