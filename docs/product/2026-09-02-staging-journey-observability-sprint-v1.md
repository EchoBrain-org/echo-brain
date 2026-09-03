# Staging journey observability sprint V1

**Status:** accepted. Implementation starts 2026-09-02; sprint exit has not
been claimed.
**Grounded at:** `main` @
`f7018e16232aa11d24f9ecc880943b0bbb8c6ea2`, inspected 2026-09-02.
**Entry gate:** satisfied 2026-09-02 after PR #115 merged; the sprint branch
was rebased directly onto `main` @
`14f22359e7d6cd9ebe10d108d17be114c7838d75` before overlapping work resumed.
**Scope:** staging-only observability for the two immediate product journeys:
a retrieval-grounded Ask and a human-approved meeting decision. This sprint
adds no production telemetry, dashboard, alert, retention, IAM, or deployment
change.

## Decision

Staging will make one product operation inspectable from ingress to terminal
outcome. An operator must be able to make an Ask or approve a staged meeting,
then use a dashboard to find that operation and see its machine-stage latency,
LLM token use, retry attempts, outcome, and safe diagnostic counts.

CloudWatch is the staging telemetry system of record. It receives structured,
content-free journey events and aggregate metrics. A CloudWatch overview is the
initial aggregate dashboard. A thin, operator-only Journey Explorer may query
CloudWatch for a run-level waterfall; it does not create a second telemetry
ingestion path or grant AWS credentials to a browser. A Lambda-backed
CloudWatch custom widget is an acceptable first Explorer surface if it meets
the same read-only and privacy boundary.

The event contract is deliberately portable. A later production rollout may
reuse its event names, correlation rules, dashboard definitions, and Explorer
queries after a separate production design, security, cost, retention, IAM,
and rollout decision. This sprint makes no claim that staging configuration is
approved for production.

## Golden journeys

### Retrieval-grounded Ask

```text
request ingress
  -> validate
  -> plan LLM
  -> authorize and run released retrieval
  -> context construction
  -> answer LLM
  -> revalidate
  -> audit append
  -> response
```

The journey begins at the Ask boundary and ends when the service produces the
terminal response or terminal failure. Each machine stage emits a terminal
event even when a later stage is skipped. Planner and answer LLM calls record
separate attempts rather than folding retries into one opaque duration.
Authorization is observed where the existing Layer 3 release authenticates the
bearer, after the content-only planner has produced its bounded query plan. The
telemetry work does not reorder that product path.

### Human-approved meeting decision

```text
source intake
  -> extraction LLM
  -> candidate persisted
  -> approval card staged
  -> [human wait]
  -> approval action re-proved and queued
  -> terminal record persisted
  -> V4 append
  -> search published
```

This is one business journey with multiple process invocations. `human wait`
is measured from card staging to the verified action but is presented separately
from service latency. It is never represented as an open machine span, an
availability failure, or a normal latency alarm. The critical post-click
machine interval is verified action through search publication.

Implementation discovery made the two approval boundaries more precise. The
`meeting_approval_action_verify` stage is the Slack signature, payload, and
delivered-card lookup proof performed before the signed action is durably
queued. The later stable membership, connection, identity, and authorization
reproof culminates in `meeting_terminal_persist`: an approved or rejected
Control Plane terminal, or a durable denied-action receipt. This preserves the
real queue-before-final-reproof order without inventing a second stage.

For an approval, `meeting_terminal_persist` therefore names the durable Control
Plane terminal boundary. The approved V4 append remains the following
`meeting_record_append` stage; the Authority terminal receipt is its
idempotent local projection. Rejected and denied journeys explicitly skip the
record-append and search-publication stages.

## Journey and event contract

Each journey receives a randomly generated opaque `journey_id` at ingress or
intake. The ID is persisted where necessary to bridge process restarts and the
approval boundary, and is included in structured events and run-detail logs.
It is not a CloudWatch metric dimension. It must not be derived from a
candidate, approval, meeting, Slack, person, release, or other durable business
identifier.

The deployed Authority and Control Plane business schemas are fresh-state-only
and are not altered by this staging feature. Approval correlation is kept in a
separate, disposable SQLite sidecar under the staging state directory. It
contains only the random journey UUID, sequence/attempt state, bounded stage
timestamps, and domain-separated SHA-256 join digests. Raw source, meeting,
candidate, approval, person, and Slack identifiers are not stored in that
sidecar or emitted. A missing or unreadable sidecar disables run detail and
cannot block source processing, approval, append, search, startup, or shutdown.

Every machine-stage event carries, at minimum:

- `schema_version`, `journey_id`, `workflow`, `stage`, and `attempt`;
- start and end timestamps or an `elapsed_ms` duration;
- validated Git commit SHA and numeric CI build identity;
- error class and retryability when unsuccessful, with `stage` naming the
  redacted failure boundary; and
- only workflow-safe counts where applicable, such as planned queries, query
  hits, released atoms, context atoms, or citations.

For this sprint, `build_number` is the positive numeric GitHub Actions
`github.run_id` for the successful validation run selected by the trusted
release operator. The guarded image build copies that value and the source SHA
into OCI metadata and the image environment; the immutable image digest binds
those fields to the selected artifact. This identity is diagnostic provenance,
not release authorization or a business identifier.

`outcome` is null on intermediate successful stages. It is populated only at
the bounded stage that establishes that outcome, so an Ask planner cannot claim
`answered` and an extraction stage cannot claim `approved`.

Every LLM attempt additionally carries:

- provider, allowlisted routed model, attempt number, and finish reason (using
  the bounded `unknown` value when a provider attempt has no finish status);
- provider-reported `input_tokens`, `output_tokens`, and `total_tokens` when
  available;
- cached-input or reasoning-token fields only when the provider reports them;
  and
- provider round-trip latency, distinct from surrounding parsing, validation,
  persistence, or retry-backoff time.

Unknown provider token values are `null`, never zero. Token totals are summed
from individually recorded attempts. A retry therefore contributes its own
latency and tokens. Non-LLM stages have no token values rather than invented
zero-token measurements.

Telemetry emission is best effort and must never change a product decision,
response, approval result, retry policy, durability boundary, or availability.
The contract must have focused tests with an injected clock and UUID source so
that latency and correlation evidence are deterministic.

## Data and security boundary

The telemetry contract is content-free. It must not include prompts, generated
answers, source text, meeting titles, meeting content, candidate content,
Slack identities, user identities, authorization material, provider credentials,
API keys, secret values, raw provider payloads, raw provider request IDs, stack
identifiers, or durable business identifiers.

Configuration-derived strings are finite or structurally constrained by the
V1 schema. Model identities come from a versioned allowlist of models configured
for staging. Release identity is a canonical Git commit SHA and build identity
is a positive integer; neither field accepts an arbitrary caller string.

The Journey Explorer is operator-only and read-only. Its browser client has no
AWS credential or direct CloudWatch access. Query parameters, returned fields,
and errors follow the same allowlist and redaction rules as emitted events.
No telemetry surface may perform approval, retry, replay, mutation, or release
actions.

Metric dimensions remain low cardinality: for example `workflow`, `stage`,
`outcome`, provider, model family, and environment. `journey_id`, request
IDs, candidate values, and any per-user or per-meeting values remain in logs
only when permitted by this contract.

## Entry gate and concurrent-work rule

The sprint begins cleanly from the grounded revision. Before implementation
that overlaps the Ask route, approval lifecycle, synthetic staging CLI, or
their shared tests, open PR #115 must either merge or close. The sprint branch
must then fetch `origin/main`, re-check the active path overlap, and rebase onto
the resulting `origin/main` before that overlapping work begins.

Phase 0 contract work and Phase 1 transport work may proceed while that gate is
open only if they do not alter those overlapping paths. The gate is not a claim
that PR #115's work is correct; it prevents competing edits from silently
diverging at the observability boundary.

## Phases and review boundaries

Each phase is one reviewable pull request boundary. The phases are ordered by
dependency, while the Ask and approval implementations may proceed in parallel
after Phases 0 and 1 and after the entry gate is satisfied.

### Phase 0 - telemetry contract

Create the versioned, content-free event schema; canonical workflow and stage
names; correlation and retry rules; metric-dimension allowlist; redaction
rules; injected clock and UUID seams; and focused contract tests.

**PR boundary:** schema, local telemetry helpers, and tests only. No AWS
resource, application-journey, dashboard, or UI change.

**Exit:** tests prove stable event shape, `null` unknown tokens, and that
telemetry failure cannot change product behavior.

### Phase 1 - staging transport and liveness

Ship the synthetic staging service's structured application events to the
staging CloudWatch log group. Add an explicit startup/heartbeat event and
define retention, log-group ownership, and narrowly scoped delivery
permissions as infrastructure-as-code.

**PR boundary:** staging Compose, deployment/IaC, and transport verification
only. No Ask, approval, dashboard, or Explorer instrumentation.

**Exit:** a synthetic staging run produces a visible structured event and
heartbeat in the intended log group without exposing sensitive content.

### Phase 2 - Ask journey instrumentation

Instrument the complete retrieval-grounded Ask journey. Preserve provider
token usage, model identity, finish status, and attempt-level duration from
planner and answer calls. Record the retrieval and
release-safe counts needed to explain an answer without logging its content.

**PR boundary:** Ask composition, adapters, route/CLI propagation as needed,
and focused Ask telemetry tests.

**Exit:** one successful Ask and representative terminal failure produce a
complete correlated machine-stage timeline with per-attempt latency and tokens.

### Phase 3 - approval journey instrumentation

Instrument source intake through search publication, carrying the opaque
journey ID durably across extraction, candidate staging, restart, verified
human action, terminal persistence, V4 append, and search publication. Preserve
extraction LLM token fields currently parsed by the provider adapter.

**PR boundary:** meeting processor, approval lifecycle, durable persistence,
and focused restart, reject, retry, and approval telemetry tests.

**Exit:** approved, rejected, retry, and restart paths present coherent
timelines; human wait is explicitly separate from post-click machine latency.

### Phase 4 - CloudWatch overview

The implemented local formatter, transport, and
`authority-staging-journey-observability-v1.template.json` create aggregate
EMF metrics, Logs Insights queries, three alarms, and a CloudFormation-managed
staging dashboard. The template selects only the exact staging Authority log
group and creates no production resource or deployment path. EMF is emitted
beside canonical raw journey logs; `WorkerCycleCompleted` is the dedicated
stack's only log metric filter. The overview includes success and failure
rates, p50/p95/p99 stage, full end-to-end, and wait-excluded service latency,
token totals by step and completed request, tokens per total-token-available
attempt,
usage coverage, retries, worker heartbeat,
approved-work-stuck count, and the meeting funnel. True end-to-end latency is
derived in Logs Insights from a correlated journey's canonical `observed_at`
values, never by summing stage durations. Full approval wall-clock includes
human wait; a second service wall-clock subtracts the separately labelled
`queue_age_ms` interval so it never enters service-latency or availability
calculations.

**PR boundary:** staging-only telemetry metric emission, dashboard/query/IaC
definitions, and dashboard reconciliation tests or documented fixture proof.
The EMF metric dictionary uses only low-cardinality contract dimensions: stage
metrics use `workflow,stage`; outcomes add `outcome`; failures add
`failure_class`; LLM metrics use `stage,provider,model`; retrieval and human
wait use `workflow,stage`; and liveness, worker-cycle, retrieval-failure, and
approved-search backlog metrics have no dimensions. It excludes journey IDs,
release identity, build identity, and all business identifiers. Reported LLM
token values are never substituted with zero when unavailable. The stuck-work
signal is an explicit content-free pending-approved-search gauge and oldest-age
observation, not a best-effort cross-event dashboard join.

**Exit:** dashboard aggregates reconcile with raw journey events. Initial
alarms cover worker silence, retrieval failures, and approved work stuck before
search publication. The quick-detection thresholds are a successful worker
cycle missing in two of three one-minute periods, two Ask retrieval failures in
five minutes, and an approved-search stuck gauge of at least one after five
minutes for two of three one-minute periods. Latency and token anomaly
thresholds wait for a measured staging baseline. Dashboard queries and
recent-run views are bounded by the existing 14-day staging log retention. The
code/template are locally implemented and verified; no AWS stack deployment or
live proof is claimed in this phase.

### Phase 5 - Journey Explorer backend

Build the operator-only read API or equivalent CloudWatch custom-widget
backend. It lists recent journeys and returns a redacted run detail assembled
from CloudWatch data, with pagination, bounded time ranges, and least-privilege
IAM.

**PR boundary:** read-only backend, authorization, CloudWatch query layer,
redaction tests, and no end-user UI.

**Exit:** an authorized operator can retrieve recent runs and a complete,
redacted correlated detail without a browser AWS credential.

### Phase 6 - Journey Explorer UI and rehearsal

Create the operator UI: recent Ask and approval runs, safe outcome summary,
waterfall by stage and attempt, LLM token totals, retries, retrieval counts,
human-wait segment, and clearly redacted failure boundary. Rehearse one Ask
and one approval against staging and record the evidence that dashboard totals
and run detail agree. This is the first AWS live staging rehearsal for the
journey overview; it is explicitly deferred from Phase 4.

**PR boundary:** UI/custom widget, operator documentation, and staging
rehearsal evidence only.

**Exit:** an operator can perform either golden journey and use the UI to find
every underlying stage, latency, token value or `null`, retry, and terminal
outcome.

## Sprint exit

The sprint is complete only when all of the following are true in staging:

1. Both golden journeys emit correlated, content-free events from start to
   terminal outcome, including represented terminal failure paths.
2. Every machine stage reports latency; every LLM attempt reports provider
   token values when available, model, attempt number, and finish status.
3. The dashboard exposes aggregate health and the Explorer exposes one
   redacted run-level waterfall without browser AWS credentials.
4. Human wait is visible as a business interval and excluded from service
   latency and availability alarms.
5. Dashboard metrics reconcile with raw events, and the staging rehearsal
   proves that an Ask and an approval can each be located and understood.
6. The staging-only scope, allowlist, retention, and least-privilege access are
   reviewed; no production system has been changed or claimed qualified.

## Explicitly out of scope

- Production telemetry, dashboards, alarms, retention, deployment, or access
  changes.
- A production SLO, paging policy, cost commitment, or token-budget policy.
- Recording prompts, answers, meeting material, user data, Slack data, or
  provider payloads for debugging.
- A second telemetry database, metric streams, log subscription pipeline,
  OpenSearch, managed Grafana, or a data warehouse.
- Browser-side AWS credentials or a mutating observability console.
- Automatic OpenTelemetry/ADOT or X-Ray migration. Those remain a later
  portability and tracing decision; this event contract must not preclude it.
- Changes to Ask semantics, approval authorization, record durability,
  retrieval release rules, search publication behavior, or provider routing.

## References

- [Private meeting-owner approval V1](2026-08-28-private-meeting-owner-approval-v1.md)
- [Disposable Authority staging sprint V1](2026-08-26-disposable-authority-staging-sprint-v1.md)
- [Authority observability runbook](../operations/RB-OPERATIONS-001-authority-observability.md)
