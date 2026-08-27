# Disposable Authority staging sprint V1

**Status:** first-live staging and repeated retained-state host-replacement
qualification passed on 2026-08-27, with sanitized founder-private evidence
digests indexed. This status does not claim a snapshot restore, GAP-01 or issue
#20 closure, or GAP-04 closure.
**Grounded at:** staging controller revision
`f0d2f95214246501bfcca59b156a30105fce947d`.
**Scope:** one fixed staging edge and one replaceable AWS Authority host in
ECHO's AWS account. This is deployment and operations work only. It does not
change product behavior, release-record semantics, the production Authority, or
the organization-operated option.

## Decision and outcome

This sprint creates one ECHO-hosted staging slot for rehearsing Authority
onboarding and host replacement before those actions reach a client host. It
implements the default selected by ADR-0008: ECHO hosts an Authority in its
ECHO-controlled AWS account unless an organization-operated model is selected
explicitly before provisioning. It is not evidence that the optional
organization-operated model has been provisioned or qualified.

The slot has two deliberately different lifetimes:

| Asset                                                                                                                                        | Lifetime                               | Reason                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Staging hostname, remotely managed Cloudflare Tunnel, its remote ingress configuration, and the AWS secret container for the connector token | Fixed for the life of the staging slot | The OIDC callback and externally configured provider applications need one stable HTTPS origin. Recreating the edge for each host would add DNS propagation, callback edits, and a new token to every rehearsal. |
| EC2 instance, root volume, Compose installation, and host-local deployment material                                                          | Disposable                             | A host may be destroyed and recreated without changing the hostname, tunnel, or retained organization state boundary.                                                                                            |
| Dedicated `clean-data` EBS volume                                                                                                            | Retained staging state                 | ADR-0009 makes this the organization-state boundary. It is attached only after the fixed account identity and mount guard are proved. It is not part of ordinary host teardown.                                  |

The practical result, once qualified, will be a fixed public address to which a
newly provisioned host can reconnect, not a permanent staging server. `down`
will remove the host; `up` will create a fresh host and reconnect it to the
same staging edge and retained staging data volume.

## Entry gates

Before the first live run:

1. ADR-0008 is accepted with the ECHO-hosted default and its custody,
   support, logs, backup, and incident consequences are acknowledged for this
   staging slot.
2. ADR-0009 is accepted: `clean-data` is a dedicated retained encrypted
   volume at `/srv/echo-authority-clean-v1/clean-data`, and
   `echo-authority` is created with UID `999` and primary GID `988` before any
   container can read that mount.
3. An ECHO staging hostname, Cloudflare account/zone, AWS region, instance
   type, alert destination, and throwaway provider accounts are named in a
   founder-private operator receipt. They are inputs, not discovered by the
   module.
4. The current-production recovery work in RB-OPERATIONS-002 has either
   completed with its required evidence or is explicitly recorded as
   incomplete. Incompleteness does not block a fresh staging host, but it
   blocks any production data-volume cutover.

## Why the edge is API-managed, not Wrangler-managed

Wrangler is not the V1 lifecycle controller. Its current `wrangler tunnel`
commands are experimental and may change without notice. They can create, run,
inspect, and delete a remotely managed tunnel, but remote ingress must still be
configured through the Cloudflare dashboard or API; the command surface does
not create or remove DNS records or export the connector token for installation
on a host. See [Cloudflare's Wrangler Tunnel
documentation](https://developers.cloudflare.com/workers/wrangler/commands/tunnel/).

`cloudflared` remains the pinned host connector, not the provisioner. Its
locally managed mode stores configuration and an account-management certificate
on a machine; Cloudflare reserves that mode for local development, testing, or
legacy cases and recommends remotely managed tunnels for most uses. See
[Cloudflare's management-mode documentation](https://developers.cloudflare.com/tunnel/advanced/local-management/).

Instead, one repository-owned Node command uses Node 22's built-in `fetch`
against Cloudflare's documented v4 API to create and verify the fixed
edge. Avoiding Wrangler and a second Cloudflare client dependency keeps this
bounded controller small; its request and response shapes are pinned by
focused tests:

1. create a named remotely managed tunnel;
2. put a remote ingress configuration for exactly the staging hostname,
   loopback Caddy origin, and a final deny/404 rule;
3. create and verify the proxied CNAME to the tunnel subdomain; and
4. obtain the connector token and deposit it directly into the pre-created AWS
   secret container without printing it, returning it, or placing it in a
   release record, plan, or state file.

The controller derives the tunnel name as `echo-authority-${slotId}`; the slot
ID is limited to 48 characters and operators cannot supply an arbitrary tunnel
name. Within this one-slot, ECHO-controlled, single-operator V1, that reserved
name is the provider-level retry identity. A later command may finish the exact
named tunnel only when its remote
configuration is provably empty. It accepts the exact intended ingress and
refuses every other configuration, duplicate name, or conflicting DNS record.
This naming convention is not a cryptographic ownership proof and must not be
reused as the multi-operator or customer-account design. Manual creation or
mutation inside the reserved namespace is unsupported.

Cloudflare documents the API lifecycle for remotely managed tunnels, ingress,
and DNS records at [Create a tunnel by API](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/)
and documents the same tunnel, configuration, and token methods in its
[API reference](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/).

One dashboard action remains unavoidable: bootstrap the first least-privilege
Cloudflare API token. Cloudflare documents that an initial token must be
created in the dashboard, and that its secret is shown once. After that
bootstrap, recurring `slot-init`, `up`, and `down` operations do not require
Cloudflare dashboard work. See
[Cloudflare API-token bootstrap](https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/).

## Lifecycle design and qualification boundary

The code-complete implementation defines four operator commands with explicit,
machine-readable receipts. A command existing in the repository is not itself
live evidence; the live phases below say what must be observed before we call a
stage qualified.

Before the first `slot-init --execute`, create the restricted Cloudflare
management token once and store it once in the chosen secret container. A
plan-only `slot-init` does not resolve or require that credential. The operator
machine needs `asm-exec` and an IAM Identity Center session from
`aws sso login --profile echo-prod`; do not use `aws login` or the AWS account
root user. The controller pins its AWS and `asm-exec` subprocesses to that
profile and strips ambient static credential overrides, so only the dynamic
secret reference enters it. The provider applications, SNS
subscription confirmation, founder browser login, and first onboarding canary
remain first-live human steps; none is implied by slot materialization.

| Command     | Authority                                                                    | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slot-init` | Reviewed Cloudflare and AWS authority after the one-time API-token bootstrap | Creates the persistent AWS slot with the host disabled, creates or verifies the reserved tunnel, ingress and CNAME, and writes the connector token directly into the stack-created empty secret container. Exact retry converges after an interrupted tunnel create or configuration write; duplicate names, configured ingress drift, and conflicting DNS fail closed.                                                                                                                                       |
| `up`        | ECHO AWS deployment authority only; no Cloudflare dashboard action           | Materializes the retained slot on a disposable host: uploads and pins the immutable machine-setup bundle, installs the fixed-ID machine configuration, verifies the retained `clean-data` mount, and connects `cloudflared` using the existing connector token resolved only at runtime. It establishes **machine-and-connector readiness** only. It does not deploy observability, resume onboarding, start an accepted release, or prove public HTTPS or the Authority descriptor.                          |
| `down`      | ECHO AWS deployment authority only; no Cloudflare dashboard action           | Quiesces the application, verifies the exact data mount is unmounted, then updates the persistent slot stack with the host disabled. It removes only EC2, its attachment, and root material, leaving the persistent tunnel, hostname, secret container, retained data volume, and evidence required to recreate the host. If CloudFormation rolls the update back, it re-reads the stack and attempts recovery only against the current proved host; otherwise it emits a distinct recovery-required failure. |
| `status`    | Read-only AWS and Cloudflare authority                                       | Reports absent, planned, failed-create, unprotected, update-rolled-back, incomplete, or ready state. It describes AWS before resolving the Cloudflare reference, so AWS-only recovery states neither require nor call Cloudflare and name the exact lifecycle recovery action. A healthy stack then resolves the token and checks the exact tunnel, ingress, and DNS record without changing them.                                                                                                            |

`down` may also update the retained launch-template version and narrowly scoped
host-role policy as it clears the pinned setup-artifact parameters. It removes
only the four conditional host resources: the EC2 instance, data-volume
attachment, WaitCondition handle, and WaitCondition.

Initial stack creation uses CloudFormation's `DO_NOTHING` failure policy. A
failed create therefore remains an owned `CREATE_FAILED` stack instead of
rolling retained resources out of the stack and making a later create ambiguous.
`status` reports `failed_create`; it reports `unprotected` if resource creation
succeeded but termination protection did not. In either case, the operator must
not delete the stack or choose a new name. After inspecting sanitized stack
events and correcting the cause, use a new operation ID to plan and execute
`slot-init` against the same stack. The controller uses an `UPDATE` recovery
change set for `CREATE_FAILED`, and every successful `slot-init`, including a
no-change retry, enables and re-reads termination protection before touching the
Cloudflare edge. CloudFormation documents `DO_NOTHING` as preserving successful
resources after a creation failure in its [change-set failure
options](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/stack-failure-options.html).

After a failed update reaches `UPDATE_ROLLBACK_COMPLETE`, `status` reports
`update_rolled_back` and directs the operator to a newly planned `up` or `down`
retry based on the retained host state. `slot-init` cannot clear or hide that
condition. Rollback-in-progress and rollback-failed states remain mutation
blocked until CloudFormation reaches a terminal, usable state.

`up` by itself has no application-readiness or timing claim. The qualified
ten-minute lifecycle target applies only after the first-live phase has prepared
the retained staging volume, reached terminal green, and recorded the accepted
digest-pinned release tuple. The later rehearsal explicitly resumes that
accepted release after host materialization; it is not a fresh onboarding
measurement. The measured result under that boundary is recorded below.

Machine-and-connector readiness means all of the following:

- a fresh host is running with zero security-group ingress and its Compose
  profile bound only to loopback;
- `clean-data` is a real, non-symlink mount of the intended retained volume,
  owned by `999:988`, before Compose starts;
- `cloudflared` reports ready on its local `http://127.0.0.1:20241/ready`
  endpoint after connecting through the pre-existing fixed tunnel.

That local connector check proves connector connectivity only. It does not
prove public DNS, public HTTPS, Caddy, the Authority process, onboarding, or
`/v1/authority-descriptor`.

First-live application qualification is a separate phase: deploy the existing
observability stack as a sibling stack and confirm its required log groups and
role permissions; then restore and start the accepted release, complete
onboarding and canary, and verify that an HTTPS request to
`/v1/authority-descriptor` returns `200` and equals the local descriptor. The
target deliberately excludes one-time edge bootstrap, provider-account
creation, founder browser login, and a first organization canary. Those are
human-floor onboarding actions, not machine-and-connector readiness. Once an initial
staging organization is terminal green, the repeated `down` then `up` phase can
measure descriptor readiness using the retained staging state.

## Phases

### Phase 1: fixed-edge control plane

Build and test the Node edge command. It accepts only the stable slot ID,
hostname, Cloudflare account/zone identifiers, and references to credentials
in the controlled operator environment. The tunnel name is derived from the
slot ID. The command records only non-secret tunnel and DNS identity facts in
its receipt. It must make repeated `slot-init` safe and refuse an unexpected
CNAME target or remote ingress.

Controlled slot retirement, including an `edge-destroy` operation, is deferred
from this sprint. It remains important and must be reviewed before it exists:
it must remove and verify the exact DNS record before deleting the tunnel and
connector-token value, and it may remove the secret container only if the
approved retention policy permits it. DNS and tunnel lifetimes are independent;
leaving DNS behind after deletion would create a broken public route. See
[Cloudflare Tunnel routing](https://developers.cloudflare.com/tunnel/routing/).

### Phase 2: disposable-host module and machine contract

Create one persistent staging-slot stack in the existing
CloudFormation/change-set style. A `HostEnabled` parameter changes only the
disposable-host resources; it does not delete and later attempt to re-adopt the
retained volume or secret:

- disposable ARM64 EC2 instance and root volume;
- zero-ingress security group, loopback-only Compose profile, and an instance
  role scoped to this slot's connector-token secret only;
- one retained encrypted `clean-data` volume tagged with the staging slug so a
  later tag-selected foundation backup plan can enroll it without changing the
  host module;
- a private, encrypted, versioned setup-bundle bucket and exact object-version
  and SHA-256 verification before machine setup;
- fixed UID/GID account creation, directory modes, pinned `cloudflared`,
  registry helper, and the existing `asm-exec` runtime resolution path; and
- an explicit output for the host role needed by the existing observability
  template, without copying or rewriting that template.

Before Docker starts, the machine configuration must fail closed unless the
expected volume is mounted at the exact path, is not a symlink, and has the
required ownership and modes. Static tests assert the host/network/mount/role
boundary; a reviewed change set remains mandatory for a live staging apply.
The unmodified observability template is a required sibling stack before an
Authority application is started with the `awslogs` profile. Wiring that sibling
deployment into a single lifecycle command is deferred; its absence must not be
mistaken for optional observability.

### Phase 3: first live onboarding and application qualification

Create the persistent slot and host through reviewed AWS change sets, deploy
the unmodified observability sibling stack, and instantiate once with throwaway
provider accounts. Transfer the private eight-file onboarding input through the
dedicated versioned KMS-encrypted staging transfer bucket, never a terminal or
SSH session. The host role receives `s3:GetObjectVersion` for one exact object
version and its matching KMS decrypt context only while a reviewed,
IAM-policy-only change set is active, with a 15-minute IAM expiry backstop. A
bounded SSM command verifies the
archive SHA-256, rejects every archive member except the eight exact regular
files, suppresses onboarding output, and invokes the existing `doctor` then
`prepare`. It must revoke the temporary policy and permanently delete and prove
absent every version, delete marker, and multipart upload for the exact S3 key
before local archive and receipt cleanup. Complete
the existing `resume` flow, founder login, and canary afterward. This is the
first point at which terminal green and the public descriptor can be claimed
for staging.

### Phase 4: repeated host-replacement and timing qualification

Run `down` and `up` against the same retained staging data volume without
editing Cloudflare, DNS, callback URLs, or provider configuration. Each `down`
must quiesce and unmount before CloudFormation removes the attachment. This
operation attempts a proved host remount and existing-container restart if the
CloudFormation update fails after quiescence; an unproved recovery blocks the
rehearsal and requires operator inspection before another lifecycle command.
This phase is allowed only for the prepared retained volume from Phase 3, with its
accepted digest-pinned release already recorded. After each `up` materializes
the host, first prove that the setup bundle manifest's `source_commit` equals
the accepted release record's `source-sha`, then deliberately resume that
accepted release. Record sanitized elapsed time and compare the public and local
descriptors only then. Do not treat a
fresh blank volume or fresh onboarding as a repeated-up timing rehearsal.

Record sanitized timing and outcome receipts. The receipt identifies command
revision, release digest, elapsed ready time, mount/ownership booleans,
tunnel/descriptor booleans, and cleanup facts; it contains no API token,
connector token, secret value, AWS/Cloudflare account identifiers, or provider
credential content.

## Security boundary

The Cloudflare bootstrap API token is an operator credential. Its reference is
resolved into the edge command's environment at runtime through `asm-exec`; the
command never accepts a raw-token flag. The value is never committed, passed as
a command argument, written to Terraform state, installed on the Authority
host, or retained in the normal receipt. The token is limited to Tunnel Edit in
the selected staging account and DNS Edit in the selected staging zone.
Cloudflare cannot scope those permissions to one tunnel or hostname, so a
dedicated staging account and delegated staging zone are the preferred blast-
radius boundary. Cloudflare recommends API tokens rather than global keys and
recommends environment variables for sensitive provider values.
See [Cloudflare API authentication guidance](https://developers.cloudflare.com/fundamentals/api/how-to/make-api-calls/).

The connector token is a separate host credential: anyone holding it can run
the associated remotely managed tunnel. The host may resolve only its own
token at runtime through the existing secret-resolution boundary. It must never
appear in logs, process arguments, an environment file, release record, or
Terraform/CloudFormation parameter value. See [Cloudflare tunnel-token
guidance](https://developers.cloudflare.com/tunnel/advanced/tunnel-tokens/).

The operator identity that crosses the connector token into AWS may call only
`secretsmanager:PutSecretValue` on the exact stack-created secret, plus
metadata-only describe access if required. It cannot read or enumerate secret
values. The host role has the inverse minimum: it may resolve only that exact
connector-token secret and cannot write it. The Cloudflare management token is
never made readable by the host role.

The fixed edge does not weaken the Authority ingress model. The EC2 security
group has zero ingress, Caddy listens on loopback, and `cloudflared` initiates
outbound connections. Lean V1 may assign the host an ephemeral public IPv4
address solely to reach package registries, AWS APIs, and Cloudflare without a
NAT gateway; the security group still admits no inbound flow. There is no load
balancer, direct SSH, or public host listener. Egress is limited to the
protocols required by bootstrap, AWS control-plane access, DNS, time sync, and
Cloudflare Tunnel, then measured before a narrower endpoint design is claimed.

## Exact acceptance

The sprint has three distinct completion levels. Passing an earlier level is
not a substitute for a later live rehearsal.

## Recorded live-qualification result

Phase B passed before any host-replacement rehearsal. A reviewed change set had
created the persistent slot and enabled host. The required observability sibling
reached `CREATE_COMPLETE`; its subscription was confirmed and all four alarm
and OK actions targeted that destination. The accepted
`clean-v1-staging-20260827-004` release at source
`825707b4a5356d3e3a1baf2c75aee6484ba426d9` reached terminal green; its public
HTTPS descriptor returned `200` and exactly equaled the local descriptor; and
authenticated Layer 1 and Layer 2 checks passed.

At controller revision `f0d2f95214246501bfcca59b156a30105fce947d`, three
consecutive retained-state `down` then fresh-host `up` rehearsals passed. The
AWS-authoritative lifecycle elapsed measurements were 245.630 seconds, 272.446
seconds, and 236.185 seconds, all within the 10-minute requirement. Each clock
started at the stack-level CloudFormation `UPDATE_IN_PROGRESS` event for the
reviewed `up` and ended at SSM `ExecutionEndDateTime` for the successful
public-versus-direct-in-container descriptor probe, after source equality,
explicit resume, and terminal-green proof. Every cycle used a distinct fresh
host while retaining the same hostname, tunnel, and data volume; required no
callback or DNS edit; verified input-archive hash equality and host-bundle
`source_commit` equality with the accepted source SHA; explicitly ran
`restore-clean-v1-host.sh resume`; used the accepted image and runtime profile;
reached terminal green; and returned public `200` equal to the direct
in-container descriptor.

Each normal `down` removed only `StagingHost`,
`StagingDataVolumeAttachment`, `StagingReadyHandle`, and `StagingReady`; the
role and launch template were modified in place. Drift detection found only the
expected cross-stack `StagingHostRole` `ManagedPolicyArns/0` difference owned
by the observability sibling's `AuthorityDockerLogWritePolicy`, with no
unexpected drift. The pre-rehearsal POSIX `sh` `pipefail` failure was found
before any CloudFormation execute and corrected/tested in the stated controller
revision. One successful byte-identical pre-commit shakedown was excluded so
all three qualifying cycles postdate and map exactly to that revision.

Closure verification passed all five focused staging architecture suites (102
tests) and `npm run check` (99 test files and 862 tests).

The detailed assertion record is the [Authority staging host-replacement V1
qualification](../qualification/QUAL-20260827-174106-001-authority-staging-host-replacement-v1.md).

### A. Code-complete host-and-edge infrastructure

1. One initial API-token bootstrap is the only Cloudflare dashboard step in the
   designed recurring lifecycle. Repeated `slot-init`, `up`, and `down` use the
   REST API and AWS APIs without a dashboard action and do not expose the
   bootstrap or connector token.
2. `slot-init` code creates or verifies exactly one named remote tunnel, its
   exact remote ingress policy, and one proxied CNAME for the staging hostname.
   A repeated run is idempotent and refuses drift.
3. The AWS template and its tests define a disposable host plus a retained
   encrypted `clean-data` volume, zero-ingress network, bounded secret access,
   and an explicit host-role output for the unmodified observability template.
4. The host configuration refuses to start Compose without the intended
   non-symlink volume mount at `/srv/echo-authority-clean-v1/clean-data` and
   ownership `999:988`.
5. `npm run check` and focused architecture tests for the edge, host module,
   materialization, and lifecycle pass.

### B. First live staging onboarding and application qualification

1. A reviewed change set has created the persistent slot and an enabled host;
   the existing observability stack has been deployed as its unmodified sibling
   and its alarm destination has been confirmed.
2. Initial staging onboarding reaches terminal green through the existing
   canary, using throwaway providers.
3. The public HTTPS descriptor returns `200` and equals the local descriptor on
   the accepted digest-pinned release tuple.

### C. Repeated host-replacement and timing qualification

1. Three consecutive `down` then fresh-host `up` rehearsals, followed by the
   explicit source-commit equality check and resume of the accepted release,
   each reach the descriptor-ready condition in 10 minutes or less, retain the same
   hostname/tunnel and staging data volume, and require no callback or DNS edit.
2. After each rehearsal, `onboard-clean-v1.sh status` is terminal green and
   the public descriptor equals the local descriptor on the accepted
   digest-pinned release tuple.
3. A second apply has no unexpected drift. The normal `down` receipt proves
   that only disposable host material was removed; it did not delete the
   persistent edge, retained data volume, or unrelated resource.
4. Receipts distinguish implementation tests, machine-and-connector readiness,
   first-live application qualification, and repeated timing rehearsals.

## Non-goals and residual work

This sprint does not:

- support concurrent operators for one staging slot. V1 is deliberately
  single-operator; never run overlapping lifecycle commands from different
  terminals or machines. A durable cross-operator lock is required before a
  second operator is authorized;
- publish Authority images from CI or remove the current explicit,
  digest-pinned release-operator input (GAP-04 remains a parallel/deferred
  improvement);
- migrate the current production Authority's root-volume `clean-data` tree;
- build the shared tag-selected backup foundation or claim that staging data
  has the production recovery floor; the volume's `Org` tag is only its future
  enrollment seam;
- restore a snapshot to a new data volume, destroy a host stack, or prove a
  same-lineage serving recovery. Those are the later C5 recovery test, not an
  implication of a staging `down`/`up` cycle;
- implement controlled full-slot retirement or `edge-destroy`. That work needs
  its own reviewed DNS, tunnel, secret, and retention sequence;
- wrap, copy, or rewrite the existing observability template. It remains a
  required unmodified sibling before an Authority application is started; a
  later lifecycle convenience command may orchestrate it;
- implement organization-operated hosting, multi-region/HA, load balancing,
  ECS/Kubernetes, RDS, Litestream, or multi-tenancy;
- replace the Bash release/onboarding state machines, `asm-exec`, file-based
  provider credentials, or the established release contract; or
- automate Google OIDC client creation, Slack installation, Granola
  credential acquisition, SNS confirmation, or the founder browser login.

ADR-0009's retained-volume boundary is exercised first on staging, but its
production migration and rollback procedure remain separate. ADR-0008's
organization-operated option remains an explicit pre-provisioning choice, not
a fallback created by this ECHO-hosted staging slot.

RB-OPERATIONS-002 remains the recovery-floor procedure for the current
production root volume. Its scheduled/crash-consistent and offline structural
proof does not become a retained-volume restore proof because staging exists.
Conversely, this sprint's host replacement rehearsal does not set
RB-OPERATIONS-002 `tested_at`, close issue #20, or close GAP-01. It supplies a
safe environment in which the subsequent snapshot-restore and full
replaceable-host work can be rehearsed before any client host is changed.

In gap terms, successful exit closes GAP-02 by creating the first real
non-production Authority and materially advances GAP-03 by proving one
replaceable, versioned host. It does not close GAP-01 until a retained-volume
snapshot restore serves the same lineage, and it does not address GAP-04.
