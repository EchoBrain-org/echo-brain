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

Coding agents do not start interactive SSM sessions. A human at the keyboard
may use Session Manager for an exact installed wrapper on the exact staging
host. Staging-slot and onboarding-transfer mutations use only their repository
CLIs, never raw AWS, CloudFormation, MCP mutation, or a hand-written SSM
command.

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
| Change the accepted image on the current host | A human runs installed `update-clean-v1.sh stage`, synthetic `canary`, stops for approval and the release checks, then runs `promote`. |
| Diagnose an environment mismatch before staging | A human runs installed `update-clean-v1.sh diagnose-environment`; it reports only allowlisted setting names and safe classifications, not environment values or runtime health. |
| Recover accepted-only staging content-telemetry drift | After reviewing the diagnostic and exact accepted release ID, a human runs installed `update-clean-v1.sh repair-environment` with its explicit restore confirmation. Unknown drift or a staged candidate stops this lane. |
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

**Current-host update.** After `update-clean-v1.sh stage`, run its synthetic
`canary`, then stop. On the designated canary Mac, the founder installs the
same candidate release's verified offline Person-client bundle, approves the
private Slack card, and runs the two absolute-path checks in the
[clean-v1 release loop](../../deploy/release/README.md#ec2-authority-replacement).
Only after both checks pass may the host operator run
`update-clean-v1.sh promote --canary-passed` for that exact candidate. The flag
is the operator's explicit confirmation of those human checks, not evidence
created by the staged canary receipt. Run `status` and roll back instead if any
check fails.

**Environment drift before an update.** Do not edit the active environment or
accepted snapshot by hand. The installed wrapper's `diagnose-environment`
selects the staged candidate when present, otherwise the accepted record.
Only accepted-only drift limited to the canonical staging content-telemetry
switch is eligible for `repair-environment`; the exact syntax and evidence
contract are in the [release loop](../../deploy/release/README.md#environment-drift-before-staging).
The human reviews that restoring the saved setting may disable telemetry until
the next candidate. Recovery preserves a private before-copy, leaves the
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

**Host actions are human-only.** The human operator selects the exact instance
from the reviewed stack output, opens its Session Manager session, changes to
`/srv/echo-authority-clean-v1`, and runs only the wrapper action named by the
playbook or current wrapper output. Any privilege elevation is non-interactive
and scoped to that exact command. Coding agents stop before opening the session
or typing the command. Stop if the instance, installed path, candidate/lock
state, or printed next action differs from the reviewed expectation.

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
change-set review, private file transfer, Google browser login, Slack link and
Interactivity setup, private Slack-card approval, Person reads, or provider
secret entry. Show the exact actor-scoped action and wait.

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
