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
