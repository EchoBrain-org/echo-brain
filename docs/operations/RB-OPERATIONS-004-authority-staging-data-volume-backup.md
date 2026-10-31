---
schema_version: 1
id: RB-OPERATIONS-004
kind: runbook
title: Back up the staging clean-data volume and rehearse its restore
component_ids:
  - CMP-OPERATIONS-RELEASE
created_at: 2026-10-31
reviewed_at: 2026-10-31
reviewed_ref: aa92138e4a7d8386b2ff51a95c7d2f82e86236be
tested_at: null
---

# RB-OPERATIONS-004: Back up the staging clean-data volume and rehearse its restore

## Trigger, outcome, preconditions, and stop conditions

The staging slot keeps all Authority state on one retained, encrypted EBS
volume mounted at `/srv/echo-authority-clean-v1/clean-data`
([ADR-0009](../decisions/ADR-0009-retained-authority-data-volume-boundary.md)).
The volume survives host replacement and stack deletion, but retention is not
a backup: one volume in one Availability Zone is the only copy. Use this
runbook before beta data accumulates on the slot, and again after the slot's
data volume, the backup stack or the `clean-data/` layout changes.

[RB-OPERATIONS-002](RB-OPERATIONS-002-authority-recovery-floor.md) covers a
different machine: the pre-slot EC2 Authority host, whose `clean-data/` lives
on its root volume. Its procedure does not reach this slot.

The outcome has two parts:

1. `npm run authority:staging -- backup` creates a sibling stack,
   `<slot-stack>-data-backup`, whose AWS Backup plan selects exactly the
   slot's retained `StagingDataVolume`. It runs daily at 09:00 UTC and keeps
   each recovery point for 35 days. The recovery points are crash-consistent
   only. A CloudWatch alarm notifies the existing staging alert topic when the
   vault records no completed backup job for 30 hours; and
2. one separately created, explicitly quiesced recovery point is restored to
   an isolated recovery helper, attached only as a secondary device, mounted
   read-only without journal replay, and checked by the offline verifier.

This is a recovery floor. It does not swap a restored volume into the slot or
prove a serving recovery: `StagingDataVolume` is a stack-managed resource, so
serving from a restored copy needs its own reviewed slot change
([issue #20](https://github.com/EchoBrain-org/echo-brain/issues/20)).

### What this protects and what it does not

| State | Where it lives | Protection |
| --- | --- | --- |
| `clean-data/`: `state/`, `release/`, `private/`, provider and rehearsal sidecars, maintenance status | Retained data volume | Daily AWS Backup recovery point, 35 days, same account and Region, once part 1 is executed. Before that: none. |
| Host root: deployment root, installed host wrappers, Docker images, `.staging-release-guard`, any `retired-rehearsals/` archive | Root volume, deleted with the host | None, by design. A new root disk is rebuilt from the host bundle, ECR and the release lane. Copy any `retired-rehearsals/` archive worth keeping off the host before `down`. |
| Tunnel connector token | Retained Secrets Manager container | Not backed up. `slot-init` deposits a new token. |
| Setup bundles and onboarding transfers | Retained versioned S3 buckets | S3 durability only; outside this runbook. |
| Recovery points themselves | The backup stack's retained vault | No Vault Lock, no cross-Region or cross-account copy. Both are deferred to the later backup foundation decision. |

### Owner, approval and escalation

ECHO operates the default staging slot
([ADR-0008](../decisions/ADR-0008-echo-hosted-authority-by-default.md)), so the
ECHO account administrator approves the cadence, retention, IAM roles and the
exact change set, and authorizes creating, restoring or deleting recovery
points. The operator owns this procedure. Escalate before changing the vault,
the KMS boundary, the schedule or retention, restore permissions, or any slot
setting. Cadence and retention are constants in `tools/authority-staging.mjs`,
so changing them is a reviewed code change, not an operator input.

### Preconditions

- An `echo-prod` IAM Identity Center session
  (`aws sso login --profile echo-prod`). Never `aws login` or the account root.
- A clean checkout of the reviewed commit that contains this runbook.
- `authority:staging status` for the slot is not `absent`, `incomplete`,
  `planned`, `failed_create` or `unprotected`, and no other slot operation is
  running. The `backup` action refuses an uninitialized or unprotected slot.
- The staging observability stack exists and its alert topic has a confirmed
  email subscription ([RB-OPERATIONS-001](RB-OPERATIONS-001-authority-observability.md)).
  The plan reads the topic and reports `alert_delivery_confirmed`. When it is
  `false`, the missed-backup alarm reaches no one: restore the subscription
  through RB-OPERATIONS-001, or have the account administrator choose another
  same-account topic with a confirmed subscription, before relying on the
  alarm. The backups themselves do not depend on it.
- A new `operationId` for this plan and its execute.

### Sensitive data

Keep account, volume, key, recovery-point, vault-ARN, change-set-ARN and helper
identifiers in the operator-private receipt only, never in the repository,
tickets, chat or committed evidence. The `backup` receipts carry stack and
change-set names and booleans only. Never open, copy, hash, print or upload a
file from a restored `private/` directory.

### Stop conditions

Stop before execution if the plan refuses, if the change set holds anything
other than the six reviewed additions (or, on an existing stack, a
non-replacing modification of only the plan or the alarm), or if the account
administrator has not approved the cadence, retention and roles. The plan
refuses with one of these codes:

| Code | Meaning |
| --- | --- |
| `data_volume_identity_mismatch` | The slot output does not name this slot's `StagingDataVolume` with the clean-data purpose and mount tags in the slot's Availability Zone. |
| `data_volume_not_encrypted` | The volume is not encrypted or names no KMS key. |
| `data_volume_key_foreign` / `data_volume_key_unusable` | The key is in another account or Region, or is not an enabled `ENCRYPT_DECRYPT` key managed by `AWS` or `CUSTOMER`. |
| `backup_alert_topic_foreign` / `backup_alert_topic_unproven` | The alert topic is not in the slot's account and Region, or cannot be read. |
| `change_set_backup_boundary_violation` | The change set would remove or replace a backup resource, or add or modify anything outside the reviewed inventory. |
| `change_set_not_reviewable` | The stored change set no longer matches the reviewed template, parameters and type. |

Stop the restore rehearsal, and detach the restored volume, under every stop
condition of RB-OPERATIONS-002 steps 4 to 6: an automatic mount, a writable
mount, unknown no-replay semantics, a verifier failure, or any network,
credential, image-pull, tunnel, provider or Authority-start action. Do not work
around a stop condition by booting or repairing the restored copy.

## Procedure and observable verification

### 1. Plan the backup stack

Read the staging alert topic from the observability stack's output:

```bash
aws cloudformation describe-stacks \
  --stack-name echo-authority-staging-observability-v1 \
  --query "Stacks[0].Outputs[?OutputKey=='AlertTopicArn'].OutputValue" \
  --output text --region us-west-2 --profile echo-prod
```

Add it to the private lifecycle input, beside the existing slot fields, and set
a new `operationId`:

```json
"backup": {
  "alertTopicArn": "<AlertTopicArn output of the staging observability stack>"
}
```

Then plan:

```bash
npm run authority:staging -- backup \
  --input /absolute/private/authority-staging/input.json
```

The action reads the volume ID from the slot stack's `StagingDataVolumeId`
output, never from the input. It then proves from EC2 and KMS that this is the
slot's tagged clean-data volume, that it is encrypted, and that its key is an
enabled same-account key. That is RB-OPERATIONS-002's source-encryption
evidence gate, run on every plan and execute. Only then does it create the
CloudFormation change set `echo-authority-backup-<operationId>` on
`<slot-stack>-data-backup`. It never changes the slot stack.

Expected evidence is a `planned` receipt with `data_volume` booleans all
`true`, `key_manager` (`AWS` for the current `aws/ebs` key),
`alert_delivery_confirmed` `true`,
`schedule_expression` `cron(0 9 ? * * *)`, `retention_days` `35`, and
`change_set_actions` listing exactly six `Add` actions: the vault, the backup
role, the restore role, the plan, the selection and the alarm.

### 2. Review the exact change set (account administrator)

```bash
aws cloudformation describe-change-set \
  --stack-name echo-authority-staging-v1-data-backup \
  --change-set-name echo-authority-backup-<operationId> \
  --include-property-values \
  --region us-west-2 --profile echo-prod
```

Confirm, against
`deploy/organization-authority/authority-staging-data-backup-v1.template.json`:

- `DataVolumeId` equals the slot's `StagingDataVolumeId` output, and
  `DataVolumeKmsKeyArn` is that volume's key;
- the selection names only that one volume ARN, with no tag condition or
  wildcard;
- the vault is retained on deletion and has no Vault Lock;
- each role has exactly one EBS-only inline policy and no managed policy. The
  restore role's KMS permissions name only `DataVolumeKmsKeyArn`;
- the plan runs `cron(0 9 ? * * *)` with a 60-minute start window, a 180-minute
  completion window and a 35-day lifecycle;
- the alarm watches `AWS/Backup` `NumberOfBackupJobsCompleted` for this vault
  and notifies the alert topic on ALARM and on OK.

The template and its Guard policy pass `npm run check:authority-recovery-infrastructure`
in CI. Approving the change set approves the cadence, retention and both roles.

### 3. Execute and confirm the first recovery point

```bash
npm run authority:staging -- backup \
  --input /absolute/private/authority-staging/input.json --execute
```

Keep the same `operationId`. Execute re-runs the evidence gate, re-reads the
stored change set and refuses one that no longer matches. It enables
termination protection on the empty `REVIEW_IN_PROGRESS` stack before
executing, then proves protection and that the stack's `SelectedDataVolumeArn`
output is the verified volume. Expected evidence is an `executed` receipt with
`termination_protection` `true`.

The alarm enters ALARM soon after creation because no backup job has completed
yet, so the alert topic sends one ALARM email. That email proves the alert path;
do not silence it. After the next scheduled window, allowing up to 60 minutes
for the job to start plus its run time, check:

```bash
aws backup list-recovery-points-by-backup-vault \
  --backup-vault-name echo-authority-staging-v1-data-backup \
  --query 'RecoveryPoints[].{Status:Status,Created:CreationDate,DeleteAt:CalculatedLifecycle.DeleteAt}' \
  --region us-west-2 --profile echo-prod
aws cloudformation describe-stacks \
  --stack-name echo-authority-staging-v1-data-backup \
  --query "Stacks[0].Outputs[?OutputKey=='MissedBackupAlarmName'].OutputValue" \
  --output text --region us-west-2 --profile echo-prod
aws cloudwatch describe-alarms --alarm-names <MissedBackupAlarmName-output> \
  --query 'MetricAlarms[0].StateValue' \
  --region us-west-2 --profile echo-prod
```

Expected evidence is one `COMPLETED` recovery point whose `DeleteAt` is 35 days
after its creation, and the alarm back in `OK` with one OK email. Record the
completion time privately. If the job fails, read its status message in AWS
Backup, fix the cause through a reviewed change, and do not start step 5.

### 4. Keep the protection checked

The alarm is the standing check: it fires once 30 hours pass without a
completed job, which is about six hours after a missed daily run. Re-run the
`backup` plan whenever this runbook or the template changes. On an unchanged
stack it reports `no_changes`. It also refuses a change that would remove or
replace a backup resource.

Before a destructive staging operation, such as `replace-rehearsal`, a schema
reset, or a `down` before host replacement, confirm the newest recovery point
is from the current day. If it is not, the human operator may take an
on-demand, crash-consistent point with the same lifecycle:

```bash
aws backup start-backup-job \
  --backup-vault-name echo-authority-staging-v1-data-backup \
  --resource-arn <SelectedDataVolumeArn-output> \
  --iam-role-arn <BackupServiceRoleArn-output> \
  --idempotency-token <new-private-operation-id> \
  --lifecycle DeleteAfterDays=35 \
  --region us-west-2 --profile echo-prod
```

Coding agents do not start backup or restore jobs; this and every command in
step 5 that changes AWS or a host belong to the human operator.

### 5. Rehearse a restore

This rehearsal follows RB-OPERATIONS-002 steps 3 to 6. It keeps that
runbook's isolation, attachment, mounting, verification and cleanup rules,
including its private-receipt contents and its least-privilege caller
requirements. Only the differences below apply to the slot.

**Decide before the window.**

- Helper VPC. The reviewed helper template creates private-DNS `ssm` and
  `ssmmessages` interface endpoints that admit only the helper. Every other
  instance in that VPC loses its normal SSM path until the helper stack is
  deleted. In the default VPC, where the 2026-08-26 drill ran, that pauses the
  pre-slot EC2 host's SSM. In the slot VPC it pauses the staging host's
  release, onboarding, backup-maintenance and Session Manager paths. The
  account administrator picks one and accepts that pause for the drill.
- Provider grants. The offline verifier refuses, by design, any restore that
  contains `state/confluence-person-connections.sqlite`,
  `private/staging-connector-rehearsal.json` or a
  `staging-connector-rehearsal-v1/` sidecar, because an archived person-bound
  grant cannot be requalified offline. It refuses before its lineage and
  SQLite integrity checks, with one opaque message. If anyone on the slot has
  connected Confluence, or the staging connector rehearsal is selected, the
  drill will stop at the verifier. Record that as the drill's finding: it is
  not a pass, and the restored copy must not be edited to get past it.
- Caller permissions. RB-OPERATIONS-002 requires backup and restore callers
  limited to the reviewed AWS Backup actions and `iam:PassRole` for the one
  exact role. The `echo-prod` AdministratorAccess permission set is broader.
  Use a scoped permission set, or record the deviation in the private receipt.

**5.1 Prepare the helper inputs before any outage.** Build the verifier bundle
with the manually dispatched `.github/workflows/authority-recovery-helper-bundle.yml`
at the reviewed commit, download that exact artifact, upload it unchanged to
the private versioned bundle bucket, and record its object version and digest
privately. Do not reuse the 2026-08-26 bundle, whose verifier predates the
current snapshot schema and provider-grant rules. Pick a current ARM64 Amazon
Linux 2023 AMI whose SSM Agent is `3.3.40.0` or newer; the AMI used on
2026-08-26 is deprecated from 2026-11-10. Run
`npm run check:authority-recovery-infrastructure` from the reviewed checkout.

**5.2 Create the quiesced qualifying point.** In Session Manager on the staging
host, from `/srv/echo-authority-clean-v1`, the human runs
`sudo ./backup-authority-maintenance.sh preflight`, which must print exactly
`maintenance_preflight_ready=true`, then starts the durable `maintain`
transaction with the exact `systemd-run` unit bounds from RB-OPERATIONS-002
step 3. The installed wrapper honours the staging release guard. While it
waits for acknowledgement, the external coordinator, never the host, runs the
`aws backup start-backup-job` command from step 4 with a new private operation
ID and `--lifecycle DeleteAfterDays=35`. The coordinator polls
`aws backup describe-backup-job` to `COMPLETED` and verifies that the recovery
point is in this vault, names the selected volume and expires 35 days after
creation. Only then does the human run
`sudo ./backup-authority-maintenance.sh acknowledge --operation-id <operation-id> --nonce <coordinator-nonce>`.
Expected evidence is `maintenance_complete`, the wrapper's automatic restart
proof, and a green `authority:staging status`. Finish this step before creating
the helper if the helper will live in the slot VPC.

**5.3 Prepare the isolated helper.** Create it from
`deploy/organization-authority/authority-recovery-helper-v1.template.json`
through a named, reviewed change set in the chosen VPC, with an unused `/28`
subnet CIDR, and in the slot's Availability Zone (`us-west-2a`). Pass the
post-bootstrap gate of RB-OPERATIONS-002 before any restored state exists:
SSM `Online`, the agent version, `cloud-init` success and the
`.bundle-ready` marker.

**5.4 Restore and attach.** Read the source volume's `VolumeType`, `Size`,
`Iops` and `Throughput` into the private receipt with account-scoped
`describe-volumes`. The slot template provisions `gp3` and leaves IOPS and
throughput at the gp3 baseline. Run `get-recovery-point-restore-metadata`, then
`start-restore-job` with `--resource-type EBS`, the backup stack's
`RestoreServiceRoleArn` output, and
`--metadata availabilityZone=<helper-az>,encrypted=true,kmsKeyId=<DataVolumeKmsKeyArn>,volumeType=gp3,volumeSize=<size>,iops=<iops>,throughput=<throughput>`.
Poll it to `COMPLETED`. Validate the created volume as RB-OPERATIONS-002 step
4 describes: `available`, no attachments, in the helper's Availability Zone,
encrypted with the same same-account key. Then attach only that volume to the
helper as a secondary device. The plan's exact selection means this drill
volume is never backed up itself.

**5.5 Mount read-only and verify.** The slot formats its whole data device as
ext4 labelled `echo-auth-data`, with no partition table, and that filesystem's
root is `clean-data/`. On the helper, confirm `findmnt -no SOURCE /`, then
identify the restored device with `lsblk -o NAME,SERIAL,FSTYPE,LABEL,MOUNTPOINTS`.
It must be the ext4 `echo-auth-data` device whose NVMe serial is the restored
volume ID without its hyphen, not the helper root, and must not be mounted. Mount
the device itself, not a partition:

```sh
sudo mount -o ro,noload,noexec,nodev,nosuid <restored-device> <empty-mount-directory>
```

Confirm that `release/`, `state/` and `private/` sit directly under the mount
(inspect `private/` only by aggregate count, type, owner and mode), then run
the staged verifier against the mount root itself:

```sh
/opt/echo-authority-recovery/runtime/node /opt/echo-authority-recovery/source/tools/verify-authority-recovery.mjs \
  --clean-data <read-only-mount> \
  --source-root /opt/echo-authority-recovery/source
```

Expected evidence is an `ok` verifier result with its sanitized booleans and
counts. A refusal is a recovery finding: preserve the private receipt, detach
the volume, and do not attempt repair.

**5.6 Contain and clean up.** Unmount, detach, wait for `available` with no
attachments, re-confirm the restored volume's identity against the restore
receipt, and delete only that drill volume. Never delete the slot's data volume,
the helper root or any source volume. Then delete the helper stack as one unit
and confirm that the helper-tagged resource query is empty, exactly as
RB-OPERATIONS-002 step 6 lists. If the helper used the slot VPC, confirm the
staging host's SSM node is `Online` again before ending the window.

## Rollback, containment, evidence, and follow-up

If a plan is rejected, do not execute it. The empty `REVIEW_IN_PROGRESS` stack
shell holds no resources and is not yet termination-protected. A later plan with
a new `operationId` reuses it. The account administrator may instead delete
that empty shell after confirming it lists no resources.

After execute, the `backup` action never removes or replaces backup resources.
Retune cadence, retention or the alert topic only through a reviewed code
change and a new plan. Removing the protection is an account-administrator
decision outside this lane: disabling termination protection and deleting the
backup stack removes the plan, selection, roles and alarm, but retains the vault
and its recovery points. If a scheduled job fails, the alarm notifies the
alert topic. Contain the problem in the backup configuration and do not
rehearse until a scheduled point completes. If the maintenance transaction
reports `recovery_required`, follow the
[lock-recovery procedure](../../deploy/organization-authority/README.md#recover-an-interrupted-operation-lock).
Never remove its lock or run Compose by hand. Never attach a restored copy to
the staging host or boot from it.

Record privately the evidence RB-OPERATIONS-002 lists for its drill, applied to
this volume. Write a timestamped qualification record only after the whole
drill completes, with sanitized booleans, counts, cadence, point age and
elapsed times, and `Refs #20`, never `Closes #20`. Set `tested_at` on this
runbook only after all of the following: a scheduled point has completed, the
quiesced point was restored, the read-only no-replay inspection finished, the
verifier returned `ok`, and the helper and restored volume were removed with
sanitized cleanup confirmation. A verifier refusal leaves `tested_at: null`.

Follow-up decisions, outside this runbook:

- whether the verifier should classify provider-grant stores explicitly,
  verifying lineage and SQLite integrity and reporting that the grants need
  revocation and reconnection, instead of refusing before those checks;
- Vault Lock, cross-Region copy and the tag-selected backup foundation that
  replaces both interim exact selections;
- a reviewed slot change that serves from a restored data volume (issue #20);
- a least-privilege permission set for backup and restore callers.
