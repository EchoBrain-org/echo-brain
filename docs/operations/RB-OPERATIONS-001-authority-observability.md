---
schema_version: 1
id: RB-OPERATIONS-001
kind: runbook
title: Deploy and rehearse minimal Authority observability
component_ids:
  - CMP-OPERATIONS-RELEASE
created_at: 2026-08-25
reviewed_at: 2026-08-26
reviewed_ref: d5b3b13c29e161c5d93f14ce3efdc9b0b818e5dc
tested_at: 2026-08-25
---

# RB-OPERATIONS-001: Deploy and rehearse minimal Authority observability

## Trigger, outcome, preconditions, and stop conditions

Use this runbook before an Authority is left unattended or when its
observability stack changes. The outcome is one small, verified loop:

- a scheduled check reaches the real public Authority descriptor;
- sanitized Authority runtime events reach one retained log group;
- repeated probe, worker, or restart failures enter alarm state;
- one confirmed email destination receives alarm and recovery messages.

The operator owns the procedure. Before changing the Authority host, IAM role,
alert destination, or retention policy, or whenever a step would expose
organization content, escalate to the authorized ECHO service owner for a default-hosted
Authority or to the organization's account administrator for an
organization-controlled account.

Under [ADR-0008](../decisions/ADR-0008-echo-hosted-authority-by-default.md),
the operator is ECHO for a default-hosted Authority. For an Authority selected
for an organization-controlled account before provisioning, the operator is
the organization or an explicitly authorized support operator. The selected
account controls the host, logs, alerting resources, keys, and infrastructure
credentials.

Prerequisites:

- the target AWS account and Region are known and the AWS CLI session is active;
- the public Authority hostname resolves and its tunnel is configured;
- the existing EC2 instance role name is known;
- the alert email can be opened to confirm an Amazon SNS subscription;
- the accepted Authority release and deployment directory are present;
- the operator can manage CloudFormation, CloudWatch, Logs, EventBridge,
  Lambda, SNS, KMS, and the one IAM managed policy in the template;
- a short maintenance window is open for the genuine outage rehearsal.

The stack and its events contain operational metadata only. Never put a
credential, bearer session, invitation, note, prompt, answer, raw provider
error, organization identifier, Person identifier, or provider-generation
identifier in a parameter, log event, alarm reason, ticket, or chat message.

Stop before mutation if template validation fails, the change set touches a
resource outside this template, the supplied role is not the Authority host
role, the email endpoint is wrong, or the observed log-group output differs
from `/echo-brain/authority/<authority-host>`. During the outage rehearsal,
restore the Authority immediately if an unrelated error appears or the
maintenance window is nearly over.

## Procedure and observable verification

### 1. Validate and inspect the infrastructure change

From the repository root, choose non-sensitive operator-local values:

```sh
observability_region=us-west-2
observability_stack=echo-authority-observability-v1
observability_change=operator-rehearsal
observability_change_type=CREATE
observability_waiter=stack-create-complete
authority_host=authority.example.com
authority_host_role=existing-authority-host-role
alert_email=operator@example.com

aws cloudformation validate-template \
  --region "$observability_region" \
  --template-body file://deploy/organization-authority/authority-observability-v1.template.json

aws cloudformation create-change-set \
  --region "$observability_region" \
  --stack-name "$observability_stack" \
  --change-set-name "$observability_change" \
  --change-set-type "$observability_change_type" \
  --capabilities CAPABILITY_IAM \
  --template-body file://deploy/organization-authority/authority-observability-v1.template.json \
  --parameters \
    ParameterKey=AuthorityHost,ParameterValue="$authority_host" \
    ParameterKey=AuthorityHostRoleName,ParameterValue="$authority_host_role" \
    ParameterKey=AlertEmail,ParameterValue="$alert_email"

aws cloudformation wait change-set-create-complete \
  --region "$observability_region" \
  --stack-name "$observability_stack" \
  --change-set-name "$observability_change"

aws cloudformation describe-change-set \
  --region "$observability_region" \
  --stack-name "$observability_stack" \
  --change-set-name "$observability_change" \
  --query '{Status:Status,Changes:Changes[*].ResourceChange.{Action:Action,LogicalId:LogicalResourceId,Type:ResourceType,Replacement:Replacement}}'
```

For an existing stack, use a fresh change-set name, set
`observability_change_type=UPDATE`, and set
`observability_waiter=stack-update-complete`. Expected evidence is
`CREATE_COMPLETE` for the change set and only the resources declared by the
committed template. Delete a rejected change set; do not execute it.

### 2. Execute and verify the stack

```sh
aws cloudformation execute-change-set \
  --region "$observability_region" \
  --stack-name "$observability_stack" \
  --change-set-name "$observability_change"

aws cloudformation wait "$observability_waiter" \
  --region "$observability_region" \
  --stack-name "$observability_stack"

aws cloudformation describe-stacks \
  --region "$observability_region" \
  --stack-name "$observability_stack" \
  --query 'Stacks[0].{Status:StackStatus,Outputs:Outputs[*].{Key:OutputKey,Value:OutputValue}}'
```

Expected evidence is a complete stack, one alert topic, one public check
function, one Authority log group, and four alarms.

Open the Amazon SNS confirmation email and confirm it. Then verify that the
subscription is `Confirmed` in the SNS console or `Confirmed` rather than
`PendingConfirmation` in the topic subscription attributes. A deployed stack
with an unconfirmed destination is not operationally complete.

### 3. Bind the Authority deployment to the retained log group

Set `aws_region` in `onboarding.clean-v1.json` to the stack Region. The
onboarding wrapper derives
`ECHO_CLEAN_AUTHORITY_LOG_GROUP=/echo-brain/authority/<authority-host>`; that
value must exactly match the stack's `DockerRuntimeLogGroupName` output.

```sh
cd deploy/organization-authority
./onboard-clean-v1.sh doctor --input-dir /absolute/private/echo-onboarding
./onboard-clean-v1.sh prepare --input-dir /absolute/private/echo-onboarding
./onboard-clean-v1.sh resume
./onboard-clean-v1.sh status
```

Expected evidence is terminal green status and an `authority` log stream in
the retained log group. The proxy remains on the host's local log driver so
request addresses and access details are not centralized.

### 4. Rehearse the destination and recovery notification

Resolve the alarm name from the stack output, then make one temporary state
transition using a generic reason:

```sh
availability_alarm=$(aws cloudformation describe-stacks \
  --region "$observability_region" \
  --stack-name "$observability_stack" \
  --query "Stacks[0].Outputs[?OutputKey=='ExternalDescriptorFailureAlarmName'].OutputValue | [0]" \
  --output text)

aws cloudwatch set-alarm-state \
  --region "$observability_region" \
  --alarm-name "$availability_alarm" \
  --state-value ALARM \
  --state-reason 'Authority observability rehearsal'

aws cloudwatch set-alarm-state \
  --region "$observability_region" \
  --alarm-name "$availability_alarm" \
  --state-value OK \
  --state-reason 'Authority observability recovery rehearsal'
```

Expected evidence is one alarm email and one recovery email. The scheduled
metric evaluation can also restore the real state; verify the final alarm state
rather than assuming the manual `OK` persists.

### 5. Inspect core worker lifecycle events

Resolve the retained runtime log group from the stack rather than guessing a
host-derived name:

```sh
authority_log_group=$(aws cloudformation describe-stacks \
  --profile echo-prod \
  --region "$observability_region" \
  --stack-name "$observability_stack" \
  --query "Stacks[0].Outputs[?OutputKey=='DockerRuntimeLogGroupName'].OutputValue | [0]" \
  --output text)
```

In CloudWatch Logs Insights, select `$authority_log_group` and use this query:

```
fields @timestamp, kind, event, cycle_phase, elapsed_ms, failure_class, retryable
| filter kind in ["echo-clean-live-worker-phase-v1", "echo-clean-live-worker-cycle-v1"]
| sort @timestamp desc
```

The phase events are content-free and tool-agnostic. A `started` event without
a terminal event is inconclusive: it may be in flight, stalled relative to the
expected operation timeout, terminated with the process, or absent because log
delivery was interrupted. A cycle `succeeded` event is also the heartbeat for
an empty source poll. For failures inside a started worker cycle,
`retryable: true` means the serialized worker will automatically begin a later
cycle. `cancelled` with `retryable: false` means shutdown stopped the in-flight
work; startup failures are also non-retryable because no worker cycle exists.

Do not place or infer meeting/provider content, identifiers, credentials,
prompts, raw errors, or stack traces from these fields. The legacy
`echo-clean-live-worker-failed-v1` event remains only for the existing aggregate
metric and alarm. It is not part of new lifecycle diagnosis, and this slice
does not add alarms, a status API, correlation, or close #87.

#### Inspect the staging journey transport heartbeat

For `https://authority-staging.echobrain.org` only, use the same retained
`authority` log stream and run this Logs Insights query:

```
fields @timestamp, event, release_sha, build_number
| filter kind = "echo-authority-journey-telemetry-liveness-v1"
| sort @timestamp desc
```

Expected evidence is one `startup` event for each Authority process followed
by a `heartbeat` approximately every 60 seconds while that process remains
running. `release_sha` must be the image's lowercase 40-character Git revision
and `build_number` must be the image's positive numeric CI run ID. The image
build verifies both values against its OCI metadata before publishing it. The
staging update verifier also rejects a telemetry-capable image or running
container whose label and effective environment bindings disagree.

Stage metadata and heartbeat records are content-free and best effort. The
separate opt-in development content records described below share this transport.
At the service boundary,
missing or malformed immutable image identity disables only the staging journey
telemetry transport; it must not prevent Authority startup or request handling.
A guarded staging update rejects inconsistent telemetry-capable image metadata
before accepting the candidate, preserving the currently accepted runtime. The
Docker `awslogs` driver
delivers the JSON lines using the host role's log-stream-only permission, so no
AWS credential is exposed to a browser. Journey metrics, alarms, dashboards,
and the operator Explorer are separate from this core liveness loop. Do not
enable or rehearse this transport against a production Authority in this sprint.

#### Staging journey overview and Explorer

A read-only staging inspection on 2026-09-08 verified the journey overview,
the fixed Explorer Lambda and policy, and a redacted Journey Explorer query.
This is dated staging evidence, not a standing claim about a future deployment:
inspect the stack, alarm state, and current journey before relying on it. The
overview and Explorer remain staging-only and are never a production
observability path.

The formatter and `authority-staging-journey-observability-v1.template.json`
are dedicated to staging and distinct from the
generic `authority-observability-v1.template.json` stack, and can select only
`/echo-brain/authority/authority-staging.echobrain.org`. It therefore cannot
create a production journey resource, permission, dashboard, alarm, retention
change, or deployment path.

The overview emits content-free CloudWatch Embedded Metric Format (EMF) records
beside the canonical raw `echo-authority-journey-stage-v1`, liveness, and
approved-search-backlog log records. EMF is a projection of the same event,
not a second ingestion path and requires no application-managed browser
credential. Within this
dedicated stack, `WorkerCycleCompleted` is the only log metric filter. All
journey, LLM, retrieval, liveness, and backlog metrics are EMF. Recent-run and
Logs Insights views are bounded by the existing 14-day Authority log retention.
A result older than that bound is unavailable rather than inferred.

The formatter defines this fixed metric dictionary. Dimensions are only the
versioned low-cardinality fields listed below; `journey_id`, release SHA,
build number, and every business or person identifier are never dimensions.

| Metric | Value and population rule | Dimensions |
| --- | --- | --- |
| `StageStarted`, `StageSucceeded`, `StageFailed`, `StageSkipped` | `1` for the corresponding canonical stage event | `workflow`, `stage` |
| `StageClosedLatencyMs` | `elapsed_ms` for succeeded or failed measured machine stages; recovery and shared references are excluded | `workflow`, `stage` |
| `StageRetryAttempt` | `1` for a measured execution start with `accounting.retry_of_attempt`; skipped, recovered and historical ordinal observations are excluded | `workflow`, `stage` |
| `TerminalOutcome` | `1` for a succeeded stage with a non-null bounded stage outcome | `workflow`, `stage`, `outcome` |
| `StageFailure` | `1` for a failed stage | `workflow`, `stage`, `failure_class` |
| `AskRetrievalFailure` | `1` for a failed `ask_retrieval` stage | none |
| `CoreModelAttempt`, `CoreModelTotalTokens`, `CoreModelUsageReported` | actual terminal model call; non-null total tokens and total-usage coverage, across extraction, related projection, planner and answer | `workflow`, `stage` (purpose) |
| `LlmAttempt`, `LlmUsageReported`, `LlmUsageUnavailable`, `LlmProviderLatencyMs` | one terminal LLM-attempt count, usage-status count, and provider RTT | `stage`, `provider`, `model` |
| `LlmInputTokens`, `LlmOutputTokens`, `LlmTotalTokens`, `LlmCachedInputTokens`, `LlmReasoningTokens` | the respective non-null provider-reported value only | `stage`, `provider`, `model` |
| `LlmTotalTokensAvailable` | `1` only when that attempt has a non-null total-token value | `stage`, `provider`, `model` |
| `RetrievalPlannedQueries`, `RetrievalQueryHits`, `RetrievalReleasedAtoms`, `RetrievalContextAtoms`, `RetrievalCitations` | the respective non-null retrieval counter | `workflow`, `stage` |
| `ApprovalHumanWaitMs` | `queue_age_ms` from card staging to verified action | `workflow`, `stage` |
| `JourneyTelemetryAlive`, `WorkerCycleCompleted` | `1` for liveness output and a completed worker cycle, respectively | none |
| `ApprovedSearchPendingCount`, `ApprovedSearchStuckCount`, `ApprovedSearchBacklogCheck`, `ApprovedSearchOldestAgeMs` | explicit-zero durable backlog gauge, stuck-gauge, scan heartbeat, and oldest pending age | none |

`tokens per total-token-available LLM attempt` means the sum of `LlmTotalTokens`
divided by `LlmTotalTokensAvailable` within the displayed grouping and period.
The separate usage-coverage ratio is `LlmUsageReported / LlmAttempt`. This
distinction prevents a partial provider usage report with no total from being
treated as a zero-token attempt. A bounded Logs Insights view separately sums
non-null total tokens across every attempt in each recognized completed
journey, then reports per-request totals and p50/p95/p99 by workflow.
`TerminalOutcome` is the metric name for a bounded stage result; values such
as `actionable`, `staged`, and `superseded` do not by themselves mean that the
whole journey completed. End-to-end queries recognize only Ask response
success, meeting search `current` or `published`, meeting rejection or denial,
and non-retryable failure as journey-terminal boundaries.

End-to-end timing is a Logs Insights derivation over one correlated journey.
The dashboard uses the supported
[`parseDate(fieldName, format [, timezone])`](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CWL_QuerySyntax-operations-functions.html)
function to convert the canonical ISO-UTC `observed_at` value to milliseconds.
It requires that the selected dashboard range contains the canonical journey
start (`event = started` and `sequence = 1`) as well as a recognized terminal
success or non-retryable failure. A range that cuts off the start is excluded
from both wall-clock and completed-journey token totals, rather than reporting
a shortened journey. Full journey wall-clock is terminal `observed_at` minus
that canonical start and therefore includes approval wait. Service wall-clock
subtracts the one measured `queue_age_ms` approval interval only after the
query proves it cannot go negative; a contradictory partial or malformed
journey is excluded rather than clamped. Ask subtracts zero. Neither measure
sums stage durations, so retries and inter-stage gaps remain visible.

Human wait is intentionally different: it is the `queue_age_ms` from approval
card staging to verified human action. It appears as a separately labelled
business interval, never in `StageClosedLatencyMs`, end-to-end
machine percentiles, availability calculations, or a latency alarm.

The dashboard layout is deliberately small:

1. alarm status and telemetry heartbeat;
2. Ask response and meeting stage outcomes plus the meeting funnel;
3. stage p50/p95/p99 machine latency plus full and wait-excluded end-to-end
   p50/p95/p99 wall-clock;
4. LLM token totals by step, tokens per total-token-available attempt, usage coverage,
   completed-request token totals, and retries;
5. approved-search pending count/oldest age and four bounded Logs Insights
   tables for recent safe failures, full/service wall-clock, completed-journey
   token totals, and per-stage success/failure/retry rates.

The initial quick-detection alarms are: successful worker cycles missing in two
of three one-minute periods; two Ask retrieval failures in five minutes; and a
durable approved-search backlog whose age is at least five minutes and whose
stuck gauge is at least one for two of three one-minute periods. The final
alarm consumes the explicit pending-work observation above, not a best-effort
join in a dashboard query. Latency and token anomaly alarms are explicitly
deferred until a measured staging baseline exists.

Local verification covers formatter, transport, template/query, and
deterministic fixture reconciliation: dashboard aggregates reconcile with the
fixture's raw canonical journey events and approved-search state.

#### Explorer backend

The separate `authority-staging-journey-explorer-v1.template.json` and its
inline Node handler are staging-only and accept only
`/echo-brain/authority/authority-staging.echobrain.org` as the source log group.
The backend is invoked directly by a CloudWatch custom widget. It is not a
public service: there is no function URL, API Gateway route,
application-managed or end-user AWS credential, direct widget permission to
CloudWatch Logs, or mutation operation. The companion policy grants the
signed-in console operator only
invocation of the exact Lambda. It does not establish the scope of other
policies in that session; review the effective permission set separately.

The handler accepts six fixed operations:

1. `describe` returns safe widget metadata.
2. `list` runs a fixed query for recent redacted journeys. The default time
   range is eight hours, the maximum is the 14-day retained-log boundary, and
   a page has at most 25 journeys. Its pending summary retains the latest
   approved or superseded milestone even when a later event is non-terminal.
3. `detail` accepts one canonical lowercase UUID journey ID and runs a fixed
   correlated-event query over the bounded 14-day retained history, not the
   dashboard's selected list range. It requires the canonical sequence-one
   `ask_validation`, `meeting_source_intake`, or root `core_operation` started event; otherwise it
   returns `journey_history_incomplete` and does not report a clipped timeline
   or wall-clock.

4. `related` accepts the selected journey UUID and finds core operations that
   explicitly link it. Follow a shared build once to inspect its model calls.
5. `content` lists captures for a journey or operation, and accepts one optional
   positive `capture_sequence` to load a capture on demand. It reassembles the
   versioned chunks, checks count/byte consistency, and labels partial capture
   or missing/conflicting chunks. Content is escaped text in the same widget.
6. `health` reads the latest bounded transport heartbeat observations and their
   cumulative delivery counters. Historical records without counters are unknown.

Journey and content queries have a 2,500-record cap and return `result_limit_exceeded` if it
is saturated instead of silently omitting a journey or showing a partial
waterfall. Narrow the dashboard time range before retrying that safe error for
`list`; a `detail` request already uses the full bounded retained history.

The client cannot supply Logs Insights text, a query ID, `SOURCE`, a raw log
message, prompt, answer, source content, or other event content. Every query
filters `environment=staging`. The handler rejects unknown parameter keys and
uses finite allowlists for workflow, stage, event, outcome, failure class,
provider, model, finish reason, and usage status. Returned detail is an
allowlisted projection only: schema version, journey UUID, sequence, attempt,
release SHA/build number, event times and elapsed latency, provider latency,
nullable token usage, retrieval counts, retry/failure metadata, and human
wait and the finite V2 core diagnostic projection. No operation returns
`@message`. Only `content` returns opt-in sanitized development content.

Interpret timing as follows: full wall-clock is first-to-terminal
`observed_at`, service wall-clock subtracts the one `queue_age_ms` human-wait
interval, and human wait stays separately labelled rather than becoming
machine latency or an availability signal. A non-retryable `failed` stage is a
terminal failure. An approved or superseded stage alone is still pending until
the workflow reaches a recognized terminal boundary.

The Lambda execution role may start and read queries only against that exact
source log group, stop a query only through the AWS-required unscoped action,
and write only to its dedicated 14-day retained function log group. The stack
also creates the fixed `customWidget-echo-staging-journey-explorer-v1` Lambda
and the exact-function `lambda:InvokeFunction` customer managed policy
`echo-staging-journey-explorer-invoke-v1` at path `/`.
Query cancellation is bounded and best-effort. If `StartQuery` times out, the
handler aborts its SDK request and waits up to one additional second for a
valid late query ID. An ID received in that window gets one separately bounded
`StopQuery` attempt before the handler returns. Without an ID, the remote
outcome is unknown and no post-response cleanup is launched.
It is intentionally unattached: the `AWSReservedSSO` roles used by operators
Center-protected and must not be edited directly. Before a widget is added or
invoked, Phase 6 must reference this policy from a dedicated staging-only
Identity Center permission set. The inline staging Lambda relies on the Node
runtime-provided AWS SDK v3; a portable production bundle and pinned SDK
version are deferred to a future production review.

#### Explorer UI

The renderer is implemented in the staging overview dashboard. It remains a
read-only, staging-only surface; the dated inspection above does not authorize
production use or a broader Identity Center assignment.
The dashboard passes a static endpoint, not an operator-supplied ARN:

```text
arn:${AWS::Partition}:lambda:${AWS::Region}:${AWS::AccountId}:function:customWidget-echo-staging-journey-explorer-v1
```

The UI is read-only and intended for an authorized operator. A signed-in IAM
Identity Center console operator may invoke that Lambda after its dedicated
staging-only permission set references
`echo-staging-journey-explorer-invoke-v1` at path `/`. That managed policy
grants only exact-Lambda invocation; the effective permission set must be
separately reviewed for broader access. The widget has no direct CloudWatch
Logs permission, public dashboard sharing, function URL, API Gateway route,
application-managed credential, end-user credential, production target, or
mutation operation.

The list surface shows recent Ask and approval journeys. Selected detail shows
safe outcome, a chronological stage-and-attempt waterfall whose bars are
positioned by validated observation time and sized by `elapsed_ms`, LLM token
totals, retries, retrieval counts, redacted failure metadata, and human wait as
a separate business interval and empty gap rather than machine work. A numeric
token count of `0` means the provider reported zero; `null` means usage was
unavailable and is never treated as zero. Metadata remains an allowlisted
projection. Development input/output is available separately through the
`content` action under the scoped switch below. Neither surface returns raw
log messages or transport headers.

The renderer inherits the query safety boundary. The selected range may not
exceed the retained 14-day staging window; a fixed query that reaches its
2,500-event cap returns `result_limit_exceeded` instead of partial list or
detail; unknown/noncanonical events are rejected; and a renderer response that
would exceed its bounded safe size returns fixed error markup rather than
truncating data or exposing raw logs. Operators should narrow the range and
retry a `result_limit_exceeded` response.

#### Reading core runtime evidence (V2)

The [area-1 handoff](../product/2026-09-08-core-runtime-observability-sprint-v1.md)
extends the existing event kind with `schema_version: 2` when diagnostic or
execution-accounting fields are present. Original V1 records remain readable.
Core observations use workflow `core_runtime`, stage `core_operation`, an
operation UUID, span/parent UUIDs, and finite `phase` and `purpose` categories.
They share the existing JSON-lines/EMF path. Metadata is enabled only through
the existing staging transport gate and immutable image identity.

Select a slow meeting or Ask, then use **Linked core operations** to inspect its
worker or server operation. A worker request has an independent operation even
when HTTP schedules it and returns first. `gate_wait_ms` measures admission to
the serial gate; its child `worker_execution` measures execution. Timer spans
record the scheduled delay, actual wake lateness, periodic/failure reason and
cancellation. A coalesced approval wake is marked on the requesting operation.
These observations distinguish the existing 30-second timer from gate waits.
No scheduling or retry interval changes are part of this extension.

Search exposes snapshot, enrichment, related-model calls, local build,
validation and publication separately. Captured/current/published record heads
and generation identity show exact-head availability or supersession. Record,
atom, input/output byte, visibility-group, selected/excluded and recomputation
counts describe actual work. Changed/unchanged/newly-observed group counts are
relative to this process's previous observed projection input; after restart
there is no historical comparison. `reused_count: 0` reports the current lack
of a projection cache. Shared search references link covered approvals to the
same operation; do not sum their durations or model usage as separate builds.

Every actual model call has its own span, purpose, nullable usage and bounded
provider/model/finish categories. Provider request IDs are domain-separated
hashes in metadata and may be present verbatim in sanitized content. Parse,
schema and grounding boundaries remain separate from provider failures.
Extraction HTTP rejection preserves the existing immediate error behavior:
its content record explicitly says `not_read_after_http_rejection`; it does
not claim to contain that rejected body. Successful HTTP responses, including
invalid JSON, retain their actual response text in the content channel.

The HTTP span ends at response finish or connection close; it is server-side
observation, not client receipt or a person's card-view time. The Slack terminal
update span reports provider `done`/`uncertain` or failure separately from
approval commit and searchable publication. The existing Ask stage sequence,
current-Person checks, exact-head reads and audit-before-release still apply.

The Explorer displays nested spans, links, raw finite diagnostic fields,
missing sequence counts, union of observed machine intervals and the remaining
unaccounted interval. Overlapping spans count once; these fields are diagnostic
coverage, not an exclusive CPU accounting or a proven distributed critical
path. UTC positions provide cross-operation correlation and monotonic clocks
provide new elapsed durations. Recovery has no measured elapsed time. V1
retry counts are visibly unknown, never `attempt - 1`.

The disposable sidecar upgrades from schema 1 to 2, preserving historical rows
as `legacy`. A skip reserves only an event sequence, not an execution attempt.
A newly measured retry links a prior failed execution. Interrupted stages and
facts recovered from durable state are labelled `recovery`, not measured
failure/retry latency or extra LLM attempts. A competing click is recorded as
such without denying or skipping the winning append/search. The overview shows
measured retries and an explicit historical-unknown count. Do not combine
`CoreModel*` totals with the existing `Llm*` projections: those are overlapping
views of the same calls, and the old projection does not cover related search.

CPU, RSS, heap, filesystem operation counters, event-loop delay, active model
calls and active HTTP requests are process observations and can overlap other
operations. Event-loop maximum is since transport startup, not an exclusive
span sample. SQLite lock time and disk-I/O latency are explicitly unavailable;
filesystem counters are not latency or physical-byte measurements. Host-level
resource attribution still requires operator evidence.

#### Opt-in development content and transport completeness

For the explicitly authorized area-1 development rehearsal,
`ECHO_STAGING_JOURNEY_CONTENT_TELEMETRY_V1=true` additionally captures meeting
input, actual model request/response bodies, exact validation error evidence,
and the existing Ask prompts, released context and answers. It requires the
existing staging metadata gate and valid deploy identity. The default content
switch, production configuration, retention, permissions and deployment lane
are unchanged. This is the scoped evolution of the original Ask-only contract.

V2 content uses `json_chunks`, capture ID/sequence, span ID, UTC time, chunk
index/count, total captured bytes and an explicit `truncated` flag. Chunks have
24,000 Unicode characters. The sanitizer bounds traversal at 32 levels and an
8 Mi character/node budget; overflow is partial, not complete capture. It
excludes credential/key/grant fields and recognized secrets in text, including
bearer/basic authorization, private keys and opaque grant shapes. Producers
project request bodies rather than headers, request/configuration objects or
credential resolvers. Redacted values are intentionally not reconstructable.
The Explorer rejects saturated queries and responses above its 1 MiB display
bound instead of silently shortening evidence. Large individual captures may
therefore require the operator's existing bounded log-inspection lane.

Heartbeat `delivery` fields report local writes attempted/failed/pending/dropped,
rejected observations, attempted bytes, writer/serialization overhead in
microseconds and partial captures. Pending writes and active core operations
are bounded at 1,000. Counters are cumulative for that process; they do not
prove downstream awslogs/CloudWatch ingestion. A completely dropped tail may
lack a detectable sequence gap: compare heartbeat health and durable outcomes,
and treat a missing terminal as incomplete. A broken writer cannot report its
own failure until some output succeeds. Observer/sidecar/content failures stay
outside business control flow.

#### Runtime metric and alarm attribution

The legacy `EchoBrain/AuthorityOperations` metrics have no dimensions and may
combine events from multiple contributing log groups in the same account and
Region. An alarm email alone cannot identify the host. The received recovery
email at `2026-09-08T23:51:02Z` concerned
`echo-authority-observability-v1-authority-alerts`; the earlier empty subscription
inspection concerned a different staging topic. Neither justifies a subscription
replacement or deletion.

`authority-observability-v1.template.json` keeps the legacy filters and enabled
alarm actions, and adds matching filters in
`EchoBrain/AuthorityOperations/${AuthorityHost}`. The two comparison alarms
have `ActionsEnabled: false`, so the proposed update adds no duplicate alarm
notifications. This host-specific namespace separates source attribution while
preserving historical metrics. Namespace, name and dimensions define metric
identity; filters and alarms must select the same identity. See the official
[CloudWatch metric concepts](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/cloudwatch_concepts.html),
[metric transformation contract](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-logs-metricfilter-metrictransformation.html),
and [alarm actions contract](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-cloudwatch-alarm.html).

The new `RuntimeMonitoringAttribution` output and comparison descriptions expose
stack, host, source log group, namespaces, worker alarms and ALARM/OK topic.
Before any future transition, the local operator must verify the actual
stack -> host/log group -> metric identity -> alarm -> ALARM/OK topic ->
confirmed subscription chain, compare both metrics over a bounded window, and
record recovery delivery. Keep legacy actions effective until that separate
reviewed transition. This PR performs no live inspection, SNS repair, deploy or
subscription change. Four-meeting candidate traces, increasing workload and
infrastructure attribution remain pending; offline proofs do not complete live
acceptance.

##### Changing the staging journey stacks

Use an IAM Identity Center
operator session obtained with `aws sso login --profile echo-prod`; do not use
`aws login`, root credentials, SSH, an interactive root shell, a production
target, or a shared permission set. Prefer the AWS MCP server when it is
available. Stop before execution if account, Region, source log group, resource
set, or permission-set scope is not clearly staging-only.

1. Confirm the account, Region, current stack, and assignment with read-only
   inspection before proposing a change, for example:

   ```sh
   aws sts get-caller-identity --profile echo-prod
   ```

2. Create and inspect a change set for
   `authority-staging-journey-explorer-v1.template.json` first. Use
   `--profile echo-prod`, the staging Region, a fresh change-set name, and
   `CAPABILITY_NAMED_IAM`. Confirm that it creates or changes only the dedicated
   Explorer Lambda, its retained log group and execution role, and the fixed
   `echo-staging-journey-explorer-invoke-v1` policy. Do not execute a change set
   with an unexpected resource, a non-staging source log group, or a broader
   Logs or invoke permission.
3. Only after that backend change set has been approved and executed, have the
   authorized IAM Identity Center administrator reference the named policy at
   path `/` from a dedicated staging-only permission set. Review the effective
   permission set and its account assignments for broader or non-staging
   access; the narrow managed policy alone does not prove the session is narrow.
   Do not edit an `AWSReservedSSO` role directly. Record the permission-set
   review without copying IDs, credentials, or content into this runbook.
4. Create and inspect the overview change set second, also with
   `--profile echo-prod`. Confirm it remains the existing staging-only overview
   resource set and its custom widget references only the static Explorer ARN
   above. It must not add direct Logs permissions to the operator or dashboard,
   enable public sharing, or touch production.
5. After both staging stacks and the permission-set reference are verified,
   explicitly trust the custom widget in the CloudWatch console while signed in
   as the authorized operator. Keep dashboard sharing disabled.
6. Run exactly one real staging Ask and one real staging approval. For each,
   use the Explorer to find the correlated, redacted journey and confirm its
   stage/attempt sequence, machine latency, token value or `null`, retry and
   retrieval metadata, human wait where applicable, and terminal outcome agree
   with the overview aggregates. Record only content-free correlation and
   aggregate evidence. Stop and investigate any missing, partial, unredacted,
   cross-environment, or inconsistent result.

Use this procedure only to change the staging journey stacks or their access
assignment. Normal journey inspection uses the existing verified configuration;
it does not require repeating setup or a change set.

### 6. Rehearse the sanitized worker-failure signal

Use a dedicated rehearsal stream and only the fixed schema event. Emit three
events inside five minutes so the repeated-failure alarm has a deterministic
input:

```sh
authority_log_group=$(aws cloudformation describe-stacks \
  --region "$observability_region" \
  --stack-name "$observability_stack" \
  --query "Stacks[0].Outputs[?OutputKey=='DockerRuntimeLogGroupName'].OutputValue | [0]" \
  --output text)
rehearsal_stream=authority-observability-rehearsal-$(date -u +%Y%m%dT%H%M%SZ)
rehearsal_epoch_ms=$(( $(date +%s) * 1000 ))

aws logs create-log-stream \
  --region "$observability_region" \
  --log-group-name "$authority_log_group" \
  --log-stream-name "$rehearsal_stream"

aws logs put-log-events \
  --region "$observability_region" \
  --log-group-name "$authority_log_group" \
  --log-stream-name "$rehearsal_stream" \
  --log-events \
    timestamp="$rehearsal_epoch_ms",message='{"schema_version":1,"kind":"echo-clean-live-worker-failed-v1"}' \
    timestamp="$rehearsal_epoch_ms",message='{"schema_version":1,"kind":"echo-clean-live-worker-failed-v1"}' \
    timestamp="$rehearsal_epoch_ms",message='{"schema_version":1,"kind":"echo-clean-live-worker-failed-v1"}'
```

Expected evidence is a `WorkerFailure` metric value of three, the repeated
worker-failure alarm entering `ALARM`, and the alarm later returning to `OK`
when the five-minute evaluation window clears. Do not synthesize an exception
containing product data.

### 7. Rehearse the real public failure path

From the Authority deployment directory during the maintenance window:

```sh
docker compose --env-file .env.clean-v1 \
  -f compose.clean-v1.yaml -f compose.clean-v1.ec2.yaml stop authority
```

Expected evidence within the 2-of-3 one-minute window is failed scheduled
checks and an availability alarm email. Restore the exact accepted deployment:

```sh
docker compose --env-file .env.clean-v1 \
  -f compose.clean-v1.yaml -f compose.clean-v1.ec2.yaml \
  up -d --no-build --wait --wait-timeout 90 authority
docker compose --env-file .env.clean-v1 \
  -f compose.clean-v1.yaml -f compose.clean-v1.ec2.yaml restart proxy
docker compose --env-file .env.clean-v1 \
  -f compose.clean-v1.yaml -f compose.clean-v1.ec2.yaml \
  up -d --no-build --wait --wait-timeout 90 authority proxy
./onboard-clean-v1.sh status
curl --fail --silent --show-error --output /dev/null \
  "https://$authority_host/v1/authority-descriptor"
```

The explicit proxy restart is required because `proxy` shares the Authority
container's network namespace. Stopping and starting only `authority` can leave
Compose reporting the proxy as running while that proxy still serves from the
stopped namespace.

Expected recovery evidence is terminal green status, successful descriptor
checks, the alarm returning to `OK`, and a recovery email. This is the only
step that intentionally interrupts the product path.

## Rollback, containment, evidence, and follow-up

If the stack deployment fails, inspect its events without copying parameter or
log contents into chat. Roll back the failed change set or stack update. Do not
delete the retained KMS key or log groups as an immediate troubleshooting step.

If Docker cannot create the Authority log stream, keep the runtime stopped only
for the bounded maintenance window. Confirm the exact host role, Region, and
log-group output, then restore the prior Compose deployment if the mismatch
cannot be corrected safely. The observability stack does not authorize changes
to Authority records or credentials.

Record only:

- exact source commit and stack status;
- Region, stack name, logical resource names, and timestamps;
- SNS subscription confirmed or pending;
- alarm and recovery timestamps;
- terminal Authority status booleans;
- whether the synthetic and real failure paths were observed.

Do not record event bodies from normal runtime logs. Set `tested_at` only after
the destination, sanitized worker signal, genuine outage, and recovery have all
been observed from the exact committed template.
