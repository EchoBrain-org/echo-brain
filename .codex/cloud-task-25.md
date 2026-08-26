## Issue

Refs #25 until the repository-admin settings are live and independently verified.

## Outcome

Prepare the smallest repository-side contract and operator runbook needed to
protect canonical `main` commits and the first clean beta release. The final
operator configuration must require the current clean CI contract, block
history destruction, leave one narrow auditable founder emergency path, and
make the published clean-beta tag and release assets immutable.

## Current evidence

- GitHub currently reports no `main` branch protection and no repository
  ruleset. Immutable releases are disabled.
- PR #70 is merged. `.github/workflows/ci.yml` now exposes the stable aggregate
  check `CI required checks`, and the architecture suite proves that it fails
  unless `check`, `macOS arm64 Person-client package`,
  `Organization authority container`, and
  `Authority recovery infrastructure` all succeed.
- Issue #31 remains open, but the aggregate check dependency needed by #25 is
  present on `main` and green.
- Existing internal releases and tags are historical. Do not rewrite, delete,
  or relabel them. This task governs the first future clean beta.

## Lean implementation constraints

- First inspect issue #25, the merged CI workflow and architecture tests,
  release tooling, existing runbooks, and current GitHub documentation.
- Keep repository changes minimal. Add only the durable documentation,
  declarative policy, verification helper, or focused tests that are actually
  needed to make the operator configuration reviewable and repeatable. Do not
  introduce Terraform, a new dependency, or a broad release framework unless
  the existing repository already establishes that pattern.
- Treat `CI required checks` as the stable external required check only if you
  prove and document how its current dependency topology covers every gate
  named by issue #25. Avoid redundant required-status configuration that would
  make safe CI evolution brittle.
- Close the workflow self-modification gap. A pull request must not be able to
  weaken or skip the workflow or release gate that judges that same pull
  request without an explicit trusted review or independently pinned policy.
  Choose the smallest GitHub-supported mechanism available to this repository
  and document its exact plan/permission prerequisite. Do not pretend a normal
  required status check alone solves this.
- Define the founder emergency bypass narrowly. It must preserve a pull request
  and an auditable GitHub event; it must not allow silent direct pushes, force
  pushes, branch deletion, tag replacement, or mutable release assets.
- Define the first clean beta publication sequence as draft release, attach and
  verify all artifacts, then publish once. The immutable release/tag becomes
  the deployment identity. Never use a moving tag.
- Do not edit the unrelated product proposal in the root worktree or the active
  ADR-0008/0009 branch.

## Required proof

1. Add focused failing proof first for any executable repository contract you
   introduce. If the correct change is documentation-only, explain why an
   executable test would be artificial and use the existing documentation and
   architecture validators.
2. Prove the exact aggregate check topology from the committed workflow and
   existing architecture test rather than relying on a prose assertion.
3. Provide a precise operator checklist with expected post-change evidence for
   pull-request enforcement, strict required status, blocked force-push and
   deletion, workflow/release-tool protection, founder PR-only bypass, and
   immutable future releases.
4. State any GitHub plan or organization-admin prerequisite explicitly. Fail
   closed if the strongest required-workflow mechanism is unavailable; propose
   the smallest honest fallback without claiming equivalent protection.
5. Run focused proof, documentation validation, and `npm run check`. Self-review
   the final diff for critical, high, and medium correctness or scope problems
   and fix them.
6. Delete this temporary task file before the final commit. Leave the result as
   a clean internal Cloud commit with an exact summary and operator handoff.

Do not change GitHub repository or organization settings from Cloud. Do not
merge, close issue #25 directly, deploy, call AWS or SSM, access production,
retrieve secrets or tokens, publish a release, create or move a tag, or modify
unrelated files. The founder/local operator will apply settings, verify live
evidence, update the PR to `Closes #25`, and merge only after review.
