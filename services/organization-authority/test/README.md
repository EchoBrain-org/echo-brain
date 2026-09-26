# Organization Authority tests

Tests live beside the narrowest active component they exercise:

- `adapters/`, `answer-composition/` and `processing/adapters/` cover the
  onboarding-invitation file adapter, the answer-composition audit and the LLM
  provider transport clients.
- `composition/` covers concrete implementation selection, journey telemetry
  and staging tools.
- `presentation/` and the `person-*` suites cover authenticated HTTP request
  and response behavior.
- `project-context-*` suites and `project-context-integration/` cover project
  storage, application commands, HTTP transport and the synthetic harness.
- The top-level `authority-*` suites cover baselines, state lineage and the
  offline copiers.

Use `npm run test:authority` for the workspace. The provider-neutral
processing core and the durable meeting-processing cycle are tested in
`packages/organization-processing/test/`; provider adapters are tested in
their `providers/` workspaces.
