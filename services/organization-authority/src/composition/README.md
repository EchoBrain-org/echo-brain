# Composition

This directory assembles the Organization Authority. It selects concrete
adapters and provider bundles and connects them to application ports.
Provider-neutral runtime components must not import a provider implementation.

- `organization-authority-composition-root.ts` is the deployable root. It
  selects the Granola, OpenRouter and Slack bundles from the `providers/`
  workspaces, the staging synthetic meeting source when configured, and the
  Jira Person runtime (`jira-person-live-runtime-v1.ts`) only when its
  ADR-0026 gate allows it.
- `organization-authority-service-cli.ts` instead opens
  `staging-connector-rehearsal-runtime.ts` when the staging host selects a
  connector rehearsal profile. That opt-in, staging-only root and its
  protocol and selection modules (`staging-connector-rehearsal-*`) sit at the
  top of this directory, not in `staging/`.
- `connector-rehearsal-capture-v1.ts` is the owner-bound Granola capture used
  by that root through `context-source-intake-v1.ts` and
  `provider-context-intakes-v1.ts`. Jira and Slack support live read verification
  only; `slack-context-capture-runtime-v1.ts` now exposes only a transient reader.
  The rehearsal has no Jira or Slack capture or storage path.
- `organization-authority-runtime.ts` composes the provider-neutral runtime.
  `organization-authority-service-lifecycle.ts` owns startup, the serialized
  worker, shutdown order and the operator-work gate.
  `organization-authority-api-runtime.ts` owns request-serving database handles.
- `organization-authority-state-bootstrap.ts`, `organization-authority-setup-cli.ts`
  and `organization-authority-reset-cli.ts` own stopped-state setup and reset.
- The `person-*` modules wire Person routes and upload processing, the
  `readable-search-*` modules own search generations, the `*-journey-*`
  modules record Ask and meeting-approval journeys, `staging/` holds the
  staging synthetic meeting source selection and journey telemetry transport,
  and `synthetic-demo-*` is the demo lane.

Provider-neutral bundle seams live in `packages/organization-processing/src/ports/`.
Concrete bundles live in `providers/granola`, `providers/openrouter`,
`providers/slack/server` (private approval, Person identity, the private-DM
staging canary and the fixed-channel context pointer source) and
`providers/jira` (the gated Person connection, live reader and context
source). Secret values enter only through private-file adapters.
Public `clean-*` command names and versioned `clean-founder` wire values are
compatibility contracts, not component names.
