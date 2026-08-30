# Composition

This directory is the Organization Authority assembly layer. It may select
concrete adapters and connect them to application ports, but provider-neutral
runtime components must not import a provider implementation.

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
own the background worker. `granola-meeting-source-runtime-v1.ts` contains the
Granola-specific source bundle; other provider bundles must follow the same
pattern rather than entering the provider-neutral runtime.

Stopped-state setup is split by responsibility. `authority-state-initializer.ts`
creates a new absent-state lineage. `organization-authority-setup-cli.ts`
coordinates initial organization and owner setup. Public `clean-*` command
names and versioned `clean-founder` wire values remain compatibility contracts;
they are not component names and do not constrain the service to a founder.

Secret values enter only through explicit private-file adapters. Composition
may pass credential file locations into a concrete provider bundle, while the
provider-neutral runtime sees only the bundle contract and admitted digests.

Answer-composition provider bundles bind credentials, models, and a
structured-generation adapter. The provider-neutral answer-composition
capability remains under `answer-composition/`; concrete provider adapters
live under `adapters/answer-composition/`.
