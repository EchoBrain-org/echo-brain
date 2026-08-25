---
schema_version: 1
id: RB-OPERATIONS-002
kind: runbook
title: Establish and rehearse the current Authority recovery floor
component_ids:
  - CMP-OPERATIONS-RELEASE
created_at: 2026-08-25
reviewed_at: 2026-08-25
reviewed_ref: 35875e49817c841ac1f8aa3abf669d6e9a636a83
tested_at: null
---

# RB-OPERATIONS-002: Establish and rehearse the current Authority recovery floor

## Trigger, outcome, preconditions, and stop conditions

Use this runbook to establish the first off-host protection for the current
single-host Authority, and to prove that a restored copy can be inspected
without becoming another Authority. Use it again after the Authority root
volume, its backup configuration, or its on-host `clean-data/` layout changes.

The outcome has two deliberately different parts:

1. an AWS Backup plan selects exactly the current Authority root volume and,
   after a separately recorded source-volume encryption evidence gate, produces
   scheduled recovery points while the Authority is running; these recovery
   points are crash-consistent only; and
2. one separately created, explicitly quiesced qualifying recovery point is
   restored to a clean helper, attached only as a secondary device, and
   inspected read-only without journal replay or network/provider access.

This is a structural recovery floor. It does not restore service, prove a
current point-in-time organization, or close [issue #20](https://github.com/EchoBrain-org/echo-brain/issues/20).
The full recovery path still requires a replaceable host, same-lineage restore,
exact release/image availability, reconciliation, and terminal-green serving
proof.

The founder owns the decision to create, retain, restore, or delete recovery
points. The operator owns this procedure. Escalate before changing a backup
vault, KMS ownership, schedule, retention, restore permissions, or any live
Authority host setting.

Before any mutation, record in the founder-private operator receipt:

- the Authority hostname and root volume as identified from the running host's
  root block-device mapping;
- Region, selected backup vault and plan, encryption/KMS ownership, approved
  cadence and retention, and the restore principal and exact restore-role
  output it may pass;
- who checks backup-job completion, how often, and whether job-failure alerting
  is implemented or explicitly deferred; and
- the maintenance window and the source commit used to stage the verifier.

The recovery template cannot inspect the live EBS volume. For Amazon EBS, AWS
Backup recovery points inherit the source volume's encryption and are not
independently encrypted by the backup vault. The source-volume evidence gate in
step 1 is therefore a hard precondition for a CloudFormation change, not a
post-deployment check or a template claim. See [AWS Backup encryption for
Amazon EBS](https://docs.aws.amazon.com/aws-backup/latest/devguide/encryption.html).

Keep account, host, volume, recovery-point, KMS, private-file, and mount-path
identifiers out of the repository, tickets, chat, and committed evidence. Never
record credential values, bytes, or content hashes.

Prerequisites:

- an active AWS CLI session in the Authority account and Region with reviewed
  authority to manage AWS Backup, EBS restores, and the isolated helper. The
  restore caller has `iam:PassRole` only for the exact
  `RestoreServiceRoleArn` stack output, not a wildcard or the Authority host
  role;
- a completed, founder-private evidence gate for the source EBS volume's
  `Encrypted`, `KmsKeyId`, and account-ownership facts, plus the source KMS
  key's account, manager, enabled, and AWS Backup usability facts described in
  step 1;
- the running Authority's accepted release and deployment directory are known;
- the Authority operation lock is absent, or its documented recovery has
  completed before the qualifying point is made;
- a maintenance window is available for the clean stop and qualifying point;
- a clean helper OS in the restore volume's Availability Zone and an isolated
  management path are prepared before any restored state is attached; and
- the checksum-verified Authority source root, Node runtime, locked dependency
  tree, and required workspace build output are present on that helper before
  attachment. They contain the committed verifier, its release/profile readers,
  and the exact built Authority runtime required by
  `tools/verify-authority-recovery.mjs`. From that staged source root, run the
  following offline pre-attachment smoke test against only synthetic,
  non-production fixtures. It must use no network request or download, both
  commands must exit `0`, and the focused test suite must report every test
  passing:

  ```sh
  node --check tools/verify-authority-recovery.mjs
  ./node_modules/.bin/vitest run --config vitest.config.ts tests/architecture/authority-recovery-verifier.test.ts
  ```

The helper must have no public IP, Authority host role, Cloudflare
configuration, provider credentials, deployment directory, or route to general
ingress or egress. Before attachment, retain a founder-private reviewed-IaC
receipt showing the helper-only instance role, helper security group, subnet
route table, every interface-endpoint security group, and every endpoint policy.
The receipt must establish that the helper role has only SSM core access plus
the minimum pre-staged-bundle read permission when used; its security group has
no ingress and only HTTPS egress to the approved endpoint security groups; its
route table has no NAT, internet-gateway, transit-gateway, or peering path; the
SSM and `ssmmessages` endpoints accept HTTPS only from that helper group; and
any temporary S3 endpoint policy is limited to the checksum-verified bundle.
The reviewed path must have no route, endpoint policy, or role permission for
Secrets Manager, ECR, Cloudflare, the tunnel, or providers while restored state
is attached. Do not attach the restored volume to the live Authority or any
machine that could run its startup path.

Stop before mutation if the root volume cannot be identified unambiguously, the
AWS Backup selection would include more than that one volume, `Encrypted` is
not exactly `true`, `KmsKeyId` is absent, the volume or source KMS key does not
belong to the Authority account, the key is not enabled or has a manager other
than `AWS` or `CUSTOMER`, AWS Backup cannot use it, retention is not understood,
the helper is not isolated, its Availability Zone is not fixed for the restore,
the verifier staging checksum, Node/dependency/workspace output set, or offline
smoke commands is not valid, or a new backup plan would replace an existing
plan without reviewed approval.

Stop the drill and detach the restored volume if it appears to be the helper's
root device, an automatic mount occurs, a writable mount would be needed, the
filesystem cannot be mounted with known no-journal-replay semantics, the
verifier reports a failure, or any network, credential, image-pull, tunnel,
provider, or Authority-start action would be required. Do not work around a
stop condition by booting the restored root filesystem.

## Procedure and observable verification

### 1. Complete the source-volume encryption evidence gate before any change

From a controlled operator session, identify the Authority instance and inspect
its block-device mapping. Confirm that the selected root volume is the volume
backing the running Authority host, not an attached data disk or an inferred
name. Keep the resulting identifiers in the private operator receipt only.

Before creating a change set or applying the recovery template, collect the
following raw facts in that private receipt. The commands are examples only:
substitute confirmed private values and do not paste their output into chat,
tickets, or the repository.

```sh
aws sts get-caller-identity --output json
aws ec2 describe-volumes --volume-ids <confirmed-root-volume-id> \
  --query 'Volumes[0].{VolumeId:VolumeId,Encrypted:Encrypted,KmsKeyId:KmsKeyId,State:State,Attachments:Attachments}' \
  --output json
aws kms describe-key --key-id <source-volume-kms-key-id> \
  --query 'KeyMetadata.{Arn:Arn,AWSAccountId:AWSAccountId,KeyManager:KeyManager,KeyState:KeyState,Enabled:Enabled,KeyUsage:KeyUsage}' \
  --output json
```

Proceed only when all of the following are true and recorded privately:

- the account-scoped `describe-volumes` request returns exactly the confirmed
  root volume, its attachment identifies the running Authority instance,
  `Encrypted` is exactly `true`, and `KmsKeyId` is present. The EC2 Volume
  response has no `OwnerId` field; account ownership is established by the
  authenticated account-scoped request rather than an invented response
  property;
- the source-volume key reports that same `AWSAccountId`, `KeyManager` `AWS` or
  `CUSTOMER`, `KeyState` `Enabled`, `Enabled` `true`, and `KeyUsage`
  `ENCRYPT_DECRYPT`; and
- the AWS Backup service role is usable for the planned same-account backup and
  restore. For a customer-managed key, review its policy and grants for a
  relevant deny or missing permission; for an AWS-managed key, record the
  manager and rely on the completed backup job as the operational proof.

The verified current `aws/ebs` class is an AWS-managed source key and is valid
for this same-account recovery floor. It blocks a future cross-account copy
because AWS-managed key policies cannot be shared across accounts. Moving the
root volume to a customer-managed key requires a data migration and belongs to
the later retained-data-volume/foundation decision, not this sprint. A
cross-account key, a disabled key, a missing `KmsKeyId`, or an unusable source
key fails this gate. Do not attempt to make the CloudFormation template
compensate for a failed gate.

Validate the reviewed template locally before creating a change set. Use
`cfn-lint` 1.55.1 from the official `aws-cloudformation/cfn-lint` PyPI/GitHub
release and CloudFormation Guard 3.2.1 from the official
`aws-cloudformation/cloudformation-guard` release. Install them only in a
disposable operator environment, record both version outputs and the source
asset in the private receipt, and verify the `cfn-lint` wheel and Guard archive
against their pinned SHA-256 values before installation or extraction. Do not
use the remote installer script or an unpinned tool. Exact source URLs, asset
names, and platform checksums are pinned in
`deploy/organization-authority/authority-current-host-recovery-v1.validation-tools.json`.
The checked-in Guard policy is
`deploy/organization-authority/authority-current-host-recovery-v1.guard`.

From the exact reviewed source root, all three validations must exit `0`:

```sh
cfn-lint --version
cfn-guard --version
cfn-lint deploy/organization-authority/authority-current-host-recovery-v1.template.json
cfn-guard validate \
  --rules deploy/organization-authority/authority-current-host-recovery-v1.guard \
  --data deploy/organization-authority/authority-current-host-recovery-v1.template.json
aws cloudformation validate-template \
  --template-body file://deploy/organization-authority/authority-current-host-recovery-v1.template.json \
  --region <approved-region> --profile <authority-account-profile>
```

The version commands must report exactly `cfn-lint` 1.55.1 and
`cfn-guard` 3.2.1. A parse warning, lint warning/error, failed Guard rule, wrong
version, or CloudFormation validation error stops the change. Keep the command
outcomes in the private receipt; do not copy private parameters into committed
logs.

Create or update an AWS Backup plan in the Authority account that selects that
one volume by exact resource selection. Do not use an account-wide selection,
an unreviewed wildcard, or a selection that will silently protect future
volumes. The later infrastructure foundation replaces or imports this interim
exact selection into its `Org` tag-selected plan.

The template emits `BackupServiceRoleArn` with the AWS-managed
`AWSBackupServiceRolePolicyForBackup` policy and a distinct
`RestoreServiceRoleArn` with `AWSBackupServiceRolePolicyForRestores`. AWS Backup
assumes those roles; the restore caller still needs least-privilege
`iam:PassRole` permission for the exact restore-role ARN.

Use a named CloudFormation change set for every create or update and review its
complete resource and replacement list before execution. For a new stack,
create the `CREATE` change set but do not execute it; CloudFormation leaves the
empty stack shell in `REVIEW_IN_PROGRESS`. For an existing stack, use an
`UPDATE` change set. Supply the approved cadence/retention/window parameters and
the privately confirmed root-volume ID; acknowledge `CAPABILITY_IAM`. Wait for
the change set's `CREATE_COMPLETE`, inspect the complete
`describe-change-set` result, and record the change-set ARN privately.

The following is the required command shape for a new stack. Substitute only
private, pre-approved values in the controlled operator session. Use
`--change-set-type UPDATE` for an existing stack and provide every currently
accepted parameter explicitly there as well:

```sh
aws cloudformation create-change-set \
  --stack-name echo-authority-current-host-recovery \
  --change-set-name <unique-reviewed-change-set-name> \
  --change-set-type CREATE \
  --template-body file://deploy/organization-authority/authority-current-host-recovery-v1.template.json \
  --parameters \
    ParameterKey=AuthorityRootVolumeId,ParameterValue=<confirmed-root-volume-id> \
    ParameterKey=BackupScheduleExpression,ParameterValue='<approved-cron-expression>' \
    ParameterKey=RecoveryPointRetentionDays,ParameterValue=<approved-days> \
    ParameterKey=StartWindowMinutes,ParameterValue=<approved-start-window> \
    ParameterKey=CompletionWindowMinutes,ParameterValue=<approved-completion-window> \
  --capabilities CAPABILITY_IAM \
  --region <approved-region> --profile <authority-account-profile>
aws cloudformation wait change-set-create-complete \
  --stack-name echo-authority-current-host-recovery \
  --change-set-name <unique-reviewed-change-set-name> \
  --region <approved-region> --profile <authority-account-profile>
aws cloudformation describe-change-set \
  --stack-name echo-authority-current-host-recovery \
  --change-set-name <unique-reviewed-change-set-name> \
  --include-property-values \
  --region <approved-region> --profile <authority-account-profile>
aws cloudformation update-termination-protection \
  --stack-name echo-authority-current-host-recovery \
  --enable-termination-protection \
  --region <approved-region> --profile <authority-account-profile>
```

Before executing a new-stack change set, enable termination protection on its
`REVIEW_IN_PROGRESS` stack shell and verify `EnableTerminationProtection=true`
with `describe-stacks`. For an existing stack, verify protection before the
plan change. Creating the change set and enabling protection do not authorize
execution. Do not execute until the founder has approved the exact cadence,
retention, resource list, IAM roles, and reviewed change set. Do not execute a
change set that would replace or delete the vault, plan, selection, or either
service role without a founder-approved migration. The exact current-volume
selection is an interim recovery floor: C1 must migrate it deliberately to the
later `Org`-tag-selected foundation plan, with a reviewed overlap or handoff
rather than an unprotected gap.

AWS Backup Vault Lock is deliberately deferred from this sprint. It may make
retention immutable and changes the operator's ability to correct a mistake or
clean up the interim vault. Record that decision explicitly when C1 defines the
foundation retention and governance boundary; do not imply this retained vault
is Vault Lock protected.

Before executing the plan change, inspect that it has all of the following:

- the approved schedule and retention, with no unexpected expiry action;
- only the identified root volume in its selection; and
- a documented restore principal, exact `RestoreServiceRoleArn`,
  least-privilege `iam:PassRole` precondition, and job-completion check
  procedure; and
- accepted change-set review and termination-protection evidence.

Expected evidence is a completed private gate and a reviewed plan/selection
whose scope is exactly one root volume and whose schedule, retention,
source-encryption evidence, and monitoring state are explicit. The vault does
not independently re-encrypt this EBS recovery point. If a plan already exists,
make a reviewed update rather than creating a second schedule with an unknown
interaction.

### 2. Establish the recurring crash-consistent protection

Enable the approved plan and wait for a recovery point created by its schedule
while the Authority remains running. Record only the scheduled job's completion
time, configured cadence, and the age of that point when later used; keep its
AWS identifier private.

Expected evidence is one successful schedule-produced recovery point in the
approved vault, with its source-volume encryption facts checked against the
private evidence gate. It protects the entire current root volume, including
deployment state and private credential files, but it is a crash-consistent
copy. Do not call it application-consistent, quiesced, reconciled, independently
vault-encrypted, or ready to serve.

If the scheduled job fails, contain the problem in AWS Backup configuration and
do not proceed to a restore drill until the failure is understood. Do not
substitute a manually copied directory for this recovery point.

### 3. Create the one qualifying recovery point from a quiesced Authority

During the approved maintenance window, first settle the Authority operation
lock using the deployment README if necessary. Do not issue `docker compose
down`, `docker compose up`, or an AWS Backup command from the Authority host by
hand. The maintenance script is the only supported way to stop and restart the
live Compose profile for this qualifying point. It holds the shared operation
lock, refuses a staged release or active onboarding, records a unique operation
identity, stops both EC2 Compose services, flushes writes, requires an external
acknowledgement, and automatically restarts and proves the accepted tuple on
every exit path it can handle.

Start the durable transaction from an SSM or other controlled host session. Use
the installed deployment path and a bounded timeout appropriate to the approved
window:

```sh
sudo systemd-run --unit=echo-authority-backup-maintenance --wait --collect \
  --service-type=exec --property=TimeoutStartSec=3900 \
  --property=TimeoutStopSec=300 \
  /srv/echo-authority-clean-v1/backup-authority-maintenance.sh \
  maintain --ack-timeout-seconds 900
```

Do not omit or reduce those unit bounds. The script permits at most 3,600
seconds for the coordinator acknowledgement. `TimeoutStartSec=3900` leaves 180
seconds for its two no-pull 90-second `compose up --wait` recovery attempts and
120 seconds for descriptor/cleanup margin. If systemd sends `TERM`,
`TimeoutStopSec=300` leaves those same 180 seconds plus 120 seconds for the
exit trap to restart and prove the accepted tuple before systemd can send a
final kill signal. Keep the acknowledgement timeout at or below 3,600 seconds;
choose a shorter value for the approved window when possible.

Keep its `operation_id` and `coordinator_nonce` in the founder-private receipt.
They bind this one stop window to one acknowledgement and are never committed or
placed in a ticket or chat. A terminal or SSM-session disconnect does not
authorize a manual recovery: inspect the transient systemd unit and follow the
deployment lock-recovery procedure only if the script reports
`recovery_required`.

The waiting status also records the current maintainer PID/start time and an
`acknowledgement_deadline_epoch_seconds`. The coordinator must submit its
acknowledgement before that persisted deadline, even if the status has not yet
flipped to `ack_timeout`; a late acknowledgement is rejected rather than racing
the recovery path.

While the script reports that it is awaiting its external acknowledgement, the
separate AWS Backup coordinator creates one on-demand backup of the exact,
pre-verified root volume. It must pass the stack's exact
`BackupServiceRoleArn`, not the restore role or Authority host role. Its caller
must have only the reviewed `backup:StartBackupJob`, backup-job and
recovery-point read permissions (`backup:DescribeBackupJob`,
`backup:ListRecoveryPointsByBackupVault`, and
`backup:GetRecoveryPointRestoreMetadata` as needed), and `iam:PassRole` for
that exact backup-role ARN with
`iam:PassedToService=backup.amazonaws.com`. Do not grant wildcard role passing
or an alternate service principal.

The coordinator must explicitly set `Lifecycle.DeleteAfterDays` on the
on-demand job to the founder-approved value equal to the scheduled plan's
`RecoveryPointRetentionDays`. It waits for the AWS Backup job to complete and
for its qualifying recovery point to be visible in the approved vault, then
verifies that recovery point's expiry records that same approved retention. If
the lifecycle is absent, differs from the approved scheduled retention, or its
expiry cannot be verified, do not acknowledge the maintenance transaction.

Use the following on-demand command shape from the external coordinator, never
from the Authority host. Its output and substituted values remain in the
private receipt:

```sh
aws backup start-backup-job \
  --backup-vault-name <BackupVaultName-output> \
  --resource-arn <SelectedRootVolumeArn-output> \
  --iam-role-arn <BackupServiceRoleArn-output> \
  --idempotency-token <operation-id> \
  --lifecycle DeleteAfterDays=<approved-retention-days> \
  --region <approved-region> --profile <authority-account-profile>
aws backup describe-backup-job \
  --backup-job-id <returned-backup-job-id> \
  --region <approved-region> --profile <authority-account-profile>
```

Poll `describe-backup-job` to terminal `COMPLETED`; then inspect the exact
recovery point in the approved vault to verify resource identity and expiry.
Any other terminal state or retention mismatch is failure evidence, not an
acknowledgement condition.

In the private receipt, record the operation ID, backup-job ID, recovery-point
ID, backup completion time, selected volume, source-encryption evidence,
explicit lifecycle/expiry verification, and any failure. Do not acknowledge a
merely requested, failed, wrong-resource, or wrongly retained backup.

Only after that independent AWS evidence is complete, acknowledge the waiting
transaction from a controlled Authority-host session with the exact private
identity it emitted:

```sh
sudo /srv/echo-authority-clean-v1/backup-authority-maintenance.sh \
  acknowledge --operation-id <operation-id> --nonce <coordinator-nonce>
```

The script then restarts the exact already-present accepted image without
pulling, proves both Authority and proxy containers healthy, verifies the image
digest, source/release/runtime-profile tuple, and proves the public descriptor
equals the local descriptor. It releases the operation lock only after that
proof. If the acknowledgement times out or any step fails, its exit handler
attempts the same no-pull restart and proof; if that proof fails it keeps the
lock and records `recovery_required` rather than claiming recovery.

Expected evidence is a successful backup job and qualifying recovery point in
the private receipt, plus the maintenance transaction's `maintenance_complete`
result and its automatic accepted-tuple/public-descriptor proof. A failed
backup job never authorizes leaving the live Authority stopped. The source host
is not modified beyond this bounded script-managed stop/start.

### 4. Restore only to an isolated, non-root secondary device

Start the restore with the stack's exact `RestoreServiceRoleArn`; the restore
caller must have only the reviewed `backup:GetRecoveryPointRestoreMetadata`,
`backup:StartRestoreJob`, and `backup:DescribeRestoreJob` actions needed by this
procedure, plus `iam:PassRole` for that exact restore-role ARN with
`iam:PassedToService=backup.amazonaws.com`. It must not pass the Authority host
role, backup role, or a wildcard role.
Request the restored EBS volume in the prepared helper's exact Availability
Zone. Before attachment, privately inspect the restore result with
account-scoped `describe-volumes` and proceed only when it establishes all of
the following: the returned volume is the volume created by the intended
qualifying recovery point, it is in that helper Availability Zone,
`Encrypted` is exactly `true`, `KmsKeyId` is present and identifies the same
approved Authority-account KMS boundary as the source evidence gate (confirm
the returned key through `describe-key` is in that account and enabled), and it
is `available` with no attachments. This is validation of the restored volume's
identity and encryption, not a check of the helper root volume.

First call `get-recovery-point-restore-metadata` and retain its private output.
Build the EBS metadata map from those reviewed source facts, overriding the
destination controls explicitly. The command shape is:

```sh
aws backup get-recovery-point-restore-metadata \
  --backup-vault-name <BackupVaultName-output> \
  --recovery-point-arn <qualifying-recovery-point-arn> \
  --region <approved-region> --profile <authority-account-profile>
aws backup start-restore-job \
  --recovery-point-arn <qualifying-recovery-point-arn> \
  --resource-type EBS \
  --iam-role-arn <RestoreServiceRoleArn-output> \
  --metadata availabilityZone=<helper-az>,encrypted=true,kmsKeyId=<approved-kms-key-id>,volumeType=<source-volume-type>,volumeSize=<source-size-gib> \
  --idempotency-token <private-restore-operation-id> \
  --region <approved-region> --profile <authority-account-profile>
aws backup describe-restore-job \
  --restore-job-id <returned-restore-job-id> \
  --region <approved-region> --profile <authority-account-profile>
```

Poll to terminal `COMPLETED`, then identify its created EBS volume from the
restore result and perform the independent EC2/KMS gates below. A successful
restore-job status alone does not authorize attachment.

Attach only that validated restored volume to the prepared helper as a
secondary device. Never create an instance from the restored root volume, never
select it as the helper's root device, and never attach it to the live
Authority. Record only sanitized booleans for identity, Availability-Zone,
encryption, KMS-boundary, and secondary-attachment validation.

On the helper, confirm the root-device source before inspecting any restored
device:

```sh
findmnt -no SOURCE /
lsblk --fs
```

Identify the restored device and its partition from the `lsblk` output and
cross-check it to the previously validated restored-volume attachment. If it
matches the helper root device, cannot be tied to that restored-volume
attachment, or is automatically mounted, stop and detach it. Do not use a
filesystem repair command, a writable mount, or a tool that may replay a
journal.

Determine the filesystem type from the identified restored partition, then use
only its documented read-only no-replay mount option. For the currently
expected Linux filesystems, the required forms are:

```sh
sudo mount -o ro,noload <restored-partition> <empty-mount-directory>       # ext4
sudo mount -o ro,norecovery <restored-partition> <empty-mount-directory>   # xfs
sudo mount -o ro,nologreplay <restored-partition> <empty-mount-directory>  # btrfs
```

Replace the placeholder only after confirming the filesystem type. Do not pass
an ext4 option to another filesystem. For an unknown type, stop. If safe
no-replay semantics cannot be demonstrated, detach the original restored
artifact; a separately cloned copy may be used only under an approved
filesystem-specific inspection procedure.

Expected evidence is a secondary device mounted read-only with an explicit
no-replay option. Record the filesystem type and boolean mount facts, not the
device, partition, or mount identifier.

### 5. Inspect structure and run the offline verifier

On the read-only mount, locate the expected Authority state directory:

```text
<read-only-mount>/srv/echo-authority-clean-v1/clean-data
```

Confirm that `release/`, `state/`, and `private/` are present. For `private/`,
inspect only aggregate entry count, file-type classes, ownership, and mode;
never record or emit private entry names or paths, or open, copy, hash, print,
or upload a private file.

Run the pre-staged verifier with explicit absolute paths. Before attachment,
the staged Authority source root, Node runtime, lockfile-derived dependency
tree, and required workspace build output must each have passed checksum
verification, and the verifier must already have passed its offline synthetic
fixture smoke test above. The staged source root is outside the restored volume:

```sh
node tools/verify-authority-recovery.mjs \
  --clean-data <read-only-mount>/srv/echo-authority-clean-v1/clean-data \
  --source-root <checksum-verified-authority-source-root>
```

The verifier emits one canonical JSON line with a fixed schema identifier and
sanitized `ok` booleans and counts. It checks the accepted release to runtime
profile tuple; the exact, complete runtime-environment snapshot schema; and the
five environment fields bound to the accepted release. The remaining snapshot
fields are checked for the relationships and input formats enforced by
`onboard-clean-v1.sh`; they cannot be independently bound to the release record
because that record intentionally does not contain organization contact or host
configuration. It also checks primary SQLite integrity, published retrieval
SQLite integrity, state lineage, retrieval-generation structure, and
private-entry type/permission metadata. Before importing lineage code or
opening any SQLite database, it refuses every symlink or special filesystem node
under `state/`, including a retrieval database path, and any SQLite hot-state
sidecar (`-journal`, `-wal`, or `-shm`). The CLI independently attests the
closest mount for `clean-data/` from Linux `/proc/self/mountinfo` is read-only
both before and after inspection. It must not emit paths, identifiers, database
rows, credential contents, hashes of private contents, or private entry names.

The verifier runs offline. Do not run `serve`, founder `status`, onboarding,
Docker Compose, image pulls, provider calls, or a Person client against the
restored state. A structurally valid result does not establish freshness: V1
has no independently retained monotonic witness.

Expected evidence is an `ok` verifier result with valid sanitized counts and
booleans. Any failure is a recovery finding: preserve the private receipt,
detach the volume, and do not attempt repair in place.

### 6. Contain the restored copy and record the boundary

Unmount the restored filesystem, detach the validated restored EBS volume, and
wait until account-scoped `describe-volumes` reports that exact restored volume
as `available` with zero attachments before deletion. Re-confirm the volume
identity against the restore receipt immediately before deletion; delete only
that restored drill volume, never the helper root, the live Authority volume,
or any source volume. Then terminate the helper. Do not retain a mounted
restored copy, an attached helper, or copied private state as a convenience
environment. Record only sanitized cleanup booleans: unmounted, detached,
availability-confirmed, restored-volume-deleted, and helper-terminated.

Write a timestamped qualification record only after this external drill
completes. The committed record contains source commit, configured cadence,
age of the restored point at drill start, elapsed restore and inspection time,
and sanitized boolean/count outcomes. It includes no private entry names or
paths. The private operator receipt retains the AWS and host identifiers
required to repeat the drill.

Expected evidence distinguishes the reviewed source/runbook from the actual
AWS result. It must say `Refs #20`, never `Closes #20`.

## Rollback, containment, evidence, and follow-up

If the backup-plan change is rejected or produces an unexpected selection, do
not execute it. Keep the prior approved plan unchanged while the scope is
corrected. If the maintenance transaction reports `recovery_required`, do not
remove its lock or run Compose manually: follow the deployment lock-recovery
procedure and preserve the private transaction and AWS Backup evidence. If the
live Authority does not return healthy after the qualifying point, follow the
existing release/onboarding recovery procedures; do not use the restored volume
as an emergency boot disk.

If helper isolation, secondary-device attachment, read-only no-replay mounting,
or offline verification cannot be proven, detach the restored volume and
use the same wait-for-`available`, identity re-confirmation, restored-volume
only deletion, and sanitized cleanup confirmation before terminating the
helper. Preserve only the founder-private operator receipt and sanitized
finding. The failure is evidence that the recovery floor has not been rehearsed,
not permission to relax the isolation boundary.

Record only:

- reviewed source commit and runbook revision;
- the private evidence-gate result for source `Encrypted`, source `KmsKeyId`,
  source-volume account ownership, source-key manager/enabled state, and AWS
  Backup-access checks, without the identifiers themselves;
- configured cadence and retention;
- scheduled job success/failure, source-encryption evidence result, and time;
- qualifying maintenance operation result, backup-job/recovery-point evidence,
  automatic restart result, and accepted-tuple/public-descriptor proof;
- qualifying clean-stop and recovery-point completion times;
- recovery-point age at drill start and elapsed restore/inspection times;
- helper-IaC isolation, exact-restore-role `iam:PassRole`, restore-volume
  identity, Availability-Zone, encryption/KMS-boundary, non-root-attachment,
  no-replay-mount, no-network, and no-Authority-start booleans;
- sanitized verifier booleans and counts; and
- sanitized unmount, detachment, availability confirmation, restored-volume
  deletion, and helper-termination booleans, with no private entry names or
  paths.

Set `tested_at` only after the schedule has produced a recovery point, the
quiesced qualifying point has been restored, the secondary no-replay inspection
has completed, the verifier has passed, and the helper and restored attachment
have been removed with the sanitized cleanup confirmation. This runbook remains a recovery floor until the full
same-lineage serving recovery in issue #20 is proved.
