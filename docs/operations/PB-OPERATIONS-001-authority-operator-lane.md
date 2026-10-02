---
schema_version: 1
id: PB-OPERATIONS-001
kind: playbook
title: Select the Authority operator lane
component_ids:
  - CMP-OPERATIONS-RELEASE
created_at: 2026-09-02
reviewed_at: 2026-09-27
reviewed_ref: 83c8eb63aed78ba760678294ecf7fef863743e06
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

## Coordinated server and client release

For a release that changes both the Authority and its Person clients, use the
[coordinated server and client release guide](../../deploy/release/README.md#coordinated-server-and-client-release).
It coordinates the existing server and feed CLIs; it is not a new orchestrator
or a new authorization format.

Evaluate server-client compatibility before `stage`. Staging changes the current
live host, so compatibility is a pre-stage condition, not a check deferred until
`promote`. Stage and test the exact server candidate and both matching CLI kits,
then review their evidence. A release that ships ADR-0024 has no compatible
transition; follow its
[release note](../../deploy/release/README.md#prepare-the-transition-before-staging)
for the update window, the desktop reinstalls and the added list and open
checks. After the existing private Slack-card approval and
candidate-client checks, a human makes the final decision on the exact release.
Only then may the operator promote the server and publish the signed feed using
their existing, separate commands. A staged candidate never implies permission
to publish it.

One final human review may approve the exact release and Person-client hashes
together with the prepared manifest hash, channel, both targets, and the
expected predecessor feed hash when there is one. Record those approvals using
the existing release authorization and exact digest approvals required by the
server and feed CLIs. The review does not replace the separate private
Slack-card approval, create either authorization automatically, or turn general
workflow approval into consent for a different candidate, manifest or feed
predecessor.

Report completion only after all applicable evidence is present:

| Result | Meaning |
| --- | --- |
| Stage-only | The server candidate was staged or tested, but neither server promotion nor feed publication is complete. |
| Promoted-only | The server was promoted, but the matching signed CLI feed has not been published and verified. |
| Published-not-verified | The signed feed was published, but one or both representative native seats have not completed the required A-to-B activation, authenticated read and cited Ask proof. |
| Released | The server was promoted, a fresh server `status` confirms the accepted release, and the signed feed containing both Linux x64/glibc and macOS arm64 CLI kits was published. A representative macOS arm64 seat and a representative Linux x64/glibc seat must each activate from A to B and produce authenticated read plus cited Ask evidence using B. This proves those representative client paths, not fleet-wide activation. If the desktop distribution is affected, record its separate distribution and verification evidence too. |

Keep incomplete results explicit and resume through the receipt/status path that
owns the unfinished operation. Do not call a Git head, a running server, or a
prepared manifest the client "latest"; the client-visible release is the exact
entry in its signed feed.

## Choose the lane

| Goal | Supported path |
| --- | --- |
| Compile or test locally | `npm run authority:local`. For the simulated staging journey, run `npm run test:staging-journey`, fix failures and run `npm run check` before review. Local tests are not live delivery proof. |
| Rehearse disposable local connectors | Start with `npm run authority:connector-rehearsal -- prepare --directory <new-absolute-path>`, then `preflight`. The [local connector preparation](../../services/organization-authority/README.md#disposable-local-connector-preparation) sequence owns isolated build, bootstrap, loopback serve, human login/consent, stopped credential install/finalize, authenticated capture, and one manual cycle. Preparation/preflight only prepare and inspect configuration; the lane is local rehearsal, never provider or production qualification. |
| Inspect staging | `authority:staging status` for the slot; the release CLI's fresh `status` action for a current-host release; human host-wrapper `status` during initial onboarding. |
| Update the current accepted host | Follow the [automated release lane](../../deploy/release/README.md#automated-current-host-staging-lane): install reviewed tooling, stage, canary, human Slack approval, operator client checks, human final decision, promote. For a matching client release, also follow [coordinated server and client release](../../deploy/release/README.md#coordinated-server-and-client-release). Execute reviewed merged tooling from a clean checkout. `stage` accepts only the current persisted baseline and never migrates older state. |
| Move staging from an older baseline to a V10 release | V10 is fresh-state only; no migration reaches it ([release guide](../../deploy/release/README.md)). With no live users, the human host operator runs the [authorized reset](../../deploy/organization-authority/README.md#replace-unreleased-rehearsal-state) `./onboard-clean-v1.sh replace-rehearsal --confirm-no-live-users`, then prepares the organization again with the V10 release record and matching runtime profile. To keep provider credentials, use the provider-reuse row below instead; a host prepared before Slack moved to Nango follows the next row. Continue with onboarding and the canary gates. |
| Move a host prepared before Slack moved to Nango | Follow the [ordered reset](../../deploy/organization-authority/README.md#replace-unreleased-rehearsal-state): first install the target release's reviewed host tooling through the automated release lane while the old rehearsal is still present, then the human `replace-rehearsal --confirm-no-live-users` without provider reuse, then transfer the full eight-file input, which prepares the host. The transfer runs the installed wrapper, and the lane refuses to install after the reset. |
| First onboarding | Follow [resumable onboarding](../../deploy/organization-authority/README.md#resumable-initial-owner-onboarding) and the actor table below. Host-local onboarding remains in the human Session Manager lane. |
| Transfer initial inputs | Onboarding-transfer `preflight`, `plan`, review the named change set, then `execute`. Run `cleanup` only when execute retains the receipt and reports `cleanup_required`. |
| Reset unreleased staging while reusing provider credentials | Follow [provider reuse](../../deploy/organization-authority/README.md#reuse-provider-credentials-for-a-fresh-staging-rehearsal): transfer the new nonsecret inputs, then human `replace-rehearsal --reuse-provider-inputs` and `prepare-rehearsal`. The transfer alone does not reset or prepare the host. |
| Export the initial-owner invitation | Onboarding-transfer [`export-plan` / `export-execute`](../../deploy/organization-authority/README.md#private-invitation-export-to-the-initial-owner-mac). Review the exact target, accepted release and recipient; obtain private-handoff approval if that scope is not already authorized. |
| Create or repair the retained boundary | `authority:staging slot-init`: plan, human change-set review, execute the unchanged operation. |
| Create the first host | Reviewed `up --initialize-blank-data-volume` on a never-prepared volume only. |
| Replace the host, retaining data | Reviewed `down`, then a new operation ID for reviewed `up --require-authority`; keep the flag on plan and execute. |
| Host or publish the signed CLI update feed | Follow the [CLI update staging feed](../../deploy/client-updates/README.md) from a clean committed checkout. `client-update:staging` plans a CloudFormation change set for the dedicated S3 feed stack; the human reviews that exact change set before `execute`. `client-update:sign` signs locally once the exact manifest digest is approved. `client-update:publish` writes release objects to the feed bucket with that approved digest; resume an unconfirmed receipt only through `status` or `replace-status`. Separate from the Authority slot and onboarding transfer. |

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
| Missing/expired login, MFA, provider secret entry, account switching/logout, and Slack `person tools setup`/`connect --tool slack` (the desktop app's Connected tools page shows status only for now) | Human. The operator prepares the exact next action and resumes after completion. |
| Initial host `resume`, `status`, and release-canary `./update-clean-v1.sh canary` | Human in Session Manager. The remote release CLI does not support host onboarding. Group consecutive host commands only when no intervening human action is needed. |
| Organization Slack setup token | Human generates a setup token from Slack's "Your App Configuration Tokens" page and pastes it at the hidden prompt of `person tools setup --tool slack`, or pipes it in (for example `pbpaste \| "$HOME/Library/Application Support/ECHO/cli/bin/echo-brain" person tools setup --tool slack`); neither echoes the token. To resume an unfinished install, or reconnect after Slack was uninstalled, after Nango lost the connection, or after an install landed in another workspace, without a new setup token, add `--reconnect`. |
| Unreleased rehearsal replacement and `prepare-rehearsal` using retained provider inputs | Human in Session Manager after the nonsecret transfer completes. Credentials stay on the host; use the exact operation ID from its receipt. |
| Private Slack-card approval | Human, for each card. |
| Infrastructure change set or private handoff not yet approved for its exact scope | Human reviews the prepared result once. |
| Final decision on the exact candidate release and, when applicable, its exact signed-feed inputs | Human, after successful candidate-client checks. The existing private Slack-card approval remains separate. |

For browser onboarding, the local operator privately transfers the invitation
and accepted record through the reviewed export CLI, verifies the matching
command-line kit, runs `"<release-matched-kit>/Start-ECHO.sh" --install-only`,
then runs
`"$HOME/Library/Application Support/ECHO/cli/bin/echo-brain" person login --invitation <transferred-absolute-path> --open-browser`.
Keep invitation mode `0600`; never print or paste its grant. The human completes
browser login, any required logout, and Slack setup and connect: an owner runs
`person tools setup --tool slack`, then everyone runs
`person tools connect --tool slack` (or, without a browser,
`person tools connect --tool slack --method dm-code --slack-user U…`). Export
does not advance onboarding.
A host wrapper installed before the Swift app was retired still prints
`Start ECHO.command` and the `ECHO/bin` command path; neither exists any more,
so use the command-line kit steps here.

For the ordinary release-canary path, after initial approval the local operator
on the designated owner Mac verifies the kit-installed client against the
accepted release and runs:

```sh
"$HOME/Library/Application Support/ECHO/cli/bin/echo-brain" person records --limit 20
"$HOME/Library/Application Support/ECHO/cli/bin/echo-brain" person records --query "SYNTHETIC STAGING CANARY"
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
`promote`. For a coordinated release, retain the exact prepared manifest,
channel, both targets and predecessor binding in the existing feed approval
records as well. Never create it merely because the PR was approved or the
founder authorized automation. Nor create either approval because the candidate
was staged. If checks fail, run a fresh release `status` action and roll back
the exact candidate.

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

For a coordinated release, retain the post-promotion fresh server status and
the confirmed signed-feed publication receipt for both supported CLI targets.
Retain separately for representative macOS arm64 and Linux x64/glibc seats the
A-to-B activation, authenticated read and cited Ask evidence using B. The feed
receipt alone does not show that either installed client activated the release,
and the two-seat proof does not claim fleet-wide activation. Desktop packaging
and distribution remain a separate lane; include its evidence when the release
affects the desktop app.

## Exceptions and recovery

Use the [release guide](../../deploy/release/README.md#automated-current-host-staging-lane)
for `inspect-install` and its hash inventory. [Environment drift](../../deploy/release/README.md#environment-drift-before-staging)
blocks staging: stop and leave the investigation to the human host operator.
Never edit environment files by hand; preserving observability takes precedence
over making a status check pass. Before installing the current release tooling,
run a distinct `inspect-install` plan with the same inputs and
`--previous-tooling-source`. Its `ready` result confirms that
`clean-data/release/environment-repair.pending.json` is absent. Any other
inspection refusal follows its existing diagnostic and recovery rules. A present
or unsafe repair marker requires the human host operator's repair lane. Finish
or poll every unfinished
release receipt with the commit that planned it before switching tooling.

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
