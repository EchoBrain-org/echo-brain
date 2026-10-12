# Composition

This directory assembles the Organization Authority. It selects concrete
adapters and provider bundles and connects them to application ports. It also
hosts the Person use-case services [listed below](#use-case-services-with-direct-sqlite-access),
which reach SQLite directly. Provider-neutral runtime components must not
import a provider implementation.

- `organization-authority-composition-root.ts` is the deployable root. It
  selects the OpenRouter bundle and the Slack pieces from the `providers/`
  workspaces, the staging synthetic personal source (release canary, or the
  selected fixed fixtures), the personal Granola meeting provider
  (`granola-person-live-runtime-v1.ts`), and the shared personal meeting
  runtime with the approval core, its after-record hook and optional Slack
  presenter. It adds the Jira and Confluence Person runtimes
  (`jira-person-live-runtime-v1.ts`, `confluence-person-live-runtime-v1.ts`)
  as live connectors only when the service CLI supplies their explicit
  configuration behind their release gates. Meetings come only from
  person-owned sources; there is no organization meeting source.
- `organization-authority-service-cli.ts` instead opens
  `staging-connector-rehearsal-runtime.ts` when the staging host selects a
  connector rehearsal profile. That opt-in, staging-only root and its
  protocol and selection modules (`staging-connector-rehearsal-*`) sit at the
  top of this directory, not in `staging/`.
- The connector rehearsal is a Jira-only, request-bound read verification.
  The Slack bot reads nothing, and the rehearsal has no capture or storage
  path.
- `organization-authority-runtime.ts` composes the provider-neutral runtime.
  `organization-authority-service-lifecycle.ts` owns startup, the worker,
  shutdown order and the writer gate. The gate covers only recovery and
  approval publication; meeting lanes, card presentation and `runUngated` work
  (the staging canary) run outside it, and drain and close wait for them.
  `organization-authority-api-runtime.ts` owns request-serving database handles.
  `model-call-limiter-v1.ts` is the one process-wide model-call limiter: Ask
  first, background calls capped, and a pause after a 429.
- `person-meeting-runtime-v1.ts` runs personal meeting sources in up to three
  lanes, one pass per source at a time. A meeting whose extraction failed is
  parked by the shared cycle; the runtime re-runs it from custody on an
  operator grant and tells the owner why it is held.
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
  source selection and personal provider, the release canary with its private
  socket control and client, and (in `staging/observability/`) the staging
  journey content telemetry format, and `synthetic-demo-*` is the no-write
  demo extraction evaluator.
- `observability/` holds the journey metrics and telemetry transport and the
  optional staging LangSmith trace exporter (`langsmith-observer-v1.ts`,
  `langsmith-runtime-v1.ts`), which `organization-authority-service-cli.ts`
  opens. When selected, it sends trace content off-host.

Provider-neutral bundle seams live in `packages/organization-processing/src/ports/`.
Concrete bundles live in `providers/synthetic-demo` (the staging synthetic
personal meeting provider), `providers/openrouter`, `providers/slack/server`
(the approval presenter and click, Person identity and the organization Slack
connection state), `providers/granola` (the personal Granola connection and
folder meeting source), `providers/jira` and `providers/confluence` (each a
gated Person connection and live reader), and `providers/shared` (the shared
Person connection and Nango runtime). Secret values enter only through
private-file adapters.
Public `clean-*` command names and versioned `clean-founder` wire values are
compatibility contracts, not component names.

## Use-case services with direct SQLite access

Presentation routes never open SQLite. These non-root composition modules hold
use-case logic and reach SQLite directly, through raw SQL, a `better-sqlite3`
handle or a concrete `Sqlite*` adapter class, instead of through application
ports. The composition layer rule in
[`source-boundary.v1.json`](../../source-boundary.v1.json) allows this; it is
known layering debt:

- `approval-core-v1.ts` and `approval-publisher-v1.ts`: the decision table and
  record publication (raw SQL);
- `person-meeting-runtime-v1.ts`: the personal meeting lanes and the
  `POST /v1/person/meetings` route (raw SQL and SQLite adapters);
- `person-trigger-runs-v1.ts`, `person-sweep-runs-v1.ts` and
  `person-open-items-v1.ts`: runs, sweeps and open items (typed against
  `Sqlite*` adapter classes, with `better-sqlite3` write callbacks);
- `person-record-search-route.ts`: record list, search and open (raw SQL on
  record-log tables), with `person-record-read-route.ts` and
  `person-answer-v3-route.ts` (concrete SQLite audit adapters); and
- `readable-search-generation-composition.ts` and
  `readable-search-generation-reconciler.ts`: search generations (raw SQL).

A new module must not join this list quietly: add it here in the same change,
or put its logic behind an application port.
