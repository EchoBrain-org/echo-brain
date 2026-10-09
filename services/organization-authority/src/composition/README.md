# Composition

This directory assembles the Organization Authority. It selects concrete
adapters and provider bundles and connects them to application ports.
Provider-neutral runtime components must not import a provider implementation.

- `organization-authority-composition-root.ts` is the deployable root. It
  selects the OpenRouter bundle and the Slack pieces from the `providers/`
  workspaces, the staging synthetic personal source (release canary, or the
  selected fixed fixtures), the approval core with its after-record hook and
  optional Slack presenter, and the Jira Person runtime
  (`jira-person-live-runtime-v1.ts`) only when its ADR-0026 gate allows it.
  Meetings come only from person-owned sources; there is no organization
  meeting source.
- `organization-authority-service-cli.ts` instead opens
  `staging-connector-rehearsal-runtime.ts` when the staging host selects a
  connector rehearsal profile. That opt-in, staging-only root and its
  protocol and selection modules (`staging-connector-rehearsal-*`) sit at the
  top of this directory, not in `staging/`.
- The connector rehearsal is a Jira-only, request-bound read verification.
  The Slack bot reads nothing, and the rehearsal has no capture or storage
  path.
- `organization-authority-runtime.ts` composes the provider-neutral runtime.
  `organization-authority-service-lifecycle.ts` owns startup, the serialized
  worker, shutdown order and the operator-work gate.
  `organization-authority-api-runtime.ts` owns request-serving database handles.
- `approval-core-v1.ts` owns one proposal per meeting and the decision table
  (first decision wins, from any surface). `approval-publisher-v1.ts` turns each
  approval into one record through `approval-decision-projection-v1.ts`, writes
  the receipt and runs the after-record hooks in one Authority transaction.
  `authority-record-protocols-v1.ts` is the one list of record codecs and
  projectors. `person-trigger-runs-v1.ts` serves `POST /v1/person/runs`: the
  approver-owned impact checks that the hook enqueues and the sweeps a person
  asks for, through one launch path for both; it writes each finished check's
  open items. `person-sweep-runs-v1.ts` does a sweep's own work: which open
  items it re-checks, the findings it hands research, and the counts and
  verdicts it keeps. `person-open-items-v1.ts` serves the open-items
  operations on the same route, `sweep` (which queues a sweep) and `home`'s
  `sweep_due` included, asking `open-items-policy-v1.ts` every access
  question. Both services read a run's stored impact card through
  `person-stored-impact-card-v1.ts`.
- `organization-authority-state-bootstrap.ts`, `organization-authority-setup-cli.ts`
  and `organization-authority-reset-cli.ts` own stopped-state setup and reset.
- The `person-*` modules wire Person routes and upload processing, the
  `readable-search-*` modules own search generations, the `*-journey-*`
  modules record Ask journeys, `staging/` holds the staging synthetic meeting
  source selection, the release canary and the journey telemetry transport,
  and `synthetic-demo-*` is the no-write demo extraction evaluator.

Provider-neutral bundle seams live in `packages/organization-processing/src/ports/`.
Concrete bundles live in `providers/synthetic-demo` (the staging synthetic
personal meeting provider), `providers/openrouter`, `providers/slack/server`
(the approval presenter and click, Person identity, the staging canary control
and the fixed-channel context pointer source) and
`providers/jira` (the gated Person connection, live reader and context
source). Secret values enter only through private-file adapters.
Public `clean-*` command names and versioned `clean-founder` wire values are
compatibility contracts, not component names.
