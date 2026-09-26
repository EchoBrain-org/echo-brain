# Composition

This directory assembles the Organization Authority. It selects concrete
adapters and provider bundles and connects them to application ports.
Provider-neutral runtime components must not import a provider implementation.

- `organization-authority-composition-root.ts` is the deployable root. It
  selects the Granola, OpenRouter and Slack bundles from the `providers/`
  workspaces.
- `organization-authority-runtime.ts` composes the provider-neutral runtime.
  `organization-authority-service-lifecycle.ts` owns startup, the serialized
  worker, shutdown order and the operator-work gate.
  `organization-authority-api-runtime.ts` owns request-serving database handles.
- `organization-authority-state-bootstrap.ts`, `organization-authority-setup-cli.ts`
  and `organization-authority-reset-cli.ts` own stopped-state setup and reset.
- The `person-*` modules wire Person routes and upload processing, the
  `readable-search-*` modules own search generations, `staging/` holds staging
  source selection and journey telemetry, and `synthetic-demo-*` is the demo
  lane.

Provider-neutral bundle seams live in `packages/organization-processing/src/ports/`.
Concrete bundles live in `providers/granola`, `providers/openrouter` and
`providers/slack/server` (private approval, Person identity and the private-DM
staging canary). Secret values enter only through private-file adapters.
Public `clean-*` command names and versioned `clean-founder` wire values are
compatibility contracts, not component names.
