# Organization Authority tests

Tests live beside the narrowest active component they exercise:

- `processing/adapters/` covers concrete meeting-source, decision-processor,
  approval, delivery, and provider transport adapters.
- `composition/` covers concrete implementation selection, lifecycle wiring,
  onboarding, and bounded staging tools.
- `presentation/` and the `person-*-route` suites cover authenticated HTTP
  request and response behavior.
- state-lineage, record, retrieval, and private Slack approval suites cover
  their named cross-component Authority boundaries.

Use `npm run test:authority` for the workspace. The provider-neutral
processing core, including the canonical meeting document validator, and the
durable meeting-processing cycle are tested in `packages/organization-processing/test/`.
