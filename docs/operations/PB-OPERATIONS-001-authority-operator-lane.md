---
schema_version: 1
id: PB-OPERATIONS-001
kind: playbook
title: Select the Authority operator lane
component_ids:
  - CMP-OPERATIONS-RELEASE
created_at: 2026-09-02
reviewed_at: 2026-10-13
reviewed_ref: b70742c8d2e621e2eb3968fc022eadb7e861418e
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
Slack setup or SNS confirmation is not a new handoff on every round. A new
alert subscription is: re-creating an observability stack or its subscription
sends a new confirmation email, and SNS deletes the subscription if it is not
confirmed within 48 hours
([RB-OPERATIONS-001](RB-OPERATIONS-001-authority-observability.md#2-execute-and-verify-the-stack)).
Fresh runtime and journey evidence is still required for each run.

For staging resets, reuse the designated existing Slack app. Retain its app ID
in the operator handoff. When host `resume` reaches `connect_slack_in_app`, the
human reruns `sudo ./onboard-clean-v1.sh resume --existing-slack-app <app-id>` with
that ID; the [existing-app procedure](../../deploy/organization-authority/README.md#use-an-existing-slack-app-before-the-first-connection)
owns the owner-Mac command it prints, the hidden prompts and the connection
checks. A reset clears ECHO's setup state; it does not delete the app in Slack.
If setup already saved that app's credentials and consent needs resuming, use
`--reconnect` instead. Never combine the two flags. Creating a new Slack app
requires the owner's explicit `resume --create-slack-app` choice for that
invocation; do not default to bare setup after a reset. These flags select only
the printed handoff and never create an app or grant consent on the host.

## Coordinated server and client release

For a release that changes both the Authority and its Person clients, use the
[coordinated server and client release guide](../../deploy/release/README.md#coordinated-server-and-client-release).
It coordinates the existing server and feed CLIs; it is not a new orchestrator
or a new authorization format.

Evaluate server-client compatibility before `stage`. Staging changes the current
live host, so compatibility is a pre-stage condition, not a check deferred until
`promote`. Stage and test the exact server candidate and both matching CLI kits,
build both matching desktop packages (the `ECHO.app` ZIP and the `.deb`), then
review their evidence. After the canary meeting's approval and
candidate-client checks, a human makes the final decision on the exact release.
Only then may the operator promote the server and publish the signed feed using
their existing, separate commands. A staged candidate never implies permission
to publish it.

One final human review may approve the exact release and Person-client hashes
together with the prepared manifest hash, channel, all four targets, and the
expected predecessor feed hash when there is one. Record those approvals using
the existing release authorization and exact digest approvals required by the
server and feed CLIs. The review does not replace the separate canary
approval, create either authorization automatically, or turn general
workflow approval into consent for a different candidate, manifest or feed
predecessor.

Report completion only after all applicable evidence is present:

| Result | Meaning |
| --- | --- |
| Stage-only | The server candidate was staged or tested, but neither server promotion nor feed publication is complete. |
| Promoted-only | The server was promoted, but the matching signed client feed has not been published and verified. |
| Published-not-verified | The signed feed was published, but one or both representative native CLI seats have not completed the required A-to-B activation, authenticated read and cited Ask proof, or a representative desktop has not passed the [desktop update check](../../deploy/client-updates/README.md#verify-the-desktop-update). |
| Released | The server was promoted, a fresh server `status` confirms the accepted release, and the signed feed with all four targets was published. A representative macOS arm64 seat and a representative Linux x64/glibc seat must each activate from A to B and produce authenticated read plus cited Ask evidence using B. A representative macOS arm64 desktop and Ubuntu x64 desktop must each pass the [desktop update check](../../deploy/client-updates/README.md#verify-the-desktop-update). This proves those representative client paths, not fleet-wide activation. |

Keep incomplete results explicit and resume through the receipt/status path that
owns the unfinished operation. Do not call a Git head, a running server, or a
prepared manifest the client "latest"; the client-visible release is the exact
entry in its signed feed.

## Choose the lane

| Goal | Supported path |
| --- | --- |
| Compile or test locally | [`npm run authority:local`](../../README.md#local-authority-exercise), which needs a local Nango key file for `up` and `reset`. For the simulated staging journey, run `npm run test:staging-journey`, fix failures and run `npm run check` before review. Local tests are not live delivery proof. |
| Inspect staging | `authority:staging status` for the slot; the release CLI's fresh `status` action for a current-host release; human host-wrapper `status` during initial onboarding. |
| Capture full research traces in LangSmith | Use the [staging tracing selection](../../deploy/organization-authority/README.md#langsmith-staging-tracing). The human chooses the external project, region and duration (a timed window or until disabled) and enters its API key at the installed wrapper's hidden prompt. The operator verifies a normal Ask trace and the finite export status. This does not replace release or canary approval. |
| Use one member's own Claude account for staging research | After staging the reviewed supporting image/profile, the human uses the installed wrapper's [personal Claude setup](../../deploy/organization-authority/README.md#personal-claude-staging-research): native `login`, then `enable --member`, then `status`. Native Claude owns sign-in and refresh. Re-run candidate evidence after changing the selection; this does not approve the canary or release. |
| Verify a staging Jira read | After deploying the explicit staging connector profile through the existing release/onboarding lanes, use the [staging connector runner](../../services/organization-authority/README.md#staging-connector-rehearsal)'s `status` and `verify-read` from the owner Mac; it captures nothing. It uses the existing Person session for bounded, release/profile-bound observations. It neither deploys nor resets the host, enables Jira Ask, or grants provider qualification. |
| Update the current accepted host | Follow the [automated release lane](../../deploy/release/README.md#automated-current-host-staging-lane): install reviewed tooling (repeat `inspect-install`, then `install --inspection <succeeded-inspect-install-receipt>`, until every tool is `new`), stage, canary, human approval of the canary meeting (desktop or Slack), operator client checks, human final decision, promote. For a matching client release, also follow [coordinated server and client release](../../deploy/release/README.md#coordinated-server-and-client-release). Execute reviewed merged tooling from a clean checkout. `stage` accepts only the current persisted baseline and never migrates older state. |
| Move staging from an older baseline to a V15 release | Authority V15, record log V6 and control-plane V4 are fresh-state only; no migration reaches them ([release guide](../../deploy/release/README.md)). With no live users, first install the target release's reviewed host tooling through the [automated release lane](../../deploy/release/README.md#automated-current-host-staging-lane) while the old rehearsal is still present: the transfer's `doctor` and `prepare`, `resume --existing-slack-app` and `langsmith-tracing` all run the installed wrapper, and the lane refuses to install between the reset and `prepare`. Then the human host operator runs the [authorized reset](../../deploy/organization-authority/README.md#replace-unreleased-rehearsal-state) `sudo ./onboard-clean-v1.sh replace-rehearsal --confirm-no-live-users`, then prepares the organization again with the V15 release record and matching runtime profile. The reset empties the record log too, so earlier approvals do not carry over, and no organization meeting source is prepared: meetings come only from a person's own sources. To keep provider credentials, use the provider-reuse row below instead. Continue with onboarding and the canary gates. |
| First onboarding | Follow [resumable onboarding](../../deploy/organization-authority/README.md#resumable-initial-owner-onboarding) and the actor table below. Host-local onboarding remains in the human Session Manager lane. An original pre-Slack candidate staged during initial onboarding may use the documented human-only continuation after Slack setup and personal linking; ordinary `resume` remains blocked while any candidate is staged. |
| Transfer initial inputs | Onboarding-transfer `preflight`, `plan`, review the named change set, then `execute`. Run `cleanup` only when execute retains the receipt and reports `cleanup_required`. |
| Reset unreleased staging while reusing provider credentials | Follow [provider reuse](../../deploy/organization-authority/README.md#reuse-provider-credentials-for-a-fresh-staging-rehearsal): transfer the new nonsecret inputs, then human `replace-rehearsal --reuse-provider-inputs` and `prepare-rehearsal`. The transfer alone does not reset or prepare the host. |
| Export the initial-owner invitation | Onboarding-transfer [`export-plan` / `export-execute`](../../deploy/organization-authority/README.md#private-invitation-export-to-the-initial-owner-mac). Review the exact target, accepted release and recipient; obtain private-handoff approval if that scope is not already authorized. |
| Create or repair the retained boundary | `authority:staging slot-init`: plan, human change-set review, execute the unchanged operation. |
| Create the first host | Reviewed `up --initialize-blank-data-volume` on a never-prepared volume only. |
| Replace the host, retaining data | First promote or roll back any staged candidate (release CLI fresh `status`) and let any release, onboarding or backup operation finish. Retained `up` refuses a candidate or operation lock and only a running host can clear them, so `down` refuses with `host_quiesce_failed`, before stopping anything, while a candidate, an operation lock or the staging release guard is present; use the [host recovery procedure](../../deploy/organization-authority/README.md#recover-an-interrupted-operation-lock) for a lock or guard. Only `clean-data/` is retained: do not run `down` between `replace-rehearsal` and a successful `prepare` or `prepare-rehearsal`, and copy any `retired-rehearsals/` archive worth keeping off the host first. Then reviewed `down`, then a new operation ID for reviewed `up --require-authority`; keep the flag on plan and execute. Before that `up`, rebuild the host bundle from the `tooling_source` of the last succeeded release-lane `install` and update `hostSetup` ([AWS staging slot](../../README.md#aws-staging-slot)): the new root disk takes its host tools from the bundle, and nothing checks the bundle against the installed tooling or the accepted release. |
| Host or publish the signed client update feed | Follow the [client update staging feed](../../deploy/client-updates/README.md) from a clean committed checkout. Each release carries four artifacts: the macOS arm64 and Linux x64 CLI kits, the macOS `ECHO.app` ZIP and the Linux `.deb`, all built from the same release inputs. `client-update:staging` plans a CloudFormation change set for the dedicated S3 feed stack; the human reviews that exact change set before `execute`. `client-update:sign` signs locally once the exact manifest digest is approved. `client-update:publish` writes release objects to the feed bucket with that approved digest; resume an unconfirmed receipt only through `status` or `replace-status`. Separate from the Authority slot and onboarding transfer. |

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

In Session Manager, run each installed host wrapper from
`/srv/echo-authority-clean-v1` as `sudo ./<wrapper> ...`, including the rerun
commands a wrapper prints; never use `sudo -i`, `su` or a root shell. The
[deployment guide](../../deploy/organization-authority/README.md) explains why
an unelevated run fails.

| Task | Actor |
| --- | --- |
| Valid-session checks, planning, receipt polling, artifact verification, kit installation, authenticated Person reads and telemetry inspection | Local operator within the authorized lane. |
| Missing/expired login, MFA, provider secret entry, account switching/logout, the admin password for a Linux desktop update, and Slack `person tools setup`/`connect --tool slack` (the desktop app's Tools page connects only each person's own tools) | Human. The operator prepares the exact next action and resumes after completion. |
| Initial host `resume`, `status`, `continue-staged-initial-onboarding`, and release-canary `sudo ./update-clean-v1.sh canary` | Human in Session Manager. The staged continuation applies only to the digest-bound original pre-Slack candidate and never accepts it or replaces the final release decision. The remote release CLI does not support host onboarding. Group consecutive host commands only when no intervening human action is needed. |
| Inspect or retry a held extraction | Human in Session Manager through the installed `onboard-clean-v1.sh extraction-attempts` and `retry-extraction` commands; follow the [exact recovery procedure](../../deploy/organization-authority/README.md#inspect-and-retry-a-held-extraction). A retry explicitly authorizes one additional model call. |
| Organization Slack setup | Human reuses the designated app for staging resets with `person tools setup --tool slack --existing-app <app-id>` and the [four named hidden prompts](../../deploy/organization-authority/README.md#use-an-existing-slack-app-before-the-first-connection): configuration token, client ID, client secret and signing secret. The operator supplies the app ID from the handoff; credentials never enter chat or command arguments. ECHO passes the saved app credentials to Nango; the human does not copy them into Nango's integration settings. To resume consent using credentials already saved for that app, use `person tools setup --tool slack --reconnect`. Reuse a completed setup when its evidence is still valid. |
| Unreleased rehearsal replacement and `prepare-rehearsal` using retained provider inputs | Human in Session Manager after the nonsecret transfer completes. Credentials stay on the host; use the exact operation ID from its receipt. |
| Approval of the canary or a fixture meeting | Human, for each proposal: on the desktop meetings sheet, or on the Slack DM copy when the owner linked Slack. The first decision wins, wherever it is made. |
| Infrastructure change set or private handoff not yet approved for its exact scope | Human reviews the prepared result once. |
| Final decision on the exact candidate release and, when applicable, its exact signed-feed inputs | Human, after successful candidate-client checks. The canary approval remains separate. |

For browser onboarding, the local operator privately transfers the invitation
and accepted record through the reviewed export CLI, verifies the matching
command-line kit, runs `"<release-matched-kit>/Start-ECHO.sh" --install-only`,
then runs
`"$HOME/Library/Application Support/ECHO/cli/bin/echo-brain" person login --invitation <transferred-absolute-path> --open-browser`.
Keep invitation mode `0600`; never print or paste its grant. The human completes
browser login, any required logout, and Slack setup and connect: an owner follows
the organization Slack setup row above, then everyone runs
`person tools connect --tool slack` (or, without a browser,
`person tools connect --tool slack --method dm-code --slack-user U…`). Export
does not advance onboarding.

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
operator then runs `sudo ./onboard-clean-v1.sh resume` and `sudo ./onboard-clean-v1.sh status`.
The delegation above applies to the reads only, never the canary approval or
host commands.
For the fresh four-meeting source, use the linked rehearsal's four approvals
and owner/employee read checks instead of this single-canary query.

For an update, use the candidate's two checks in the
[release loop](../../deploy/release/README.md#ec2-authority-replacement), which
include a cited Ask. After `stage` and synthetic `canary`, stop for the founder's
approval of the canary meeting, on the desktop or in Slack if linked. The local operator installs the verified candidate
client and runs its checks. Only after both checks pass, show their evidence
and ask the founder for the final decision on that exact candidate.
Preserve the separate release- and client-digest-bound authorization before
`promote`. For a coordinated release, retain the exact prepared manifest,
channel, all four targets and predecessor binding in the existing feed approval
records as well. Never create it merely because the PR was approved or the
founder authorized automation. Nor create either approval because the candidate
was staged. If checks fail, run a fresh release `status` action and roll back
the exact candidate.

## Evidence and completion

The staging canary is synthetic and staging-only. It runs on the owner's
synthetic personal source, which replaces the removed organization meeting
source, and its proposal is approved like any other meeting. Do not create a
live Granola note for this flow. Ordinary initial terminal green requires the release-bound
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
the confirmed signed-feed publication receipt for all four targets. Retain
separately for representative macOS arm64 and Linux x64/glibc seats the A-to-B
activation, authenticated read and cited Ask evidence using B, and for
representative macOS arm64 and Ubuntu x64 desktops the
[desktop update](../../deploy/client-updates/README.md#verify-the-desktop-update)
evidence. The feed receipt alone does not show that any installed client
activated the release, and the representative proofs do not claim fleet-wide
activation.

## Exceptions and recovery

[Environment drift](../../deploy/release/README.md#environment-drift-before-staging)
blocks staging: stop and leave the investigation to the human host operator.
Never edit environment files by hand; preserving observability takes precedence
over making a status check pass. Before installing the current release tooling,
run the distinct `inspect-install` plan the
[release guide](../../deploy/release/README.md#live-operator-boundary)
describes; a present or unsafe repair marker requires the human host
operator's repair lane. Finish or poll every unfinished release receipt with the
commit that planned it before switching tooling.

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
