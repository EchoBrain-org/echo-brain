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

This is the shared Authority operator playbook for coding agents. The root and
deployment READMEs and the installed host wrappers own exact command syntax;
this file selects one safe lane and its stopping point.

## Scope and authority

Read this before any Authority operator work. `AGENTS.md` owns the exhaustive
trigger list.

**Cloud or isolated coding agent:** stop before every live operation. The Cloud
boundary in `AGENTS.md` wins. This playbook does not permit AWS, SSM, secrets,
production endpoints, Slack, Granola, or deployment.

**Local exercise:** `authority:local` needs neither AWS SSO nor live provider
credentials. Stop if the goal needs the live edge, Slack, Granola, or a deploy.

**Founder-live AWS work:** one operator controls the staging slot. Do not run
overlapping lifecycle commands from another terminal, machine, or agent. Pause
for the founder to complete `aws sso login --profile echo-prod` and MFA.

Coding agents do not start interactive SSM sessions. For current-host staging
releases, a local coding agent uses the reviewed `authority:staging-release`
CLI. It binds one named action to the live stack/instance/volume, exact accepted
release and reviewed source; it has no shell passthrough. A human may still use
Session Manager for an exact installed wrapper on that host. Staging-slot and
onboarding-transfer mutations remain confined to their existing repository
CLIs, never raw AWS, CloudFormation, MCP mutation, or a hand-written SSM command.

For a secret, credential, token, or password task, load
`aws-secrets-manager` first. Never fetch, print, or paste a secret value. The
Cloudflare token is supplied only as a `{{resolve:secretsmanager:...}}` dynamic
reference through `asm-exec`. Onboarding inputs remain opaque in their private
mode-`0700` directory and temporary transfer archive.

## Select one lane

| Goal | Lane and boundary |
| --- | --- |
| Compile, test, or exercise without the live edge | Run `npm run authority:local`; do not restage. |
| Inspect without changing state | Run `authority:staging status` or the applicable host wrapper's `status`. |
| Create or repair the retained AWS and Cloudflare boundary | Run `authority:staging slot-init`: plan, human review, then execute the unchanged operation. |
| Create the first host on a never-prepared volume | Run `up --initialize-blank-data-volume`: plan, human review, then execute. |
| Replace a host while retaining its prepared volume and edge | Run a reviewed `down`, then use a new operation ID for reviewed `up --require-authority`; keep the flag on both plan and execute. |
| Change the accepted image on the current staging host | The local operator uses `authority:staging-release` to install reviewed tooling, stage and run the synthetic canary; stops for human Slack approval; runs the exact candidate-client checks; then requests the exact final release decision before `promote`. |
| Inspect why reviewed tooling cannot be installed | Use the release CLI's `inspect-install` action. It evaluates the install guards without replacing tooling or invoking a runtime wrapper, and returns only a bounded refusal category. |
| Diagnose an environment mismatch before staging | The release CLI's `diagnose` action invokes installed `update-clean-v1.sh diagnose-environment`; only allowlisted setting names and safe classifications leave the host. |
| Recover accepted-only staging content-telemetry drift | The release CLI's `repair` action binds the exact accepted record and requires an eligible diagnostic before the installed wrapper restores its snapshot. Unknown drift or a staged candidate stops this lane. |
| Move first-onboarding input to a ready host | Run onboarding-transfer `preflight`, `plan`, human review, then `execute`. |
| Advance initial-owner onboarding | A human runs installed `onboard-clean-v1.sh resume` and follows its exact actor-scoped action. |

A host-bundle or image build does not activate an image. Use `update-clean` on
the current host, or use a reviewed host bundle when creating a new host.

## Status and lifecycle selection

Before a live slot change, collect the private-input `authority:staging status`
receipt. Preserve `edge_checked`, `host_ready`, and `authority_accepted`; the
top-level state alone is not the whole observation.

| Status | Next action |
| --- | --- |
| `absent` or `incomplete` | Plan `slot-init` and review its change set before execute. |
| `planned` | Do not start competing work. Preserve the existing operation and follow the staging specification. |
| `failed_create` or `unprotected` | Follow the receipt's `recovery_action` through the staging specification. Do not delete or rename the stack. |
| `update_rolled_back` | Follow its `recovery_action` through the staging specification. |
| `host_down` | Never-prepared volume: use the first-host lane. Accepted retained volume: use `up --require-authority`. |
| `authority_unpinned` or `authority_pin_mismatch` | Stop. Set or correct the private pin only from accepted bootstrap evidence, never from the public endpoint. |
| `authority_unready` | If first onboarding is underway, use the onboarding lane. After a failed required `up` verification receipt, repeat only that exact `up --execute --require-authority` with the same operation ID; its host-ready retry is probe-only. Otherwise stop and investigate through the staging specification. |
| `ready` | No lifecycle change is needed. |

`--initialize-blank-data-volume` is only for a volume that has never reached
first-host readiness. Until it does, retries use a new operation ID and retain
that flag. Never use it on prepared `clean-data`.

After first-host acceptance, a human copies the independently trusted
`authority_pin_sha256` from accepted bootstrap evidence into the private
input. Every retained-volume restart then plans and executes with
`--require-authority`. That path resumes the retained Authority inside the
CloudFormation bootstrap before it signals host readiness. Do not invoke
`restore-clean-v1-host.sh resume` manually for this normal path.

## Transfer, host, and founder handoffs

**Current-host staging update.** The local operator uses the exact command
syntax in the [automated release lane](../../deploy/release/README.md#automated-current-host-staging-lane).
Plan and execute are machine steps, not repeated human approval prompts.
Execute only reviewed merged tooling from a clean checkout. The CLI transfers
non-secret source/record/profile artifacts within a bounded SSM request; no
manual artifact upload, S3 grant, onboarding courier, or host replacement is
needed. Its state receipt is resumable without repeating a submitted command.

After `stage` and synthetic `canary`, stop for the founder's private Slack-card
approval. On the designated canary Mac, the local operator may install the same
candidate's verified offline Person-client bundle and run the two absolute-path
checks in the [release loop](../../deploy/release/README.md#ec2-authority-replacement).
Login/MFA stays human. Only after both checks pass, show their evidence and ask
the founder for the final decision on that exact candidate. The promotion plan
requires a separate release- and client-digest-bound authorization recording
those checks and that decision. It is an operator attestation, not a signature
or evidence invented by the synthetic canary. Never create it merely because
the PR was approved or the founder authorized automation. Run a fresh `status`
operation and roll back the exact candidate if a check fails. No client-live or
production release is authorized by this staging lane.

**Environment drift before an update.** Do not edit the active environment or
accepted snapshot by hand. The installed wrapper's `diagnose-environment`
selects the staged candidate when present, otherwise the accepted record.
Only accepted-only drift limited to the canonical staging content-telemetry
switch is eligible for `repair-environment`; the exact syntax and evidence
contract are in the [release loop](../../deploy/release/README.md#environment-drift-before-staging).
The operator reports that restoring the saved setting may disable telemetry
until the next candidate. The founder's staging-automation delegation permits
this narrow eligible repair; an unrelated difference still requires review.
Recovery preserves a private before-copy, leaves the
accepted snapshot unchanged, and must verify the accepted runtime before
clearing its pending marker. If interrupted, retry only the same repair for
the same accepted release. Do not remove the marker or start a candidate to
work around it. Intended telemetry changes belong in the next candidate's
`stage --content-telemetry` option, before its canary and promotion.

**Initial input transfer.** Run the AWS-free `preflight` before spending an AWS
session or creating an archive. Plan creates the reviewable grant and private
receipt; a human reviews the named change set before execute. Successful
execute performs remote and local cleanup and returns `prepared`. Run `cleanup`
only when execute retains the receipt and reports `cleanup_required`; do not
create another archive, send a second command, or reuse the operation ID.

**Host access is bounded.** The release CLI is the local coding-agent lane for
its named current-host staging actions only. It pins the verified release
directory for the runner and updater, holds a root-owned interlock outside the
service-writable data tree, and refuses any legacy Authority operation lock.
Installed update/onboarding/backup-maintenance wrappers hold that same guard throughout their
operations; retained restore holds it through materialization, its direct
root onboarding-resume child, and terminal-status verification. The child
validates the private root guard and parent PID and does not release it.
A failed backup restart preserves the root guard as
well as its legacy recovery lock. Updater temporary publication stays relative
to the pinned directory. The updater child uses the exact private nested
lock inside the guard. A `control_path_changed` result retains the guard for
investigation; never remove it to force progress. Installation updates those
wrappers' checks but does not invoke onboarding or restoration. It does not
permit onboarding, bootstrap, arbitrary commands, or interactive access.
Other host actions remain human-only: the human selects the exact instance,
opens Session Manager, changes to `/srv/echo-authority-clean-v1`, and runs only
the named installed wrapper action. Privilege elevation stays non-interactive
and scoped to that command. Agents never open or type into that session. Stop
on unexpected instance, installed path, accepted record, candidate, or lock state.

**Resume onboarding.** Run `onboard-clean-v1.sh resume`, then stop at every
printed `ACTION:`, `HOST ACTION:`, or `FOUNDER ACTION:`. Do not loop `resume`
through a human gate.

- For browser login, privately transfer the invitation, accepted release
  record, and verified release-matched Person kit to the initial-owner Mac.
  Preserve mode `0600` on the invitation and never paste its grant. Run only
  `"<release-matched-kit>/Start ECHO.command" <transferred-absolute-path>`; do
  not use a preexisting global `echo-brain` command. If the kit reports another
  signed-in person, the human runs the exact installed client `person logout`
  command printed by `resume`, then retries the same kit command.
- For Slack link, the human runs the exact installed-client `person slack-link`
  command printed by `resume` and completes the one-time code exchange.
- For Interactivity, the human saves the exact Slack Request URL printed by
  `resume`.
- For the canary handoff, the human host operator runs
  `./update-clean-v1.sh canary`. The founder approves its private Slack card and
  runs both exact installed-client Person reads printed by `resume`. The host
  operator then reruns `./onboard-clean-v1.sh resume` and
  `./onboard-clean-v1.sh status`.

The staging canary is synthetic and staging-only. Do not create a live Granola
note for this flow. Terminal green requires the release-bound synthetic
receipt, one positive Layer 1 read, one positive Layer 2 search, a healthy
Authority, and the accepted image.

## Stop and escalation rules

Stop for AWS SSO MFA, Cloudflare-token creation, every CloudFormation
change-set review, transfer of private onboarding/session material, Google
browser login, Slack link and Interactivity setup, private Slack-card approval,
the exact candidate's final release decision, or provider secret entry. Person
reads in initial onboarding remain its printed founder gate; the current-host
release lane permits the local operator to run the exact candidate-client checks.
Show the exact actor-scoped action and wait. Unknown drift, unconfirmed remote
execution, or destructive changes are not permission to broaden this lane.

Never guess `authorityPinSha256`, place a login grant in argv or chat, use SSH
or an interactive root shell, issue a second transfer `SendCommand`, or create
agent-specific shortcuts that restate this playbook. If a candidate release is
already staged, run `update-clean-v1.sh status`, then promote or roll it back
before onboarding resumes.

Command reference: [root staging README](../../README.md),
[Authority deployment README](../../deploy/organization-authority/README.md),
[clean-v1 release loop](../../deploy/release/README.md#ec2-authority-replacement),
[RB-OPERATIONS-001](RB-OPERATIONS-001-authority-observability.md),
[RB-OPERATIONS-002](RB-OPERATIONS-002-authority-recovery-floor.md), and
[RB-OPERATIONS-003](RB-OPERATIONS-003-protect-canonical-source-and-releases.md).
