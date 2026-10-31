# Organization Authority tests

Tests live beside the narrowest active component they exercise:

- `adapters/` covers the onboarding-invitation file adapter and the Ask audit
  adapter.
- `composition/` covers concrete implementation selection, journey telemetry
  and staging tools.
- `presentation/` and the `person-*` suites cover authenticated HTTP request
  and response behavior.
- `project-context-*` suites and `project-context-integration/` cover project
  storage, application commands, HTTP transport and the synthetic harness.
- The top-level `authority-state-lineage-initializer` suite covers
  state-lineage initialization; the `organization-authority-state-bootstrap`
  and `current-storage-schema` suites cover the real baselines.

Use `npm run test:authority` for the workspace. The provider-neutral
processing core and the durable meeting-processing cycle are tested in
`packages/organization-processing/test/`; provider adapters are tested in
their `providers/` workspaces.
