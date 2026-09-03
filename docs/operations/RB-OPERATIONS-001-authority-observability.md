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

This transport is content-free and best effort. At the service boundary,
missing or malformed immutable image identity disables only the staging journey
telemetry transport; it must not prevent Authority startup or request handling.
A guarded staging update rejects inconsistent telemetry-capable image metadata
before accepting the candidate, preserving the currently accepted runtime. The
Docker `awslogs` driver
delivers the JSON lines using the host role's log-stream-only permission, so no
AWS credential is exposed to a browser. Journey metrics, alarms, dashboards,
and the operator Explorer remain Phase 4 through Phase 6 work; their absence is
not a Phase 1 liveness failure. Do not enable or rehearse this transport against
a production Authority in this sprint.

#### Staging journey overview design - Phase 4, not yet deployed

The Phase 4 formatter and
`authority-staging-journey-observability-v1.template.json` are implemented and
locally verified. The dedicated stack is **staging-only**, distinct from the
generic `authority-observability-v1.template.json` stack, and can select only
`/echo-brain/authority/authority-staging.echobrain.org`. It therefore cannot
create a production journey resource, permission, dashboard, alarm, retention
change, or deployment path. This is not evidence that the stack has been
deployed, that any metric is live, or that a live journey has been rehearsed.

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
| `StageClosedLatencyMs` | `elapsed_ms` only for succeeded or failed closed machine stages | `workflow`, `stage` |
| `StageRetryAttempt` | `1` when a started stage has `attempt > 1` | `workflow`, `stage` |
| `TerminalOutcome` | `1` for a succeeded stage with a non-null bounded stage outcome | `workflow`, `stage`, `outcome` |
| `StageFailure` | `1` for a failed stage | `workflow`, `stage`, `failure_class` |
| `AskRetrievalFailure` | `1` for a failed `ask_retrieval` stage | none |
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

Phase 4 local verification covers formatter, transport, template/query, and
deterministic fixture reconciliation: dashboard aggregates reconcile with the
fixture's raw canonical journey events and approved-search state. No AWS stack
deployment, live CloudWatch proof, or live journey rehearsal is claimed here.

#### Staging Journey Explorer backend - Phase 5, locally implemented and not deployed

The separate `authority-staging-journey-explorer-v1.template.json` and its
inline Node handler are locally implemented and tested, but have not been
deployed. They are staging-only and accept only
`/echo-brain/authority/authority-staging.echobrain.org` as the source log group.
The backend is invoked directly by a CloudWatch custom widget. It is not a
public service: there is no function URL, API Gateway route,
application-managed or end-user AWS credential, direct widget permission to
CloudWatch Logs, or mutation operation. After the Phase 6 permission-set
assignment, the companion policy grants the signed-in console operator only
invocation of the exact Lambda. It does not establish the scope of other
policies in that session; Phase 6 must review the effective permission set
separately.

The handler accepts only three fixed operations:

1. `describe` returns safe widget metadata.
2. `list` runs a fixed query for recent redacted journeys. The default time
   range is eight hours, the maximum is the 14-day retained-log boundary, and
   a page has at most 25 journeys. Its pending summary retains the latest
   approved or superseded milestone even when a later event is non-terminal.
3. `detail` accepts one canonical lowercase UUID journey ID and runs a fixed
   correlated-event query over the bounded 14-day retained history, not the
   dashboard's selected list range. It requires the canonical sequence-one
   `ask_validation` or `meeting_source_intake` started event; otherwise it
   returns `journey_history_incomplete` and does not report a clipped timeline
   or wall-clock.

Both queries have a 2,500-record cap and return `result_limit_exceeded` if it
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
wait. It does not return `@message` or source content.

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

#### Staging Journey Explorer UI - Phase 6, locally implemented and not deployed

The Phase 6 renderer is locally implemented and locally tested in the Phase 4
staging overview dashboard, but no AWS deployment, permission-set assignment,
widget trust, live query, Ask/approval rehearsal, or sprint exit has occurred.
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
unavailable and is never treated as zero. The content-free allowlist permits
only correlation/schema provenance, timing, nullable usage, retrieval/retry
metadata, and failure classification.
It excludes raw events, prompts, answers, meeting material, provider payloads,
stack traces, and other source content.

The renderer inherits the query safety boundary. The selected range may not
exceed the retained 14-day staging window; a fixed query that reaches its
2,500-event cap returns `result_limit_exceeded` instead of partial list or
detail; unknown/noncanonical events are rejected; and a renderer response that
would exceed its bounded safe size returns fixed error markup rather than
truncating data or exposing raw logs. Operators should narrow the range and
retry a `result_limit_exceeded` response.

##### Pending staging-only change-set and rehearsal checklist

This checklist is deliberately not live evidence. Use an IAM Identity Center
operator session obtained with `aws sso login --profile echo-prod`; do not use
`aws login`, root credentials, SSH, an interactive root shell, a production
target, or a shared permission set. Prefer the AWS MCP server when it is
available. Stop before execution if account, Region, source log group, resource
set, or permission-set scope is not clearly staging-only.

1. Confirm the account and Region with a read-only identity check, for example:

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

No AWS deployment, permission-set assignment, widget trust, live CloudWatch
query, Ask/approval rehearsal, or production change is claimed by Phases 5 or
6 until this checklist has been completed and its staging-only evidence has
been reviewed.

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
