---
schema_version: 1
id: RB-OPERATIONS-003
kind: runbook
title: Protect canonical source and immutable clean-beta releases
component_ids:
  - CMP-OPERATIONS-RELEASE
created_at: 2026-08-26
reviewed_at: 2026-08-26
reviewed_ref: 2cadcfcddf550b851b3f8f4b6b48bcb29b9ee90c
tested_at: null
---

# RB-OPERATIONS-003: Protect canonical source and immutable clean-beta releases

## Trigger, outcome, preconditions, and stop conditions

Use this runbook before closing
[#25](https://github.com/EchoBrain-org/echo-brain/issues/25) and before
publishing the first clean beta. The outcome is an active GitHub ruleset that
protects `main`, mandatory owner review for changes to the CI and release
boundary, and release immutability for every future release. This procedure
does not deploy a product or publish a release.

Repository settings are the enforcement boundary. Merging this runbook or its
`CODEOWNERS` file does not by itself protect a branch, tag, or release. The
repository owner `@EchoBrain-org` applies the settings; a different signed-in
account verifies the public rules and pull-request behavior. Keep credentials
and private administration evidence out of the repository.

This is a public repository owned by a personal GitHub account, not an
organization. Organization rulesets, teams, and organization-hosted required
workflows are therefore unavailable. Do not document or configure them as if
they existed. The personal-repository boundary is:

- the base branch's [`.github/CODEOWNERS`](../../.github/CODEOWNERS) assigns
  the policy and release surfaces to `@EchoBrain-org`;
- the `main` ruleset requires Code Owner approval when one of those paths
  changes; and
- GitHub evaluates `CODEOWNERS` from the pull request's base branch, so a pull
  request cannot remove its own owner-review requirement.

This closes the self-modifying-workflow gap through explicit trusted review,
not through the repository's status check alone. It does not prevent the
personal repository owner from changing settings administratively. Any such
change must be recorded in an issue or pull request and reverified before a
release, but repository-local policy cannot make the owner's Settings access
independent of the owner.

Stop and keep issue #25 open if any of these conditions is true:

- the owner account cannot be selected as both Code Owner and user-specific
  pull-request-only bypass actor;
- the ruleset does not apply to administrators;
- `CI required checks` cannot be pinned to GitHub Actions in strict mode;
- a protected-path pull request can merge without `@EchoBrain-org` approval;
- force-push or deletion protection is absent; or
- repository release immutability cannot be enabled and read back.

Never change, delete, move, or relabel a historical tag or release while doing
this work. Immutability applies only to future releases.

## Why one required CI check is sufficient

Configure only `CI required checks` as the required status check. Its current
GitHub App is `github-actions` with application ID `15368`. In the committed
[CI workflow](../../.github/workflows/ci.yml), the `required-checks` job needs:

```text
check
macOS arm64 Person-client package
Organization authority container
Authority recovery infrastructure
```

The aggregate uses `if: always()` and succeeds only when every dependency
result equals `success`. The executable architecture test
[`tests/architecture/ci-workflow.test.ts`](../../tests/architecture/ci-workflow.test.ts)
asserts the dependency topology and each success test. Requiring the four
implementation checks separately would duplicate the committed topology in
GitHub settings and make safe CI evolution brittle.

The aggregate proves the current repository checks. Code Owner review protects
the workflow, release tools, build configuration, and the tests that define
that proof from being weakened unnoticed in the same pull request.

## Apply the rules

### 1. Bootstrap the repository contract

Review this pull request from the owner account before merge. The first merge
is a bootstrap: `main` does not contain `CODEOWNERS` yet, so GitHub cannot
enforce Code Owner review on that pull request. Retain the owner review and
green `CI required checks` URLs as the bootstrap receipt.

The architecture test
[`tests/architecture/github-governance.test.ts`](../../tests/architecture/github-governance.test.ts)
keeps the complete protected-path list exact and prevents a later catch-all
rule from silently overriding it. If a new workflow, workspace manifest, build
configuration, release tool, or deployment entry point is added, update
`CODEOWNERS` and the test together through an owner-approved pull request.

### 2. Create the active `main` ruleset

In **Settings > Rules > Rulesets**, create one active branch ruleset named
`Protect canonical main` with this exact policy:

- target only `refs/heads/main`;
- add user `@EchoBrain-org` (public user ID `302292153`) as the only bypass
  actor, with **For pull requests only** selected;
- require a pull request before merging;
- require zero general approvals and require review from Code Owners, keeping
  review ceremony limited to the protected paths;
- dismiss stale approvals when new reviewable commits are pushed;
- require `CI required checks`, expected from GitHub Actions application
  `15368`, with **Require branches to be up to date before merging** enabled;
- restrict deletions; and
- block force pushes.

Do not add a repository role, collaborator, deploy key, or application bypass.
Do not select an always-allow or exempt bypass. The named user may bypass a
gate only from a pull request, leaving the pull-request, review, ruleset-bypass,
and merge trail. The bypass does not authorize direct pushes, force pushes,
branch deletion, tag movement, or release mutation.

GitHub documents the rule types, strict status checks, user bypass actors, and
the `pull_request` bypass mode in its
[rulesets REST reference](https://docs.github.com/en/rest/repos/rules). GitHub
also documents that Code Owner approval is required independently for owned
paths and that the base-branch file governs a pull request in
[About code owners](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners).

### 3. Enable immutable future releases

In repository **Settings**, scroll to **Releases** and select
**Enable release immutability**. GitHub states that this affects future
releases only. Once a future immutable release is published, its associated
tag cannot be moved or deleted while the release exists, its assets cannot be
modified or deleted, and GitHub creates a release attestation. Do not use a
separate moving tag as a deployment identity.

## Verify enforcement before closing issue #25

Record the UTC time, repository, ruleset ID, enforcement state, actor names,
required-check identity, pull request URLs, and redacted settings/API evidence.
No credential or token belongs in the receipt.

1. Read the ruleset back and confirm its source is this repository, its state
   is active, and it targets only `refs/heads/main`.
2. Confirm the only bypass entry is user `EchoBrain-org` in `pull_request`
   mode. Confirm there is no role-wide administrator exemption.
3. Confirm the rule list contains pull requests, strict required status
   `CI required checks` from app `15368`, deletion restriction, and
   non-fast-forward restriction.
4. Confirm release immutability is enabled for future releases.
5. After `CODEOWNERS` reaches `main`, open or reuse a harmless ordinary-author
   pull request that changes a protected path. Confirm GitHub requests
   `@EchoBrain-org`, blocks merge before that approval, dismisses an approval
   after a new reviewable push, and still requires the aggregate check.
6. Inspect the ruleset result for `main` and the pull request merge box. Do not
   test force-push or deletion by risking a real update to `main`; the active
   rule definition is the evidence for those destructive denials.
7. Verify that the owner sees a bypass option only inside a pull request. Do
   not exercise it merely to produce evidence.

Useful read-only checks for an authenticated operator are:

```sh
gh ruleset list --repo EchoBrain-org/echo-brain
gh ruleset check main --repo EchoBrain-org/echo-brain
gh api repos/EchoBrain-org/echo-brain/rulesets
gh api repos/EchoBrain-org/echo-brain/branches/main
gh api repos/EchoBrain-org/echo-brain/immutable-releases
```

The immutable-releases endpoint returns `404` when the feature is disabled.
Treat an incomplete response, permission error, or UI/API disagreement as
missing evidence. Retain no authentication material.

If verification fails, do not publish a beta and do not close issue #25.
Correct the repository contract through a pull request or correct the settings
from the owner account, then repeat the full readback.

## Publish the first clean beta once

After issue #25 is closed and before the first beta is published:

1. Select the protected `main` commit whose `CI required checks` result is
   green. Record its full SHA. Never use a moving tag.
2. Build and validate the release record, Person-client artifact and onboarding
   kit, Authority image digest, and runtime profile from that exact commit.
3. Create a draft release with a new clean-beta semantic-version tag pointing
   directly at the selected full SHA. Do not publish yet.
4. Attach every final artifact exactly once. Download the draft assets and
   verify names, sizes, SHA-256 digests, source SHA, Authority image digest,
   runtime-profile digest, and release-record digest.
5. If anything is wrong, delete only the unpublished draft and its newly
   created tag, correct the inputs, and start a fresh draft.
6. Publish the verified draft once. Record the immutable tag, full source SHA,
   release URL and attestation, asset digests, publisher, reviewer, and UTC
   publication time. That immutable tuple is the deployment identity.
7. Verify in a fresh read-only session that GitHub labels the release
   immutable. Do not attempt a mutation when the lock state and attestation
   provide the evidence.

GitHub recommends the draft, attach-all-assets, publish sequence in
[Immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases).
There is no rollback that rewrites a published clean beta. If publication is
wrong, preserve it, stop deployment, fix the source through the protected pull
request path, and publish a higher version.

## Completion handoff

Issue #25 is complete when the repository contract is merged, all checks are
green, the active ruleset and immutable-release setting pass the readback, and
the first protected-path pull request proves the Code Owner gate. The beta does
not need to be published to close the configuration issue; its future
publication must follow the final section. Keep `tested_at: null` until the
publication procedure itself has been rehearsed against an exact release.
