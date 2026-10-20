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
function, one Authority log group, and six alarms: four that notify and the two
attributed comparison alarms with actions disabled (see Runtime metric and
alarm attribution).

Open the Amazon SNS confirmation email and confirm it. Then verify that the
subscription is `Confirmed` in the SNS console or `Confirmed` rather than
`PendingConfirmation` in the topic subscription attributes. A deployed stack
with an unconfirmed destination is not operationally complete.

### 3. Bind the Authority deployment to the retained log group

Set `aws_region` in `onboarding.clean-v1.json` to the stack Region. The
onboarding wrapper derives
`ECHO_CLEAN_AUTHORITY_LOG_GROUP=/echo-brain/authority/<authority-host>`; that
value must exactly match the stack's `DockerRuntimeLogGroupName` output.

On the EC2 host, run the installed wrapper with `sudo`; the private input
directory and its files must then be root-owned (see the
[deployment guide](../../deploy/organization-authority/README.md#one-time-preparation)).

```sh
cd /srv/echo-authority-clean-v1
sudo ./onboard-clean-v1.sh doctor --input-dir /absolute/private/echo-onboarding
sudo ./onboard-clean-v1.sh prepare --input-dir /absolute/private/echo-onboarding
sudo ./onboard-clean-v1.sh resume
sudo ./onboard-clean-v1.sh status
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

A later worker cycle does not authorize another model call for unchanged
meeting input, except one automatic retry after an unbilled 429 or 5xx on the
first attempt. The live runtime durably reserves one automatic extraction
attempt before contacting the provider. Failed grounding, provider failures,
and interrupted attempts park that meeting across polls and restarts while
intake moves on to the source's later meetings, so a cycle that parks one still
succeeds. Use the content-free
[extraction status and explicit retry procedure](../../deploy/organization-authority/README.md#inspect-and-retry-a-held-extraction)
to inspect the hold; a successful HTTP response alone does not prove that its
output passed grounding or became an approval candidate.

Do not place or infer meeting/provider content, identifiers, credentials,
prompts, raw errors, or stack traces from these fields. The legacy
`echo-clean-live-worker-failed-v1` event remains only for the existing aggregate
metric and alarm. It is not part of new lifecycle diagnosis, and this slice
does not add alarms, a status API, correlation, or close #87.

#### Inspect the shared trace transport heartbeat

Staging and production use the same core context and transport implementation.
Use the target Authority's retained `authority` log stream and run this query:

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

Stage metadata and heartbeat records are content-free and best effort.
At the service boundary,
missing or malformed immutable image identity disables only the journey
telemetry transport; it must not prevent Authority startup or request handling.
A guarded staging update rejects inconsistent telemetry-capable image metadata
before accepting the candidate, preserving the currently accepted runtime. The
Docker `awslogs` driver
delivers the JSON lines using the host role's log-stream-only permission, so no
AWS credential is exposed to a browser. Journey metrics, alarms and dashboards
are separate from this core liveness loop. The
existing image capability label `ECHO_STAGING_JOURNEY_TELEMETRY_V1` retains its
name for release compatibility. The service selects `environment=staging` for
the staging origin and `environment=production` otherwise. Production EMF uses
`EchoBrain/AuthorityJourneyV1`; staging retains `EchoBrain/StagingJourneyV1`.

#### Follow a research execution and select private payload capture

`shared/core-runtime-observation-v1.ts` owns operation/span context for source
processing, approval, research, model calls, tools, release and output reads.
CloudWatch events and metrics are projections of that context. Historical Ask
journey records remain readable.

Each research execution carries a registered trigger label and hashed run ID.
An approved-record execution also carries a hashed approval event ID and a
unique attempt ID. Background execution starts its own operation linked to the
request that started it. Human approval wait does not keep a machine span open.
Follow the approval event hash across publication and execution, and the output
hash from committed card storage to later card reads. The durable approval/run
tables and audits remain the business source of truth.

Routine traces contain finite labels, opaque hashes, counts and timings. Exact
payload capture is selected separately through authenticated Person diagnostics:
prepare an `ask` or exact `trigger_run` target, then supply its one-use
`capture_id` on the ordinary Ask request or existing run `start`. This does not
approve a meeting, change the research brief, or change the product response.
A `start` that answers `pending` was held, impact run or sweep, while the
search index catches up with the record log: it claimed neither the run nor the
capture, which nothing will claim now, so prepare a new capture and start again
shortly.
The same shared observer records model-port inputs, exposed structured replies,
tool inputs/results, automatic starting reads and lifecycle outcomes. These are
observable decisions, not hidden model reasoning or provider HTTP credentials.

Captures stay in process memory: at most eight globally and two per actor,
8 MiB/512 events each, with a 15-minute expiry and a non-extending 60-second
window after a terminal read. Capacity loss marks a trace incomplete. Restart
or expiry loses its payloads; CloudWatch metadata has independent retention.
Only the originating organization, principal and membership may claim/read it.
Every terminal read revalidates source access and the reading session. Failed
runs can be inspected only while those checks still pass; known revocation
erases content. Payloads never enter CloudWatch or immutable audit/run storage.

Use the [research trace exporter](../../tools/evals/research-loop/README.md#one-ordinary-request-diagnostic-trace)
to save the receipt before execution and export private files. Resume reads
with the saved capture ID after a lost response; do not repeat the Ask to
recover its trace. The staging evaluator uses the same operational spans;
payload capture has one API and collector, on ordinary product requests.

#### Follow a meeting from intake to approval delivery

Personal Granola and synthetic intake use the same core-runtime channel. Join
`source_poll` and extraction within the worker operation; follow the hashed
`meeting_id` through `extraction`, `candidate_persist` and `approval_staging`.
The staging event links that meeting to a hashed `approval_id`, which later
worker passes and review requests reuse. `attempt` on extraction is the durable
attempt ledger ordinal. A parked meeting ends its worker pass with `result=held`;
a scheduled extraction retry reports `retry_pending`. Grounding failures carry
an allowlisted `grounding_stage`, such as `evidence_id`, without the cited IDs.
The attempt ledger remains authoritative for holds and retry authorization.

| Evidence | What it proves |
| --- | --- |
| `approval_staging`, `published` | A frozen proposal is available for review. |
| `approval_review`, desktop, `returned` | The authenticated review-open handler produced the review; it does not prove screen rendering or human viewing. |
| `approval_delivery`, Slack, `post_marker` / `reconcile_marker`, `completed` | Slack returned the placeholder's message reference; the approval card still needs publishing. |
| `approval_delivery`, Slack, `publish_card`, `done` | Slack accepted the card update, not that the person read it. |
| `approval_delivery`, `retry_pending` / `failed` / `unrepresentable` | Delivery was deferred, exhausted/invalidated, or the Slack card for that approval could not be built (too large for Slack, or a build error). |
| `approval_action`, `done` | The shared approval core committed the human's decision. |

Delivery spans cover actual provider attempts and state transitions. Idle
reconciliation, unchanged cards, and review-list polls add no new events.
An unlinked Slack reviewer has no delivery attempt; inspect the existing tool
and identity-link status in that case. Human wait is not an open machine span.
These fields are available in the existing CloudWatch `diagnostic` JSON; no
separate log stream is introduced.

For one meeting's exact extraction evidence, use the existing Person client
`diagnostics()` method to prepare this request **before** the next extraction:

```json
{
  "schema_version": 1,
  "operation": "prepare",
  "target": {
    "kind": "meeting_extraction",
    "source_key": "pms_<64 lowercase hex characters>",
    "meeting_id": "<external meeting ID in this person's source>"
  }
}
```

Use the existing source key from the person's meeting settings. Save the returned
`capture_id`; then import the meeting normally or let its watched source run.
The worker claims the selection only for that person's exact source/meeting
and only when an already-authorized extraction actually runs. Preparation does
not import, retry, approve, spend on a model, or consume a frozen-result replay.
There is at most one active selection for that owner/source/meeting.

Export it with the existing read-only trace command (matching built client):

```sh
npm run eval:research-loop -- trace --capture-id cap_… --out ~/.local/state/echo-meeting-diagnostic-<run>
```

The private trace includes the actual rendered evidence blocks, model request
and raw structured reply. A quote rejection also identifies the signal index,
evidence alias, source block ID/type, rejected quote and exact source text.
The grounding rule and retry policy are unchanged. Capture uses the same
bounded memory, expiry and owner-only read protocol described above; each read
checks the retained source's current intake settings and pinned membership.
Routine metadata contains none of these payloads.

Prepare after any Authority restart: an existing host retry wrapper that
restarts Authority discards an earlier in-memory selection. Capture keeps no
persistent payload and adds no evidence for past attempts.

#### Follow sweep runs and failed open-item reads

A sweep run (a re-check of open items,
[open items and Home v1](../product/2026-10-08-open-items-and-home-v1.md)
section 6) goes through the same launch path and observation as an impact
run. Each attempt is its own background `research_run` operation with trigger
`sweep`, the hashed run ID, a hashed event ID (the sweep's own event
reference; there is no approval) and a unique attempt ID. Its output link
names the stored result, the counts by verdict and the ECHO ids of the items it
could not read; a sweep has no card, so no later card read follows it. Capture
a sweep as any queued run: an exact `trigger_run` target and its `capture_id`
on `start`. The capture records the same lifecycle
outcomes as an impact run's: trigger started, persistence succeeded (or
skipped when the attempt no longer owned the run), and application succeeded
or failed. A sweep that finds no item left to check reads nothing and binds no
desk, so its capture checks the person's session alone.

The open-item operations (`home`, `items` and `item` on the runs route) open
each item they show live as the viewer. A failure that is not the viewer's own
access writes one content-free JSON line to the Authority's standard error,
which reaches the retained `authority` log stream (step 3). A sweep writes the
same line when the stored card of a decision it names cannot be read:

```
fields @timestamp, reason, code
| filter kind = "open_items_live_read"
| sort @timestamp desc
```

`reason` says where the read failed:

| `reason` | Meaning |
| --- | --- |
| `bind` | The request's desk could not be bound; every item it tried reads as unavailable. One line per request. |
| `open` | One item failed to open, or opened in a form the API cannot carry (code `invalid_output`). One line per item. |
| `fence` | The request's final access check failed, so nothing it read is shown. One line per request. |
| `first_line` | A stored impact card could not be read for its decision's first line. |

`code` is the Authority error code (for example `unavailable` or
`rate_limited`), else `error`. The line never carries an item, run, record or
person ID, a title, a pointer or words from outside ECHO. When one item's open
is refused by the viewer's own access (`unauthorized`, `not_found`,
`stale_access_state`), the person sees "you can't open" and no line is
written; a cancelled request writes nothing. A `bind` or `fence` line can
carry those codes too, for example when the viewer's session is revoked
mid-request; its items show as "ECHO couldn't read just now", not as "you
can't open". Repeated `open` lines with `rate_limited` or `unavailable` point
at the item's tool, not at anyone's access: people see "ECHO couldn't read
just now" for those items.

#### Staging journey overview

Inspect the stack, alarm state, and current journey before relying on the
overview. It remains staging-only. The Journey Explorer, a separate staging
Lambda behind the overview's custom widget, and the opt-in staging content
telemetry were retired on 2026-10-19. Research traces go to
[LangSmith](../../deploy/organization-authority/README.md#langsmith-staging-tracing),
and [selected diagnostics](#follow-a-research-execution-and-select-private-payload-capture)
capture exact payloads. Read journeys with the Logs Insights queries in this
runbook. Remove the deployed Explorer with
[Retire the Journey Explorer stack](#retire-the-journey-explorer-stack).

The overview `authority-staging-journey-observability-v1.template.json`
remains dedicated to staging and distinct from the
generic `authority-observability-v1.template.json` stack, and can select only
`/echo-brain/authority/authority-staging.echobrain.org`. It therefore cannot
create a production journey resource, permission, dashboard, alarm, retention
change, or deployment path.

The overview emits content-free CloudWatch Embedded Metric Format (EMF) records
beside the canonical raw `echo-authority-journey-stage-v1` and liveness records.
EMF is a projection of the same event,
not a second ingestion path and requires no application-managed browser
credential. Within this
dedicated stack, `WorkerCycleCompleted` is the only log metric filter. All
journey, LLM, retrieval, and liveness metrics are EMF. Recent-run and
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
| `TerminalOutcome` | `1` for a succeeded stage with a bounded stage outcome, or a terminal `research_run` result | `workflow`, `stage`, `outcome` |
| `StageFailure` | `1` for a failed stage | `workflow`, `stage`, `failure_class` |
| `AskRetrievalFailure` | `1` for a failed `research_loop` (historical `ask_retrieval` remains supported) | none |
| `CoreModelAttempt`, `CoreModelTotalTokens`, `CoreModelUsageReported` | actual terminal model call; non-null total tokens and total-usage coverage, across extraction, related projection, planner and answer | `workflow`, `stage` (purpose) |
| `LlmAttempt`, `LlmUsageReported`, `LlmUsageUnavailable`, `LlmProviderLatencyMs` | one actual terminal `model_call`, usage-status count, and provider RTT; historical role aggregates retain their original semantics | `stage`, `provider`, `model` |
| `LlmInputTokens`, `LlmOutputTokens`, `LlmTotalTokens`, `LlmCachedInputTokens`, `LlmReasoningTokens` | the respective non-null provider-reported value only | `stage`, `provider`, `model` |
| `LlmTotalTokensAvailable` | `1` only when that attempt has a non-null total-token value | `stage`, `provider`, `model` |
| `RetrievalPlannedQueries`, `RetrievalQueryHits`, `RetrievalReleasedAtoms`, `RetrievalContextAtoms`, `RetrievalCitations` | the respective non-null counter once per `research_run`; historical journey events retain their original projection | `workflow`, `stage` |
| `ApprovalHumanWaitMs` | retained historical `queue_age_ms` from card staging to verified action | `workflow`, `stage` |
| `ModelCorrections` | the count of one named correction of model output on a span's terminal event ([counting code's corrections](#count-codes-corrections-of-model-output)) | `correction` |
| `JourneyTelemetryAlive`, `WorkerCycleCompleted` | `1` for liveness output and a completed worker cycle, respectively | none |

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
2. current core approval/search phases, plus clearly labeled historical Ask and meeting outcomes;
3. stage p50/p95/p99 machine latency plus full and wait-excluded end-to-end
   p50/p95/p99 wall-clock;
4. LLM token totals by step, tokens per total-token-available attempt, usage coverage,
   completed-request token totals, and retries;
5. telemetry and worker liveness plus four bounded Logs Insights tables for
   recent safe failures, full/service wall-clock, completed-journey
   token totals, and per-stage success/failure/retry rates.

The initial quick-detection alarms are successful worker cycles missing in two
of three one-minute periods and two Ask retrieval failures in five minutes.
The obsolete approved-search backlog alarm and gauges were retired because the
approved-search backlog observer has no runtime caller. This does not establish
that a stuck approval is covered by another alarm. Latency and token anomaly
alarms are explicitly deferred until a measured staging baseline exists.

Local verification covers formatter, transport, and template/query structure;
dashboard journey-end semantics are not executed locally.

#### Reading core runtime evidence (V2)

V2 adds diagnostics and execution accounting to the existing event kind;
V1 remains readable. Core events use `core_runtime` / `core_operation`,
operation/span/parent UUIDs, and finite phase/purpose categories. The existing
staging gate and immutable image identity enable metadata on the JSON-lines/EMF
path. See the [implementation and acceptance record](../product/2026-09-08-core-runtime-observability-sprint-v1.md).

For a slow meeting or Ask, read its core operations
(`workflow = "core_runtime"`) in Logs Insights; an operation that serves another
journey names it in `diagnostic.linked_journey_ids`:

| Evidence | Interpretation |
| --- | --- |
| Gate wait and child worker execution | Separates queue admission from execution. Queued work owns a trace after its scheduling HTTP request ends. Only gated writer turns (recovery, publication, operator work) report `gate_wait_ms`; periodic cycles, card presentation turns, staging canary runs and each meeting lane are their own `worker_execution` roots. |
| Timer delay, lateness, reason and cancellation | Distinguishes the existing 30-second poll/failure timer from gate waits; coalesced approval wakes appear on the requesting operation. |
| Search snapshot, enrichment, model, build, validation and publication | Heads/generation identify availability or supersession. Atom/record/byte/group and selected/excluded counts identify work. |
| Changed/unchanged/new projection groups; `reused_count: 0` | Compares with the previous observed input in this process, not persisted history or a cache. Restart loses that comparison. |
| Model calls, purpose, nullable usage and parse/schema/grounding spans | Distinguishes provider failures from validation and separates extraction, related projection, planner and answer work. Request IDs are hashed in metadata. |
| HTTP finish/close and Slack `done`/`uncertain`/failure | Server/provider observations, separate from approval commit and searchable publication; they do not measure client receipt or a person's card-view time. |

Core events carry opaque run, event, output, attempt, source-revision and
parent-operation links. Approval publication records its event and source
links only after the receipt and trigger hook transaction commits, so operators
can correlate intake, approval and later research without a span covering the
human approval wait. A trigger's output link names its card, while
publication's output link names the approved record. Count LLM attempts from
terminal `model_call` spans and research summaries from `research_run`. A
numeric token count of `0` means the provider reported zero; `null` means usage
was unavailable and is never treated as zero.

Shared search references identify one operation covering several approvals.
Count that build once. `CoreModel*` and legacy `Llm*` metrics overlap; do not
add them together. Only the new projection includes related-search model calls.

The sidecar upgrades V1 rows to historical `legacy` observations. A skip consumes
an event sequence, not an execution attempt. Measured retries link prior failed
executions; interrupted work/durable-state reconstruction is `recovery`, with
no measured failure duration or invented model retry. A competing click leaves
the winning append/search intact. Historical retry counts remain unknown.

Core events use UTC for correlation and monotonic elapsed durations for new
work. CPU/RSS/heap, filesystem counters,
active HTTP/model counts and event-loop delay can overlap other operations.
Event-loop maximum is since transport startup. SQLite lock and disk-I/O latency
are unavailable; filesystem counters are neither latency nor physical bytes.

#### Reading an agentic Ask and its evidence-desk calls

Ask is the agentic loop (RFC-0003; the only Ask since ADR-0022). It uses the
Ask journey, so it is listed, counted and alarmed like any Ask:

| Stage | What it measures in the loop |
| --- | --- |
| `ask_validation`, `ask_authorization` | Request admission and the session check. |
| `ask_retrieval` | Summed evidence-desk time during research. Counts: searches run (`planned_query_count`), search hits, distinct items released. |
| `ask_planner` | Summed research-step model time and the steps' combined token usage. |
| `ask_context` | Items handed to the answer call (`context_atom_count`). |
| `ask_answer` | The answer call (and its repair), usage and citations. A failed answer call that still ends in records or not found stays `succeeded`; its span shows the failure. |
| `ask_revalidation`, `ask_audit` | The final fence and the terminal audit. |
| `ask_response` | `answered`, `partial`, `not_found` or `off_scope`. |

The retrieval summary also records `research_stop_reason`: `finished`,
`empty_catalog`, `no_progress`, `step_limit`, `budget`, or `unusable_step`.
When a required access revalidation leaves too little time to admit the next
planner call, the stop is `budget` and `research_admission` is
`post_revalidation_no_time`. This does not count as an unusable model reply;
the writer can still use evidence already released within its reserved time.
These fields contain only fixed diagnostic values, never queries or evidence.

An Ask (a question, never a background task) also records five counts on the
span that carries its `planned_query_count`, for the research tool contract
([ADR-0042](../decisions/ADR-0042-research-tool-contract.md)):

| Count | Meaning |
| --- | --- |
| `refused_read_count` | Reads refused before the desk because the source does not take a filter value or date, or answered with an error |
| `repeated_refusal_count` | Refused reads sent again with the same arguments and answered from memory, unsent |
| `unchecked_item_count` | Items a date window could not test because they lack the asked date |
| `sources_looked_at` | Distinct sources a search or list read; a search across sources counts once |
| `most_reads_in_a_step` | The most reads one research step ran (at most 10) |

They are counts only, never filters, queries or evidence.

A request that fails marks the first research-to-audit stage still open as
failed with the request's failure class, then fails `ask_response`. The deadline
is `timeout`; a closed client connection is `cancelled`. A failed `ask_response`
ends its journey even when the failure is retryable; a retry is a new journey.

Its core operations hold the detail. Each research step and answer call
is an `ask_planner` or `ask_answer` span with its provider `model_call` inside
(purpose `ask_planner` or `ask_answer`). Each desk call is one span:
`evidence_search`, `evidence_open`, `evidence_list` or `evidence_revalidate`.
Desk spans carry `included_count` and, by source, `meeting_items` and
`document_items`; `transcript_items` is the shared-transcript
subset of `document_items`. The evidence HTTP doors use the same desk spans.

#### Count code's corrections of model output

Code corrects model output in many places: it drops a repeated item, reads
`[T12]` as `T12`, cuts a field to its cap, answers a repeated search from
memory, repairs a malformed reply or withholds a line. Each such correction
counts itself by name on the core runtime span that made it, as
`model_corrections`, from the closed list `CORE_RUNTIME_MODEL_CORRECTIONS_V1`.
Only names and counts are recorded, never the text corrected, and counting
never changes a correction. A span that corrected nothing has no
`model_corrections`. A reply that is then rejected still counts what code read
of it. The counters exist so each correction can be retired once it stops
firing on the current models (model scaffolding audit, 2026-10-20).

| Where | What it shows |
| --- | --- |
| Journey logs | `diagnostic.model_corrections` on a span's `succeeded` or `failed` event: `model_grounding` for meeting extraction, `research_loop` for research steps and the loop, `research_output` for renderers, `model_parse` for the adapter's JSON reading. |
| Journey metrics | One `ModelCorrections` value per name and terminal event, with the single dimension `correction`. Metrics outlive the 14-day log retention. |
| LangSmith traces | The root of a captured research run (Ask, impact card, sweep) carries `model_corrections`, the sum over every span of that run. Meeting extraction is not exported to LangSmith. |

```
fields @timestamp, diagnostic.model_corrections.extraction_repeat_dropped as repeats
| filter kind = "echo-authority-journey-stage-v1" and ispresent(repeats)
| stats sum(repeats) by bin(1d)
```

Meeting extraction (`llm-decision-processor.ts`):

| Name | What code did |
| --- | --- |
| `extraction_item_set_aside` | Set aside a malformed or ungrounded item; its reason and cited units reach only a selected private capture |
| `extraction_repeat_dropped` | Dropped a repeated item: the same kind, text and units, or the same id after evidence trimming |
| `extraction_owner_cleared` | Cleared a proposed action owner that no cited unit names |
| `extraction_due_cleared` | Cleared a due date that is not a date or falls before the meeting |
| `extraction_due_coerced` | Stored a date-only due date as the meeting's local noon |
| `extraction_decided_downgraded` | Stored a decided decision that cites only questions as proposed |
| `extraction_unit_id_respelled` | Read a cited unit id in another spelling (`[T12]`, ` t12 `) as its unit |
| `extraction_parent_unit_cited` | Read a split unit's parent id (`T12`) as all its parts |
| `extraction_unknown_unit_dropped` | Dropped a cited unit id that names no unit from an item it kept |
| `extraction_confidence_cleared` | Cleared a confidence that is not a number from 0 to 1 |
| `extraction_rationale_link_dropped` | Dropped a rationale's repeated link, or a link to no kept decision |

Research steps and the research loop (`agentic-research-loop-v1.ts`):

| Name | What code did |
| --- | --- |
| `step_source_alias` | Read a loose source name (`docs`, `Meetings`) as an advertised source |
| `step_title_as_id` | Read an item's title, given to open in place of its id, as that item |
| `research_repeat_search` | Answered a repeated search "already searched", unsent |
| `research_repeat_open` | Answered an open of an item already in full "already open", unsent |
| `research_repeat_list` | Answered a repeat of a list with nothing left to show "already listed", unsent |
| `research_repeat_refusal` | Answered a refused read sent again from memory, unsent; Ask also counts it as `repeated_refusal_count` |
| `research_finish_refused` | Refused a finish and sent it back for repair |
| `research_no_progress_stop` | Stopped research after steps that found nothing new (`research_stop_reason` `no_progress`) |
| `research_empty_catalog_stop` | Stopped research on a catalog read empty to its end (`empty_catalog`) |
| `research_unusable_step_stop` | Stopped research on a step no repair made usable (`unusable_step`) |

Any model reply: the model gate (`agentic-model-gate-v1.ts`), the OpenRouter
adapter (`openrouter-structured-generation-adapter.ts`) and the reply parsers
(`agentic-ask-v1-model-protocol.ts` and the renderers):

| Name | What code did |
| --- | --- |
| `model_retry` | Retried a call unchanged after a temporary provider failure |
| `model_repair_json` | Asked again after a reply that was not valid JSON |
| `model_repair_unfinished` | Asked again after a reply cut off at its length |
| `model_repair_empty` | Asked again after a reply with no usable content |
| `model_repair_rejected` | Asked again after its caller's checks rejected a reply, naming the problem |
| `model_json_fence_stripped` | Read a reply from inside a Markdown fence |
| `model_json_outer_text_dropped` | Dropped text around a reply's JSON object |
| `model_text_truncated` | Cut a model-written field to its character cap |
| `model_items_capped` | Dropped entries past a reply's maximum count |
| `model_entry_dropped` | Dropped a malformed entry: not an object, no text or id, an unreadable id or selection, or an argument with no text or one its tool does not take |
| `model_repeat_dropped` | Dropped a repeated need, id, phrase, list use or card row within one reply |
| `model_id_respelled` | Read an id in another spelling (`e4`, `[E4]`, `4`, ` n2 `, `[L3]`) as its id |
| `model_enum_respelled` | Read a closed value (a tool, a need's status or kind, a selection field, a relation, a verdict) given in another spelling, as an alias (`browse`) or not at all, as a known value or its default |
| `model_bare_string` | Read a bare string where an object belongs: a tool's args or the old `input` field, a need, a list use |
| `model_inline_ids_stripped` | Removed evidence ids written into model text, such as `(E4)` |

Before these counters, retries and repairs were recorded only as `repairs` in
the durable Ask audit and the research result's `cost`, and as `recovery` on a
LangSmith model run. A gate counter is counted once the extra call is admitted
past its access check, as the audit counts repairs.

Renderers (`ask-renderer-v1.ts`, `impact-card-renderer-v1.ts`, `sweep-renderer-v1.ts`):

| Name | What code did |
| --- | --- |
| `writer_repeat_dropped` | Dropped an Ask statement that exactly repeats an earlier one (the temporary exact-repeat guard, ADR-0041) |
| `writer_unknown_id_dropped` | Dropped an id the writer was not shown from a sentence, a list use or a list's members |
| `writer_uncited_sentence_dropped` | Left out a writer sentence that cites no evidence text it read |
| `writer_fallback` | Stated lists or records in place of a writer that gave no usable reply |
| `card_line_screened` | Sent back an impact-card line that suggests an edit or claims ownership |
| `card_unknown_id_dropped` | Dropped a decided or affected entry naming an item the model was not shown, or the wrong kind of item |
| `card_date_dropped` | Dropped a date at risk that the item does not state, that is not a date, or that has no milestone |
| `card_fallback` | Showed the record's approved lines, not assessed, in place of a card with no usable reply |
| `sweep_line_withheld` | Withheld a sweep line that suggests an edit or claims ownership, keeping its verdict |
| `sweep_fallback` | Left findings not assessed after a sweep with no usable reply |

#### Live Jira and Confluence reads in Ask

Every Person Ask route that reads live tools uses the existing `core_runtime`
request trace. Its live-read metadata shares the `journey_id`.

| Signal | How to read it |
| --- | --- |
| `evidence_connection`, `evidence_source: ticket` | `verified` means the request's Jira reader passed its fresh provider identity check, including the saved mapping in project scope. `unlinked`, `not_configured`, and `out_of_scope` mean no reader was selected. A successful `unavailable` event in project scope means no reader was selected; it does not distinguish a missing mapping from a missing personal connection. A failed event carries a finite failure category. This is not the UI's stored connected status. |
| Live `evidence_search`, `evidence_list`, `evidence_open` | `evidence_source` distinguishes `ticket` from `page` and `tool_container` (a connected tool's Jira projects or Confluence spaces, read only for the V8 Ask, ADR-0042). `included_count` counts the items that provider operation returned, before mixed-source trimming. `empty` is a successful zero-result lookup; a failed lookup has its failure category and no result count. Queryless searches call `evidence_list`. |
| Terminal `http_request` | `result` is the returned Ask outcome. `ticket_retrieved_items` counts distinct ticket handles returned to the Ask loop, including inventory; `ticket_context_items` counts tickets actually submitted to the answer model, without counting a repair twice; `ticket_citations` counts citations in the final response after its access fences. A failed or cancelled request has zero returned citations. |

Only finite categories and counts are added. These live spans carry no
provider payloads or errors. They do not record questions, search text, ticket text, ticket IDs,
provider coordinates, or credentials. Repeated successful connection rechecks
do not add separate live-source spans. Older releases have no Jira fields;
their absence is not evidence that Jira was skipped or returned no data.
Requests that fail before the Ask loop starts have no ticket summary counters.

A streamed `/v6/person/ask` (`x-echo-ask-progress: 2`, ADR-0040) or
`/v7/person/ask` (`x-echo-ask-progress: 3`, ADR-0042) always answers HTTP
`200` once its stream starts (`/v5` stopped streaming on 2026-10-19 and
answers in JSON, ADR-0039); a later failure is its terminal
`error` event. Its terminal `http_request` span records that event's status
as `http_status`, the status the JSON route would have returned, so a filter
on `http_status` finds streamed failures as it finds JSON ones. A streamed
Ask the client disconnected records `200` with no answer.

In Logs Insights, select the Authority log group and a bounded incident window.
Replace the example journey ID with the request's ID. Parse `@message` explicitly
so nested diagnostic fields do not depend on automatic field discovery:

```text
fields jsonParse(@message) as e
| filter e.kind = "echo-authority-journey-stage-v1"
| filter e.journey_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
| filter e.event != "started"
| filter e.diagnostic.evidence_source = "ticket" or e.diagnostic.phase = "http_request"
| sort e.sequence asc
| display e.sequence, e.diagnostic.phase, e.event, e.diagnostic.result, e.elapsed_ms, e.diagnostic.counts.included_count, e.diagnostic.counts.ticket_retrieved_items, e.diagnostic.counts.ticket_context_items, e.diagnostic.counts.ticket_citations
```

#### Identify which upstream rate-limited a live read

New shared-transport releases add nested `http_request` spans beneath live
evidence operations. Each span records a finite `upstream_service` (`nango`,
`jira`, `confluence`, `granola`, or `other`) and `upstream_operation`. The
`http_status` count is present only when that boundary received an HTTP
response. If a Nango credential lookup fails before the Jira or Confluence
request is sent, the outer provider span can fail without an HTTP status;
the nested Nango span identifies the responding service.
For these nested spans, `succeeded` means an HTTP response arrived; it can
still carry `http_status: 429`. The surrounding evidence operation reports
the rejected application outcome. Inspect the HTTP status for attribution.
Nested HTTP spans remain in the journey log; EMF request counts and latency
continue to describe only the root HTTP request.

The safe projection also retains bounded numeric `upstream_retry_after_seconds`,
`upstream_rate_limit`, `upstream_rate_remaining`, and
`upstream_rate_reset_unix_seconds` when the corresponding non-beta headers are
valid. A documented Atlassian `RateLimit-Reason` becomes the finite
`upstream_rate_limit_reason` category (`burst`, `global_quota`, `tenant_quota`,
`per_issue_write`, or `other`). Missing or invalid headers remain unknown.
An unrecognized reason is `other`; its original text is never retained.

For the exact failed request, use the bounded incident window and journey UUID:

```text
fields jsonParse(@message) as e
| filter e.kind = "echo-authority-journey-stage-v1"
| filter e.journey_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
| filter e.event != "started" and ispresent(e.diagnostic.upstream_service)
| sort e.sequence asc
| display e.sequence, e.diagnostic.upstream_service, e.diagnostic.upstream_operation, e.event, e.diagnostic.counts.http_status, e.diagnostic.upstream_rate_limit_reason, e.diagnostic.counts.upstream_retry_after_seconds, e.diagnostic.counts.upstream_rate_limit, e.diagnostic.counts.upstream_rate_remaining, e.diagnostic.counts.upstream_rate_reset_unix_seconds
```

Attribute a rejection to the service whose span actually received `429`.
Use its reported limit/reason and retry delay to distinguish request bursts
from quota exhaustion. The public [Nango request limiter](https://github.com/NangoHQ/nango/blob/master/packages/server/lib/middleware/ratelimit.middleware.ts)
returns `429` with the three `X-RateLimit-*` headers and `Retry-After`.
A Nango `429` without those headers identifies its HTTP boundary, but does
not establish which hosted component rejected the request. Use the exact
timestamp and operation in Nango's request logs for that remaining ambiguity.
The published
[Nango rate-limit contract](https://nango.dev/docs/reference/backend/backend-sdk/node#rate-limits)
and [Atlassian rate-limit contract](https://developer.atlassian.com/cloud/jira/platform/rate-limiting/)
describe the response signals; do not substitute their default quotas for
the live service's actual headers.

These spans retain no URLs, connection IDs, tokens, raw header values,
request bodies, or response bodies. Rejection bodies remain unread. No
automatic retry or retrieval behavior changes are introduced. Historical
events without upstream fields cannot retrospectively distinguish Nango
from an Atlassian response. The server diagnostics require a release through
the existing operator lane.

#### Transport completeness

Heartbeat `delivery` counts attempted/failed/pending/dropped writes, rejected
observations, attempted bytes and serialization/writer microseconds. Pending
writes and active operations are bounded at 1,000. Counts are
process-cumulative local evidence, not CloudWatch ingestion acknowledgement.
A dropped tail may leave no gap; compare heartbeat health and durable results,
and treat missing terminals as incomplete. A broken writer can report failure
only after output recovers. Observation failures never control business outcomes.

Heartbeat `rejection_counts` attribute `delivery.rejected_events` to fixed
emitter/reason counters, which sum to it:

| Emitter | Reason | Local boundary |
| --- | --- | --- |
| `journey_observer` | `invalid_journey_event` | Journey event validation/formatting threw |
| `meeting_approval_observer` | `observation_callback_failure` | Historical; this producer no longer reports failures |

These are local rejection counts, separate from `writes_failed`,
`writes_dropped`, and `writes_pending`; they do not establish downstream
CloudWatch ingestion loss or an Ask failure. Compare heartbeats from the same
process lifetime: counters reset on process restart, including restarts of the
same release. Reason totals are emitted only in liveness records, not as
cumulative EMF count metrics or per-reject log events. Heartbeats from releases
before 2026-10-19 also carry `content_capture` counters and
`delivery.partial_captures` for the retired content telemetry.

#### Runtime metric and alarm attribution

Legacy `EchoBrain/AuthorityOperations` metrics have no dimensions and can mix
source log groups. An alarm email cannot identify the host. The received recovery
email concerned `echo-authority-observability-v1-authority-alerts`, a different
topic from the earlier empty-subscription inspection; this is not evidence for
replacing or deleting subscriptions.

The runtime template preserves legacy filters/actions and adds matching filters
under `EchoBrain/AuthorityOperations/${AuthorityHost}`. Both comparison alarms
have `ActionsEnabled: false`. `RuntimeMonitoringAttribution` identifies the stack,
host, log group, metric namespaces, alarms and ALARM/OK topic. Before changing
alert routing, the operator must verify that chain through the confirmed
subscription, compare both metrics, and record recovery delivery. Keep legacy
actions effective until the reviewed transition. No live attribution or
four-meeting candidate acceptance is established by offline proofs.

Metric namespace/name/dimensions must match between filters and alarms. References:
[metric concepts](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/cloudwatch_concepts.html),
[metric transformations](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-logs-metricfilter-metrictransformation.html),
[alarm actions](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-cloudwatch-alarm.html).

##### Changing the staging journey overview

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
   `authority-staging-journey-observability-v1.template.json` with
   `--profile echo-prod`, the staging Region and a fresh change-set name.
   Confirm it remains the existing staging-only overview resource set with no
   custom widget. It must not add
   direct Logs permissions to the operator or dashboard, enable public sharing,
   or touch production.
3. Run exactly one real staging Ask and one real staging approval. For each,
   use Logs Insights on the staging log group to find the correlated, redacted
   journey and confirm its stage/attempt sequence, machine latency, token value
   or `null`, retry and retrieval metadata, human wait where applicable, and
   terminal outcome agree with the overview aggregates. Record only
   content-free correlation and aggregate evidence. Stop and investigate any
   missing, partial, unredacted, cross-environment, or inconsistent result.

Use this procedure only to change the staging journey overview. Normal journey
inspection uses the existing verified configuration; it does not require
repeating setup or a change set.

##### Retire the Journey Explorer stack

The Explorer was a separate staging stack created from the retired
`authority-staging-journey-explorer-v1.template.json`: the
`customWidget-echo-staging-journey-explorer-v1` Lambda, its execution role, the
customer managed policy `echo-staging-journey-explorer-invoke-v1` and the
retained log group `/echo-brain/authority/staging-journey-explorer-v1`. An
overview update removes only the dashboard widget, not this stack. Use the
same session and staging-only checks as above.

1. Confirm with read-only inspection that the Explorer stack holds exactly
   those four resources and that no other stack or permission set depends on
   them:

   ```sh
   staging_region=us-west-2
   explorer_stack=existing-journey-explorer-stack

   aws cloudformation describe-stack-resources --profile echo-prod \
     --region "$staging_region" --stack-name "$explorer_stack" \
     --query 'StackResources[*].{LogicalId:LogicalResourceId,Type:ResourceType,Status:ResourceStatus}'
   ```

2. Have the authorized IAM Identity Center administrator remove the
   `echo-staging-journey-explorer-invoke-v1` reference from the staging-only
   permission set and reprovision it. Do not edit an `AWSReservedSSO` role
   directly. CloudFormation cannot delete the policy while a role still has it.
3. Apply the overview change set above, so the dashboard no longer invokes the
   Lambda.
4. Delete the Explorer stack and wait for it. Stop if the deletion fails or
   would touch any other resource:

   ```sh
   aws cloudformation delete-stack --profile echo-prod \
     --region "$staging_region" --stack-name "$explorer_stack"
   aws cloudformation wait stack-delete-complete --profile echo-prod \
     --region "$staging_region" --stack-name "$explorer_stack"
   ```

5. The stack retains the function log group by design. It holds only the
   Explorer's own logs under 14-day retention; once no investigation needs
   them, delete it:

   ```sh
   aws logs delete-log-group --profile echo-prod --region "$staging_region" \
     --log-group-name /echo-brain/authority/staging-journey-explorer-v1
   ```

Record only the stack status and timestamps.

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
sudo docker compose --env-file .env.clean-v1 \
  -f compose.clean-v1.yaml -f compose.clean-v1.ec2.yaml stop authority
```

Expected evidence within the 2-of-3 one-minute window is failed scheduled
checks and an availability alarm email. Restore the exact accepted deployment:

```sh
sudo docker compose --env-file .env.clean-v1 \
  -f compose.clean-v1.yaml -f compose.clean-v1.ec2.yaml \
  up -d --no-build --wait --wait-timeout 90 authority
sudo docker compose --env-file .env.clean-v1 \
  -f compose.clean-v1.yaml -f compose.clean-v1.ec2.yaml restart proxy
sudo docker compose --env-file .env.clean-v1 \
  -f compose.clean-v1.yaml -f compose.clean-v1.ec2.yaml \
  up -d --no-build --wait --wait-timeout 90 authority proxy
sudo ./onboard-clean-v1.sh status
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
