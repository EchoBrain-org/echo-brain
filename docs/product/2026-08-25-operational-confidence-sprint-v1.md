# Operational confidence sprint V1

**Status:** sequencing plan accepted; implementation in progress since
2026-08-25. DEC-A and DEC-B were accepted on 2026-08-26. Sprint exit has not
been claimed.
**Grounded at:** `main` @ `35875e49817c841ac1f8aa3abf669d6e9a636a83`
(merge of PR #67), inspected 2026-08-25.
**Scope:** current-Authority recovery floor, developer tooling, and DEC-A/DEC-B
decision records. No product, Layer 1–4, record, release-contract,
host-provisioning, staging, or accepted-decision implementation change.

## Sprint decision

The next sprint is intentionally smaller than the operational-readiness
programme. It has three outcomes:

1. one reproducible local Authority development loop;
2. one measured, cancellable, safely parallel CI loop; and
3. one scheduled, encrypted, crash-consistent off-host root-volume snapshot
   that has been restored as a secondary device and inspected offline without
   starting a second Authority.

The sprint also records the two decisions required by the later provisioning
programme. It does not build that programme.

The founder explicitly paused the issue-resolution lane on 2026-08-25 and
authorized this sprint before the remaining first-cohort tracker work. Issue
#53 is not being edited during that pause. This document records the temporary
execution order; the tracker must be reconciled before the beta lane resumes.

The five operational gaps are not five sprint phases. This sprint deliberately
closes only GAP-05, lowers the immediate loss exposure in GAP-01, and removes
the decisions that block the later GAP-02/GAP-03 programme. GAP-04 remains in
issue #28.

## Near-term return and gap boundary

| Work                                                                         | Near-term return                                                                                          | Gap result                                                    |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Current-host backup and offline restore proof                                | Highest downside reduction: one host-volume failure is no longer an entirely untested permanent-loss path | Reduces GAP-01; issue #20 and full GAP-01 remain open         |
| Safe local Authority loop                                                    | Highest repeated developer-speed return for every Authority change and clean-checkout reproduction        | Closes GAP-05                                                 |
| Measured CI graph, cancellation, and retained wins                           | Shorter PR feedback and less obsolete runner work without reducing the release proof                      | Closes issue #31; does not publish images or close GAP-04     |
| Accepted DEC-A and DEC-B                                                     | Prevents the data-volume split and account boundary from being redesigned during module implementation    | Unblocks, but does not implement or close, GAP-02 and GAP-03  |
| CI image publication, staging, host IaC, Litestream, and controller rewrites | Lower immediate return or dependent on the decisions and recovery boundary                                | Deferred to issue #28 or the following provisioning programme |

After the read-only AWS discovery gate, enabling the backup schedule is the
first live change.
The local harness and offline verifier can be built in parallel. CI-file work
starts from merged PR #67, and no per-organization module work starts in this
sprint.
The numbered phases below group code and review ownership; they are not a
strict live-operations waterfall.

## Corrected current baseline

The earlier readiness proposal was grounded at `17a520f`. The current baseline
contains two material later changes:

- PR #65 completed the real Authority outage and recovery rehearsal, closed
  issue #35, and set
  [`RB-OPERATIONS-001`](../operations/RB-OPERATIONS-001-authority-observability.md)
  to `tested_at: 2026-08-25`. Observability rehearsal is therefore not a sprint
  task. Repeat it only after a material observability stack, destination,
  host-role, or logging change.
- PR #66 binds image, runtime profile, environment snapshot, Compose/Caddy
  materialization, proxy, promotion, and rollback into one validated release
  tuple. It advances issue #28 but deliberately does not publish a real image
  or automate SSM promotion.

At sprint start there were 11 open issues, no open pull requests, and no
repository backlog directory. PR #67, `chore/dev-cycle-fast-lane` at `3c92739`,
was merged as `35875e4`. It references issues #25 and #53, adds CI concurrency
cancellation, and starts the independent platform gates without waiting for the
shared check; it does not reference or partially close issue #31. Its workflow
edit implements part of #31 on the same file surface.

The merged workflow gives `push` and `workflow_dispatch` runs on `main` one shared
concurrency group with `cancel-in-progress: true`. A later run can therefore
cancel an earlier canonical `main` result, contrary to issue #31. Correcting
that behavior is the first CI change in this sprint; the merged behavior is not
accepted as final CI semantics.

A repeated conflict check on 2026-08-25 found open PRs #68 and #69 changing only
`.codex/cloud-task-34.md` and `.codex/cloud-task-47.md`. They have no path
overlap with this sprint. Re-run the check before merge; this observation is not
a standing concurrency guarantee.

### Read-only pre-sprint CI timing evidence

The following measurements are read-only baseline evidence captured before this
sprint's CI changes. They are useful for choosing experiments, not for claiming
that the sprint has met its performance acceptance.

| Configuration                                                                                     |            Sample | Median wall time | Median active critical path | Median runner time |
| ------------------------------------------------------------------------------------------------- | ----------------: | ---------------: | --------------------------: | -----------------: |
| Strict serial baseline                                                                            | 4 successful runs |            361 s |                       357 s |            379.5 s |
| [PR #67 first parallel run](https://github.com/EchoBrain-org/echo-brain/actions/runs/32884118872) |  1 successful run |            229 s |                       185 s |              375 s |

The first parallel run's individual active jobs were shared check 162 seconds,
Authority container 185 seconds, and Person package 28 seconds; its 44-second
queue delay accounts for the difference between active critical path and wall
time. It demonstrates real overlap, but its single sample and the four-run
strict baseline are too small to establish a durable speedup or a runner-cost
change. The required post-change result remains the comparable five-run
baseline and five-run retained-configuration protocol below, with its own
recorded evidence.

A local native-ARM BuildKit trial on 2026-08-25 separately proved the new
dependency boundary. A complete image build succeeded; adding one temporary
source-only marker below `packages/` invalidated `COPY packages` and the build
step while every manifest copy and the first `RUN npm ci` remained `CACHED`.
The marker was then removed and left no worktree change. This proves the layer
input boundary, not a GitHub cache-speed result; the required post-change
workflow measurements remain outstanding.

Local recovery-template validation on 2026-08-25 passed with Python 3.10, the
complete checksum-pinned `cfn-lint` 1.55.1 wheel set, and checksum-verified
CloudFormation Guard 3.2.1 against the checked-in policy. The Authority-account CloudFormation `validate-template`
call also passed and reported the expected `CAPABILITY_IAM` requirement. No
change set or AWS resource was created; cadence approval and unexecuted
change-set review remain outstanding.

## Open-issue reconciliation

| Issue                                                                                                 | Current relationship to this sprint                                                   | Required disposition                                                          |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [#17](https://github.com/EchoBrain-org/echo-brain/issues/17) Granola intake-to-approval               | Open P1 beta product gate; no direct code overlap                                     | Remains outside this operations/tooling sprint                                |
| [#20](https://github.com/EchoBrain-org/echo-brain/issues/20) Authority recovery                       | Direct overlap, but its acceptance is larger than this sprint's read-only restore     | This sprint may only `Refs #20`; it does not close it                         |
| [#25](https://github.com/EchoBrain-org/echo-brain/issues/25) canonical commit and artifact protection | Depends on final CI check topology                                                    | Apply the GitHub ruleset after issue #31 establishes a stable aggregate check |
| [#28](https://github.com/EchoBrain-org/echo-brain/issues/28) ARM64 promotion                          | PR #66 advanced it; ECR publish, SSM promotion, and receipt remain                    | Keep deferred; no OIDC or image publication in this sprint                    |
| [#31](https://github.com/EchoBrain-org/echo-brain/issues/31) cancellable and parallel CI              | Direct sprint work; merged PR #67 implements unsafe cancellation and initial overlap  | Correct and finish through this sprint without editing the paused issue lane  |
| [#34](https://github.com/EchoBrain-org/echo-brain/issues/34) Granola preview                          | No overlap                                                                            | Keep deferred                                                                 |
| [#47](https://github.com/EchoBrain-org/echo-brain/issues/47) bounded search work                      | No overlap                                                                            | Keep deferred                                                                 |
| [#51](https://github.com/EchoBrain-org/echo-brain/issues/51) employee install-to-ready                | PR #61 implemented substantial code; acceptance evidence remains open                 | Keep in the beta lane; do not claim it from this sprint                       |
| [#52](https://github.com/EchoBrain-org/echo-brain/issues/52) automatic Person updates                 | No product-scope overlap, but a future updater may touch CI, package, or README paths | Keep deferred post-beta; re-check active paths before concurrent work         |
| [#53](https://github.com/EchoBrain-org/echo-brain/issues/53) beta tracker                             | Explicitly defers #20 and #31 and still leaves closed issue #57 unchecked             | Issue lane is paused; reconcile it before returning to beta work              |
| [#59](https://github.com/EchoBrain-org/echo-brain/issues/59) cited answer flow                        | PR #60 implemented deterministic code; live provider rehearsal remains                | Keep in the beta lane; do not claim it from this sprint                       |

The founder's explicit sequencing decision is authoritative for this sprint.
Issue #53 remains unchanged during the issue-lane pause and must be reconciled
before beta work resumes. Issue #28 remains deferred. This sprint is not a beta
gate and does not claim beta readiness.

## Entry gates and concurrent-work rule

The founder sequencing decision satisfies the priority gate without mutating
the paused issue lane. This sprint document owns GAP-05 acceptance until issue
tracking resumes.

The CI workstream has additional gates:

1. PR #67 passed its checks and merged as `35875e4`;
2. `sprint/operational-confidence` is rebased onto that merge;
3. PR #67's final workflow and package changes have been inspected; and
4. no other open PR changes the CI and Docker paths assigned below.

Local-loop code that does not edit CI, recovery documentation/tooling, and ADR
drafts may proceed independently.

Correct PR #67's merged cancellation semantics rather than layering a second
workflow over them. Do not configure issue #25's required checks until this
sprint exposes one reviewed, stable aggregate result and records whether that
aggregate replaces or supplements the three individual gates.

## Phase 1 — Reproducible and faster feedback

### 1A. Committed local Authority loop

Extract the reusable reset, seed, Compose/Caddy, and descriptor exercise from
the current `authority-container` CI job into one non-production harness with
`up`, `reset`, and `down` operations. CI and local development share that
exercise harness, not the release-image builder: local development may build a
dirty source tree labeled unmistakably non-releasable, while CI retains the
clean exact-ARM64 image, OCI revision, Node-version, runtime-profile, and
release-record proofs.

Likely code group:

- new developer command under `tools/` or
  `deploy/organization-authority/`;
- `package.json` command aliases;
- root `README.md` and the Authority deployment README;
- one focused architecture or integration test; and
- `.github/workflows/ci.yml`, in the later single-owner CI sequence, only to
  call the extracted exercise harness rather than carry a second implementation.

The committed base Compose profile has a fixed project name, a relative
`./clean-data` bind mount, and loopback ports 80/443. It is also byte-bound into
the accepted runtime profile, so it must not be edited solely for local
convenience. The harness instead generates a temporary local-only Compose
overlay or materialization that `docker compose config` proves has replaced,
not appended, these unsafe defaults.

Required safety and lifecycle boundary:

- create one mode-`0700`, sentinel-marked, tool-owned state directory outside
  the repository and refuse every unowned, deployment, symlink, or production
  state path before filesystem or Docker mutation;
- use an explicit project name derived from canonical worktree identity and
  current UID so one checkout cannot stop another checkout's project;
- bind only selected or reserved high loopback ports and fail safely before
  mutation when they are unavailable;
- use the base Compose profile only, never the EC2 override;
- make `up` reuse only valid tool-owned state and make an exact repeat safe;
- make `reset` the sole state-destructive operation: stop the owned project,
  delete and reseed only its sentinel-marked synthetic state, then restart;
- make `down` idempotently remove only the owned project containers, network,
  and generated Docker volumes while retaining synthetic bind-mounted state;
- never require or read provider credentials.

The local HTTPS path must be documented. A Person-client exercise uses Caddy's
local CA through `NODE_EXTRA_CA_CERTS`; `curl --insecure` alone is not proof that
the packaged client trusts the local Authority.

Acceptance:

- a clean checkout reaches HTTP `200` from
  `/v1/authority-descriptor` through Caddy using only documented commands;
- an unsafe requested state path is rejected before filesystem or Docker
  mutation;
- `up`, an exact repeated `up`, `reset`, an exact repeated `reset`, a final
  `up`, and `down` exercise the stated lifecycle without touching another
  Compose project;
- CI extracts Caddy's local root certificate and uses
  `NODE_EXTRA_CA_CERTS` with the actual Person Authority client to fetch the
  descriptor over HTTPS; `curl --insecure` is not the TLS acceptance proof;
- the CI Authority exercise calls the same committed exercise harness; and
- `npm run check` passes.

The new focused issue closes GAP-05 only after all of this acceptance is
recorded. Local tool/test/docs land before the sole CI owner changes the
workflow to adopt the harness.

### 1B. Finish issue #31 without weakening gates

After a corrected PR #67 merges, complete issue #31 as a separate commit
sequence owned by one CI author:

1. retain cancellation only for superseded pull-request runs; use unique groups
   and no cancellation for `push` and `workflow_dispatch` canonical runs;
2. expose timing for the shared check and Authority container work;
3. remove only dependency edges whose jobs consume no output from one another;
4. retain the full shared check, standalone macOS Person package, and exact
   Authority-image/runtime proof;
5. add a stable-named `if: always()` aggregate job that explicitly fails unless
   `check`, `person-client-package`, `authority-container`, and the later
   checksum-pinned recovery-infrastructure proof all report `success`; and
6. record before/after wall time and total runner time on comparable runs.

Conditional optimizations follow the graph change; they are not independent
sprint promises:

- trial a native GitHub ARM64 runner against the QEMU baseline;
- copy the root and every workspace package manifest plus the lockfile before
  `npm ci`, then copy source, and prove that a source-only edit preserves the
  dependency layer; and
- add separately scoped PR and protected/main Buildx caches only after that
  layer boundary is effective. A raw Buildx invocation must receive the GitHub
  cache runtime explicitly, or use the pinned Docker build action that provides
  it; protected builds neither trust nor write a PR-owned scope.

Keep an optimization only with measured benefit and unchanged proof. Do not
shard tests in this sprint unless timings show that the full shared check, not
the job dependency graph, remains the material bottleneck.

Core acceptance is issue #31's acceptance plus two separate measurement
protocols. Mixing them would hide whether the runner or the cache produced a
change:

- the runner trial uses five successful x86/QEMU runs and five successful
  native-ARM runs. The runner labels necessarily differ and are recorded. The
  paired workflow revisions hold the graph, proof steps, source inputs, and
  disabled-or-unique cache condition constant except for the runner/QEMU
  configuration;
- after selecting the runner, the cache trial uses that same runner label,
  workflow revision, proof job, and source revision for five cold runs and five
  warm runs. Cold runs use disabled or unique scopes. A successful writer
  primes the one shared warm scope before the five measured warm readers;
- cancelled runs and failed infrastructure starts are excluded from medians but
  recorded separately as reliability results;
- the dependency graph actually overlaps independent jobs and the median
  active critical path does not exceed 204 seconds, the predeclared 10 percent
  tolerance above PR #67's 185-second single-run reference. The retained native
  runner must also beat the five-run QEMU Authority-job median; the retained
  cache must reduce the five-run native Authority-job median by at least 10
  percent without adding a reliability failure;
- ARM architecture, OCI source revision, product Node version, runtime-profile
  digest, release-record digest, Compose/Caddy validation, clean reset,
  in-container descriptor, and Caddy descriptor proof remain present; and
- issue #25 explicitly records whether its ruleset requires the aggregate alone
  or the aggregate plus the individual jobs before the setting is applied; and
- a timestamped report under `docs/qualification/`, linked from
  `CMP-OPERATIONS-RELEASE`, records run URLs, exact workflow/source revisions,
  runner labels, cache conditions/scopes, per-job active time, wall time, total
  runner time, exclusions, medians, and the keep/revert decision.

The performance target is a median active critical path at or below 185
seconds, with 204 seconds as the hard no-regression ceiling for runner noise.
Missing the target does not erase a correct issue #31 graph result, but no
conditional native-runner or cache change is retained without satisfying its
separate measured threshold and unchanged proof.

## Phase 2 — Current-host recovery floor

This phase provides immediate off-host block-level protection for the current
Authority. A scheduled snapshot of the running root volume is crash-consistent;
it is not the stopped, reconciled, serving recovery required by issue #20. This
phase never boots the restored root filesystem or starts a restored Authority.

Repository code group:

- `authority-current-host-recovery-v1.template.json`, its checked-in
  CloudFormation Guard policy, and architecture tests, with distinct AWS Backup
  backup and restore service roles;
- `RB-OPERATIONS-002` from the runbook template;
- the operations index and `CMP-OPERATIONS-RELEASE.runbook_ids` backlink;
- the Authority deployment README;
- one narrow offline read-only verifier plus focused tests, unless the runbook
  proves an existing exact verifier covers every item below; and
- a timestamped qualification record with
  `CMP-OPERATIONS-RELEASE.qualification_ids` backlink only after the real drill
  is complete. Private operator evidence remains outside the repository.

The offline verifier is built from the accepted source and checksum-verified on
the clean helper before any restored volume is attached. The staged set includes
the Node runtime, lockfile-derived dependency tree, and required workspace build
output, not source alone. It first passes an offline synthetic-fixture smoke
test before attachment, then runs without network access and:

- validates the canonical current release record, active runtime profile, and
  saved runtime-environment tuple under `clean-data/release`;
- checks every primary SQLite database and every published retrieval
  generation's `facts.sqlite`, `lexical.sqlite`, and `content.sqlite` read-only;
- invokes the existing state-lineage/retrieval-generation validation or an
  equivalent exact implementation over `clean-data/state`; and
- emits sanitized booleans and counts only. It does not mount or read credential
  contents, start `serve`, call founder `status`, pull an image, or make a
  provider call.

External operator work:

- before any change set, run pinned `cfn-lint` 1.55.1, CloudFormation Guard
  3.2.1 against the checked-in policy, and the account-scoped CloudFormation
  `validate-template` call; record their exact versions and successful outcomes
  privately;
- use AWS Backup in the current Authority account to schedule the existing root
  volume by exact resource selection, using distinct backup and restore service
  roles. The restore caller has `iam:PassRole` only for the exact emitted
  restore-role ARN. Every stack create/update uses a reviewed named change set
  and termination protection; C1 later migrates this interim selection into the
  tag-selected foundation plan without an unprotected gap. AWS Backup Vault Lock
  is explicitly deferred to C1's retention/governance decision;
- before any CloudFormation change, record private evidence that the exact root
  volume has `Encrypted=true`, a `KmsKeyId`, and the Authority-account owner,
  and that the source KMS key is enabled, same-account, usable by AWS Backup,
  and records `KeyManager` as `AWS` or `CUSTOMER`. EBS recovery points inherit
  source encryption; the template and backup vault do not independently
  re-encrypt them. The current AWS-managed `aws/ebs` class is valid for this
  same-account sprint but blocks future cross-account copies; a CMK migration
  belongs to the later data-volume/foundation decision;
- before mutation, record approved cadence and retention, Region, restore
  principal and exact restore-role boundary, operator responsible for checking
  the latest job, and whether automated job-failure notification is implemented
  or explicitly deferred to C1;
- observe at least one successful schedule-produced recovery point;
- run the maintenance transaction's no-outage `preflight` and require the
  complete PR #66 release/runtime-profile/environment/materialization tuple.
  A pre-profile live release keeps scheduled crash-consistent protection but
  blocks the qualifying outage until a separately approved normal release;
  this sprint does not backfill or add a compatibility reader for that record;
- during a maintenance window, use the durable
  `backup-authority-maintenance.sh` transaction under `systemd-run` to settle
  the Authority operation lock, stop both Compose services, flush filesystem
  writes, await a unique external acknowledgement after the backup coordinator
  starts the exact root-volume backup with only `backup:StartBackupJob`,
  job/recovery-point read permission, and `iam:PassRole` to the exact
  `BackupServiceRoleArn` conditioned to
  `iam:PassedToService=backup.amazonaws.com`. The qualifying on-demand job
  explicitly sets founder-approved `Lifecycle.DeleteAfterDays` equal to the
  scheduled plan's retention and verifies the recovery-point expiry before its
  acknowledgement, then automatically restart/prove the accepted image tuple
  and matching public descriptor. Never stop or restart Compose manually for
  this qualifying point. Recurring running-volume recovery points retain only
  the crash-consistent claim;
- launch a clean helper OS in the restore volume's Availability Zone, with no
  public IP, Authority host role, Cloudflare configuration, or provider
  credentials. Before attachment, record a founder-private reviewed-IaC
  isolation receipt covering the helper-only role, helper security group, subnet
  routes, endpoint security groups, and endpoint policies. It must prove no
  ingress; only HTTPS to approved endpoints; no NAT, internet-gateway,
  transit-gateway, or peering route; SSM and `ssmmessages` endpoints restricted
  to that helper group; any S3 endpoint policy limited to the verifier bundle;
  and no role permission, route, or endpoint-policy path to Secrets Manager,
  ECR, Cloudflare, the tunnel, or providers;
- satisfy the helper-management prerequisite discovered read-only on
  2026-08-25: the current VPC has no Systems Manager interface endpoints, NAT
  gateway, or Default Host Management Configuration. Before the drill, review
  and create a temporary private management path for the helper, such as a
  helper-only role plus `ssm` and `ssmmessages` interface endpoints. If a
  checksum-pinned verifier bundle is delivered from S3 before attachment, use
  an encrypted private bucket and a temporary S3 gateway endpoint. Remove the
  temporary path after the helper is destroyed. A public IP, Authority host
  role, or general internet egress is not an acceptable shortcut;
- start the restore with the exact restore role, request its EBS volume in the
  helper's Availability Zone, and before attachment validate the restored
  volume itself, not the helper root: qualifying recovery-point identity,
  helper-AZ match, `Encrypted=true`, present `KmsKeyId`, same approved
  Authority-account enabled KMS boundary through `describe-key`, `available`
  state, and zero attachments;
- attach only that validated restore as a non-root secondary device. Never boot
  the restored root filesystem;
- discover the source partition and filesystem, then use a filesystem-specific
  read-only, no-journal-replay mount. If safe no-replay semantics cannot be
  demonstrated, stop this drill;
- inspect `/srv/echo-authority-clean-v1/clean-data`, including `state/`,
  `private/`, and `release/`. For `private/`, record aggregate file-type
  classes, owner/mode, and counts only, never values, bytes, content hashes,
  entry names, or paths;
- run the pre-staged offline verifier; and
- unmount, detach, wait for that exact restored volume to become `available`
  with zero attachments, re-confirm its identity, delete only that restored
  drill volume, terminate the helper, and record sanitized cleanup booleans.

The restored root snapshot is production-sensitive host state and remains in
the same trust boundary; do not share it with a lower-trust account or helper.
Even a structurally coherent restored copy can be stale. Integrity and lineage
checks cannot establish freshness because V1 has no independently retained
monotonic witness. The copy remains offline and is not permission to serve. No
OIDC, Slack, Granola, LLM, Layer 1–3 serving smoke, reconciliation, exact-image
availability, or terminal-green result is inferred from this smaller proof.

Tracked evidence contains only source commit, sanitized timestamps, configured
schedule cadence, age of the restored recovery point at drill start, elapsed
restore/inspection times, and boolean/count results. It contains no private
entry names or paths. Account, volume, snapshot, host, KMS, and private file
identifiers remain in the founder-private operator receipt. Observations are not
guaranteed RPO or RTO.

Acceptance:

- pinned `cfn-lint`, checked-in Guard-policy, and account-scoped
  `validate-template` checks pass; a named change set is created but not
  executed until its full resource/IAM/parameter list and stack termination
  protection are reviewed and the cadence is approved;
- the private source-volume/KMS evidence gate is complete and the AWS Backup
  schedule has produced at least one recovery point whose source-encryption
  facts were checked against it; cadence, retention, ownership, job-check
  procedure, and failure-alert status are explicit;
- the qualifying recovery point was taken through the durable quiesce
  transaction, with exact backup-role/service-bound caller permission, explicit
  scheduled-retention-matching `DeleteAfterDays` and verified expiry, private
  backup-job/recovery-point evidence, and automatic
  accepted-tuple/public-descriptor restart proof;
- a clean helper's reviewed-IaC isolation receipt proves the constrained
  role/security-group/routes/endpoints boundary; its pre-attachment staged Node,
  dependency, workspace-output checksum set and offline smoke test passed;
- the restored volume, not the helper root, was validated for qualifying-point
  identity, Availability-Zone match, encryption, approved same-account KMS,
  availability, and zero attachments before it attached as a non-root secondary
  device for no-journal-replay read-only inspection;
- the offline verifier reports valid release/state inventory, SQLite integrity,
  state lineage, and retrieval-generation structure without reading private
  contents;
- no restored operating system boots, provider call occurs, image is pulled,
  or second serving Authority starts;
- the helper was unmounted and detached, the exact restored drill volume was
  availability-confirmed and deleted, and helper termination is recorded only
  as sanitized booleans;
- the evidence distinguishes source-tested documentation from the external AWS
  result; and
- the change says `Refs #20`, not `Closes #20`.

This establishes a current-host recovery floor for GAP-01. GAP-01 closes only
after the later C5 host rebuild, same-lineage restore, exact-release checks,
reconciliation, and terminal-green proof.

## Phase 3 — Provisioning decisions and next-sprint handoff

Record decisions only; do not implement host or data-volume changes.

### DEC-A accepted: operator and account boundary

The decision is recorded in:

- `ADR-0008`;
- decisions index;
- `component_ids: [CMP-OPERATIONS-RELEASE]` and the component's `decision_ids`
  backlink; and
- an exact `updates` relation to ADR-0001.

[ADR-0008](../decisions/ADR-0008-echo-hosted-authority-by-default.md)
selects one ECHO-hosted, single-organization Authority in ECHO's AWS account as
the default. An organization may request its own account before provisioning.
That explicit opt-in model preserves organization account custody for that
Authority; the default model gives ECHO operational custody and updates
ADR-0001's contrary custody claims. A post-onboarding request is a separately
reviewed account and data migration, not an in-place configuration change.
This decision does not implement either provisioning path.

### DEC-B accepted: retained data-volume boundary

The decision is recorded in:

- `ADR-0009`;
- decisions index; and
- `component_ids: [CMP-OPERATIONS-RELEASE]` and the component's `decision_ids`
  backlink.

[ADR-0009](../decisions/ADR-0009-retained-authority-data-volume-boundary.md)
accepts a dedicated volume mounted at
`/srv/echo-authority-clean-v1/clean-data`, not over the whole deployment
directory. Code, Compose files, Caddy files, and release tooling remain
replaceable host material. The decision pins the deployment root and numeric
`echo-authority` UID/GID; requires the later implementation to mount the data
volume before Docker/Compose; and requires that startup implementation to
refuse a missing, symlinked, unmounted, or wrongly owned target. It must
preserve the `private/`, `state/`, and `release/` ownership and modes.

The later migration procedure must settle the Authority operation lock, stop the
Authority, copy state with metadata verification to a detached volume, validate
it offline, retain the source rollback point, mount and revalidate the target,
and only then cut over. The future stack must retain the data volume on
deletion.

Acceptance:

- accepted decisions with concrete values explicitly relate to ADR-0001. A
  rejected candidate must be replaced by an accepted alternative before sprint
  exit;
- the deployment-directory and `clean-data` boundaries are unambiguous;
- no decision claims an unimplemented migration or module;
- the later C1–C5 work has no unresolved ownership, mount-path, or UID/GID
  choice; and
- `npm run check:docs` passes.

## Code ownership and merge sequence

| Sequence | Code/document group                                                       | Conflict rule                                                                     |
| -------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 0        | Issue #53 and PR #67                                                      | Reconcile tracker; correct or abandon PR #67 before CI work                       |
| 1a       | Local loop command, package aliases, docs, focused safety/lifecycle tests | May proceed without editing CI after the tracker gate                             |
| 1b       | CI adopts the harness; #31 workflow/Dockerfile graph and experiments      | One owner after PR #67 merge/rebase; preserve stable aggregate check              |
| 2        | RB-OPERATIONS-002, offline verifier, external drill, qualification        | May run in parallel; never record secrets, private content, or infrastructure IDs |
| 3        | ADR-0008/0009, indexes, and component backlinks                           | Accepted decisions only; no provisioning implementation                           |
| 4        | Full check and spec/code review                                           | Review exact final commit after all groups converge                               |

## Sprint exit

The sprint is complete only when:

- GAP-05 is closed through one safe local loop;
- issue #31 is closed with before/after evidence and a stable aggregate gate;
- the current Authority has an encrypted scheduled root-volume snapshot and
  one isolated, non-root, no-replay, read-only structural restore proof;
- issue #20 remains open with the residual recovery and reconciliation work
  stated;
- DEC-A and DEC-B have accepted concrete choices; and
- no active unmerged PR or dirty worktree changes a path in the final commit,
  except the sprint PR itself. Open issue relationships are reconciled in the
  sprint PR description.

The sprint does not claim a non-production environment, replaceable host,
complete organization recovery, automated image promotion, beta readiness, or
client-live readiness.

## Explicit non-goals

- repeat of the already completed observability rehearsal without a material
  observability change;
- foundation or per-organization infrastructure as code;
- data-volume migration or host rebuild;
- staging creation, onboarding, destruction, or recovery;
- ECR publication, GitHub OIDC, SSM promotion, or closure of issue #28;
- Bash-to-Node controller migration;
- Litestream, WAL, or persistence-contract changes;
- replacing `asm-exec` or resolving secrets through plaintext CLI output;
- automatic Person-client updates or installer/notarization changes;
- Kubernetes, ECS, managed databases, HA, or multi-region work; and
- any Layer 1–4, permission, record, policy, or provider-workflow change.

## Following programme

After this sprint, the provisioning programme remains:

1. foundation and tag-selected backup plan;
2. fixed-ID host configuration;
3. per-organization infrastructure module;
4. staging as the first module instantiation; and
5. staging destruction, rebuild, same-lineage restore, reconciliation, and
   terminal-green proof.

That later final proof, not the read-only recovery floor in this sprint, closes
GAP-01, GAP-02, and GAP-03.
