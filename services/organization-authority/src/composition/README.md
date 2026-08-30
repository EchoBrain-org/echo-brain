# Composition

This directory is the Organization Authority assembly layer. It may select
concrete adapters and connect them to application ports, but provider-neutral
runtime components must not import a provider implementation.

Provider-specific composition is kept at the concrete integration edges:
`providers/granola/`, `providers/openrouter/`,
`providers/slack/private-approval/`, and
`providers/slack/person-identity/`. Slack's synthetic private-DM staging
canary is under `staging/slack-private-approval/`. Generic bundle seams,
Authority roots and lifecycle, Person routes, and readable search stay at this
top level.

The service path has three deliberately separate roots:

- `organization-authority-composition-root.ts` is the deployable composition
  root. It selects the current Granola, OpenRouter, and Slack bundles.
- `organization-authority-runtime.ts` is provider-neutral runtime composition.
  It verifies admitted commitments and wires source processing, approval,
  record append, retrieval reconciliation, and the API runtime.
- `organization-authority-service-lifecycle.ts` owns process startup, the
  serialized worker, shutdown order, and the exclusive operator-work gate.

`organization-authority-api-runtime.ts` owns API-serving database handles and
constructs `presentation/organization-authority-http-server.ts`. It does not
own the background worker. `providers/granola/granola-meeting-source-bundle-v1.ts`
contains the Granola-specific source bundle; other provider bundles must follow
the same pattern rather than entering the provider-neutral runtime.

Stopped-state setup is split by responsibility.
`organization-authority-state-bootstrap.ts` creates a new absent-state lineage.
`organization-authority-setup-cli.ts`
coordinates initial organization and owner setup. Public `clean-*` command
names and versioned `clean-founder` wire values remain compatibility contracts;
they are not component names and do not constrain the service to a founder.

Private Slack approval has four explicit layers: the pure
`providers/slack/private-approval/private-slack-approval-interaction-protocol-v1.ts`, application
`providers/slack/private-approval/private-slack-approval-interaction-handler-v1.ts`, HTTP adapter
`providers/slack/private-approval/private-slack-approval-http-adapter-v1.ts`, and presentation port
`presentation/private-slack-approval-interaction-http-port-v1.ts`.

Secret values enter only through explicit private-file adapters. Composition
may pass credential file locations into a concrete provider bundle, while the
provider-neutral runtime sees only the bundle contract and admitted digests.

Answer-composition provider bundles bind credentials, models, and a
structured-generation adapter. The provider-neutral answer-composition
capability remains under `answer-composition/`; concrete provider adapters
live under `adapters/answer-composition/`.
