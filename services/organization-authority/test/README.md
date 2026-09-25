# Organization Authority tests

Tests live beside the narrowest active component they exercise:

- `processing/core/` covers provider-neutral contracts, approval, delivery,
  canonical briefs, and core state behavior.
- `processing/adapters/` covers concrete meeting-source, decision-processor,
  approval, delivery, and provider transport adapters.
- `processing/admitted-meeting-processing/` covers the durable serialized
  production cycle and its worker lifecycle.
- `composition/` covers concrete implementation selection, lifecycle wiring,
  onboarding, and bounded staging tools.
- `presentation/` and the `person-*-route` suites cover authenticated HTTP
  request and response behavior.
- state-lineage, record, retrieval, and private Slack approval suites cover
  their named cross-component Authority boundaries.

Use `npm run test:authority` for the workspace,
`npm run test:meeting-processing-core` for the provider-neutral core.
