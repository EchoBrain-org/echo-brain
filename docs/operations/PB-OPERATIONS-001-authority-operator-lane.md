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

The AWS staging slot, its CloudFormation lifecycle CLI, the onboarding input
transfer CLI, the host bundle, and the automated current-host release lane were
retired on 2026-09-06. The only deployed Authority is the production host, and
every change to it is a human action.

## Scope and authority

Read this before any Authority operator work. `AGENTS.md` owns the exhaustive
trigger list.

**Cloud or isolated coding agent:** stop before every live operation. The Cloud
boundary in `AGENTS.md` wins. This playbook does not permit AWS, SSM, secrets,
production endpoints, Slack, Granola, or deployment.

**Local exercise:** `authority:local` needs neither AWS SSO nor live provider
credentials. Stop if the goal needs the live edge, Slack, Granola, or a deploy.

**Founder-live AWS work:** one human operator controls the production host.
Coding agents do not start interactive SSM sessions, open SSH, or run a host
wrapper, and this repository wraps no SSM Run Command. Pause for the founder to
complete `aws sso login --profile echo-prod` and MFA before any read-only
inspection.

For a secret, credential, token, or password task, load
`aws-secrets-manager` first. Never fetch, print, or paste a secret value.
Onboarding inputs remain opaque in their private mode-`0700` directory.

## Select one lane

| Goal | Lane and boundary |
| --- | --- |
| Compile, test, or exercise without the live edge | Run `npm run authority:local`; do not touch the production host. |
| Inspect the production host without changing state | A human runs the installed wrapper's `status` through Session Manager. An agent may only read AWS inventory with `--profile echo-prod`. |
| Change the accepted image on the production host | A human follows the [EC2 Authority replacement loop](../../deploy/release/README.md#ec2-authority-replacement): `update-clean-v1.sh stage`, the wrapper's approval gates, then `promote` or rollback. |
| Diagnose or repair environment drift before an update | A human runs `update-clean-v1.sh diagnose-environment` and, only for eligible accepted-only drift, `repair-environment`, per the [drift procedure](../../deploy/release/README.md#environment-drift-before-staging). |
| Advance initial-owner onboarding | A human runs installed `onboard-clean-v1.sh resume` and follows its exact actor-scoped action. |
| Protect or recover the production root volume | Follow [RB-OPERATIONS-002](RB-OPERATIONS-002-authority-recovery-floor.md); the installed wrapper is `backup-authority-maintenance.sh`. |
| Deploy or rehearse observability | Follow [RB-OPERATIONS-001](RB-OPERATIONS-001-authority-observability.md) with a reviewed change set. |

An Authority image build does not activate an image. Only `update-clean-v1.sh`
on the production host does.

## Host access is bounded

Installed update, onboarding, and backup-maintenance wrappers hold a root-owned
interlock outside the service-writable data tree. A `control_path_changed`
result retains the guard for investigation; never remove it to force progress.
The human selects the exact instance, opens Session Manager, changes to
`/srv/echo-authority-clean-v1`, and runs only the named installed wrapper
action. Privilege elevation stays non-interactive and scoped to that command.
Agents never open or type into that session. Stop on unexpected instance,
installed path, accepted record, candidate, or lock state.

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

Do not create a live Granola note to rehearse a release. Terminal green requires
durable progress from the admitted live source, a healthy Authority, and the
accepted image.

## Stop and escalation rules

Stop for AWS SSO MFA, every CloudFormation change-set review, transfer of
private onboarding or session material, Google browser login, Slack link and
Interactivity setup, private Slack-card approval, the release decision, or
provider secret entry. Show the exact actor-scoped action and wait. Unknown
drift, unconfirmed remote execution, or destructive changes are not permission
to broaden this lane.

Never place a login grant in argv or chat, use SSH or an interactive root
shell, or create agent-specific shortcuts that restate this playbook. If a
candidate release is already staged, a human runs `update-clean-v1.sh status`,
then promotes or rolls it back before onboarding resumes.

Command reference: [root README](../../README.md),
[Authority deployment README](../../deploy/organization-authority/README.md),
[clean-v1 release loop](../../deploy/release/README.md#ec2-authority-replacement),
[RB-OPERATIONS-001](RB-OPERATIONS-001-authority-observability.md),
[RB-OPERATIONS-002](RB-OPERATIONS-002-authority-recovery-floor.md), and
[RB-OPERATIONS-003](RB-OPERATIONS-003-protect-canonical-source-and-releases.md).
