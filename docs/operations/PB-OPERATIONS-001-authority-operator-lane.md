---
schema_version: 1
id: PB-OPERATIONS-001
kind: playbook
title: Select the Authority operator lane
component_ids:
  - CMP-OPERATIONS-RELEASE
created_at: 2026-09-02
reviewed_at: 2026-09-02
reviewed_ref: 70c7040d455f969bd570d4ca08e39e5c28c8a328
tested_at: null
---

# PB-OPERATIONS-001: Select the Authority operator lane

Use this shared router to choose the supported command and who acts next.
The linked READMEs own exact syntax and recovery details; installed CLIs enforce
target, release, lock and retry guards. `AGENTS.md` owns access and secret rules.

## Default: continue within the authorized scope

For an accepted staging host, use the reviewed `authority:staging-release`
lane. Reuse the host, accepted artifacts and completed setup; an ordinary update
does not need infrastructure replacement or initial onboarding.

Plan and execute are machine steps, not repeated human approval prompts.
Keep the user's existing authorization for its target, release, recipient and
operation. Prepare a concrete plan before any required review; once that exact
plan or private handoff is approved, continue without asking again. Broad
staging delegation does not replace infrastructure change-set review or the
final decision on a candidate release.

Reuse valid sessions and completed setup evidence. Ask for login only when
authentication is missing or expired. Recheck evidence when its target, release,
record head, search generation or relevant configuration changes. A completed
Slack setup, SNS confirmation or Explorer access grant is not a new handoff on
every round. Fresh runtime and journey evidence is still required for each run.

## Choose the lane

| Goal | Supported path |
| --- | --- |
| Compile or test locally | `npm run authority:local`. For the simulated staging journey, run `npm run test:staging-journey`, fix failures and run `npm run check` before review. Local tests are not live delivery proof. |
| Inspect staging | `authority:staging status` for the slot; the release CLI's fresh `status` action for a current-host release; human host-wrapper `status` during initial onboarding. |
| Update the current accepted host | Follow the [automated release lane](../../deploy/release/README.md#automated-current-host-staging-lane): install reviewed tooling, stage, canary, human Slack approval, operator client checks, human final decision, promote. Execute reviewed merged tooling from a clean checkout. |
| First onboarding | Follow [resumable onboarding](../../deploy/organization-authority/README.md#resumable-initial-owner-onboarding) and the actor table below. Host-local onboarding remains in the human Session Manager lane. |
| Transfer initial inputs | Onboarding-transfer `preflight`, `plan`, review the named change set, then `execute`. Run `cleanup` only when execute retains the receipt and reports `cleanup_required`. |
| Export the initial-owner invitation | Onboarding-transfer [`export-plan` / `export-execute`](../../deploy/organization-authority/README.md#private-invitation-export-to-the-initial-owner-mac). Review the exact target, accepted release and recipient; obtain private-handoff approval if that scope is not already authorized. |
| Create or repair the retained boundary | `authority:staging slot-init`: plan, human change-set review, execute the unchanged operation. |
| Create the first host | Reviewed `up --initialize-blank-data-volume` on a never-prepared volume only. |
| Replace the host, retaining data | Reviewed `down`, then a new operation ID for reviewed `up --require-authority`; keep the flag on plan and execute. |

Before a slot change, preserve `edge_checked`, `host_ready` and
`authority_accepted` from its status receipt. Use this routing:

| Status | Next action |
| --- | --- |
| `ready` | Continue on the current host; no lifecycle change. |
| `absent` / `incomplete` | Plan `slot-init` for review. |
| `planned` | Resume that operation; do not start competing work. |
| `failed_create` / `unprotected` / `update_rolled_back` | Follow the receipt's `recovery_action` in the [staging specification](../product/2026-08-26-disposable-authority-staging-sprint-v1.md). |
| `host_down` | Choose first-host or retained-volume `up` from the table above. |
| `authority_unpinned` / `authority_pin_mismatch` | Correct the private pin from independently trusted accepted bootstrap evidence, never the public endpoint. |
| `authority_unready` | Use initial onboarding if underway. After a failed required `up` verification, retry only the same `up --execute --require-authority` and operation ID; this is probe-only. Otherwise investigate. |

Until first-host readiness, reviewed retries use a new operation ID and retain
`--initialize-blank-data-volume`. Never use it on prepared `clean-data`.
After acceptance, the human copies the independently trusted
`authority_pin_sha256` into the private input. Retained-volume `up` resumes
the Authority before signaling readiness. Do not invoke
`restore-clean-v1-host.sh resume` manually for this normal path.

## Human decisions and operator work

A printed `ACTION:` labels a task, not an additional approval requirement.
Use the actor below; preserve the underlying identity, approval and health checks.

| Task | Actor |
| --- | --- |
| Valid-session checks, planning, receipt polling, artifact verification, kit installation, authenticated Person reads and telemetry inspection | Local operator within the authorized lane. |
| Missing/expired login, MFA, provider secret entry, account switching/logout, Slack identity-link exchange and Interactivity setup | Human. The operator prepares the exact next action and resumes after completion. |
| Initial host `resume`, `status`, and release-canary `./update-clean-v1.sh canary` | Human in Session Manager. The remote release CLI does not support host onboarding. Group consecutive host commands only when no intervening human action is needed. |
| Private Slack-card approval | Human, for each card. |
| Infrastructure change set or private handoff not yet approved for its exact scope | Human reviews the prepared result once. |
| Final decision on the exact candidate release | Human, after successful candidate-client checks. |

For browser onboarding, the local operator privately transfers the invitation
and accepted record through the reviewed export CLI, verifies the matching kit,
then runs `"<release-matched-kit>/Start ECHO.command" <transferred-absolute-path>`.
Keep invitation mode `0600`; never print or paste its grant. The human completes
browser login, any required logout, and `person slack-link`. Export does not
advance onboarding. Confirm Interactivity only when its configuration needs work.

For the ordinary release-canary path, after initial approval the local operator
on the designated owner Mac verifies the kit-installed client against the
accepted release and runs:

```sh
"$HOME/Library/Application Support/ECHO/bin/echo-brain" person records --limit 20
"$HOME/Library/Application Support/ECHO/bin/echo-brain" person records --query "SYNTHETIC STAGING CANARY"
```

Both commands must return the same release's approved canary record, with search
using the current generation. Record bounded IDs, digests and outcomes instead
of asking the founder to paste full records. A global command or matching
version string alone is not exact-client evidence. If the local operator cannot
access that Mac, provide these commands to the human once. The human host
operator then runs `./onboard-clean-v1.sh resume` and `./onboard-clean-v1.sh status`.
Older installed wrappers may label these reads `FOUNDER ACTION`; the delegation
above applies to the reads only, never the Slack approval or host commands.
For the fresh four-meeting source, use the linked rehearsal's four approvals
and owner/employee read checks instead of this single-canary query.

For an update, use the candidate's two checks in the
[release loop](../../deploy/release/README.md#ec2-authority-replacement), which
include a cited Ask. After `stage` and synthetic `canary`, stop for the founder's
private Slack-card approval. The local operator installs the verified candidate
client and runs its checks. Only after both checks pass, show their evidence
and ask the founder for the final decision on that exact candidate.
Preserve the separate release- and client-digest-bound authorization before
`promote`. Never create it merely because the PR was approved or the founder
authorized automation. If checks fail, run a fresh release `status` action
and roll back the exact candidate.

## Evidence and completion

The staging canary is synthetic and staging-only. Do not create a live Granola
note for this flow. Ordinary initial terminal green requires the release-bound
synthetic receipt. A [fresh four-meeting rehearsal](../../deploy/organization-authority/README.md#fresh-four-meeting-staging-rehearsal)
instead requires all four admitted fixture meetings to have published approvals.
Both require positive Layer 1 and Layer 2 owner reads after the approved
head/current generation, and a healthy Authority on the accepted image and
runtime profile. Fixture visibility choices and employee read/denial checks
remain separate manual rehearsal evidence; terminal green does not prove them.

Keep runtime behavior and observability intact: preserve configured telemetry,
worker liveness, journey stages, model usage, logs, alarms and dashboard access.
Correlate each canary to its release/build and retain content-free timing,
failure/retry and read evidence. Use [RB-OPERATIONS-001](RB-OPERATIONS-001-authority-observability.md)
for observability procedures. Track one-time SNS/viewer setup separately from
each run's proof; report missing evidence rather than removing a check.
The setup CLI's `runtime_observation=not_observed` and
`runtime_status=ready_to_start` describe setup output; use the host wrapper's
running/healthy/image/profile checks and live telemetry for runtime proof.

## Exceptions and recovery

Use the [release guide](../../deploy/release/README.md#automated-current-host-staging-lane)
for `inspect-install`, the fixed `legacy-staging-host-v1` migration, and their
hash inventories. Use its [environment-drift procedure](../../deploy/release/README.md#environment-drift-before-staging)
for `diagnose` and eligible accepted-only `repair`. Never edit environment files
by hand. Check whether repair would reduce intended telemetry; preserving
observability takes precedence over making a status check pass.

One operator controls the slot. Coding agents do not start interactive SSM sessions.
Agents use only the reviewed repository CLIs for bounded remote actions, never
SSH, an interactive root shell or hand-written SSM. Other host actions remain
human-only. An installed wrapper's root-owned guard, pinned control path, unknown
tooling refusal and retained recovery locks remain authoritative; use the
[host recovery procedure](../../deploy/organization-authority/README.md#recover-an-interrupted-operation-lock)
instead of removing a lock or journal to force progress.

Resume a pending remote command through its existing receipt; never send a second
command to bypass an unconfirmed result. A completed private export is not a
reusable login grant: if its invitation expires, obtain a human host refresh and
a new bounded export after the previous operation is definitively complete.
Existing approval covers an unchanged handoff scope; it does not cover a changed
target, recipient or release. Unknown drift, unconfirmed remote execution, or
destructive changes require investigation and any applicable human review.

Cloud or isolated coding tasks do not perform live operations. The Cloud
boundary in `AGENTS.md` wins. This playbook does not authorize production or
client-live release. Follow `AGENTS.md` for `echo-prod` authentication and
`aws-secrets-manager` handling; secrets never enter output, argv or chat.
