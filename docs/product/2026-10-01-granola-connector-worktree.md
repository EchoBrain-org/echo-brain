# Granola Connector Worktree

This brief defines the Granola worktree as the meeting export and approval
lane. It preserves the existing admitted-meeting path while preparing a
separate, per-person authorization boundary for exports that a person could
perform themselves.

## Baseline

| Item | Value |
| --- | --- |
| Branch | `feat/meeting-connector` |
| Base commit | `a62ab22239d6c4b724ffa32c0847d1ba39094d0b` |
| Provider | Granola |
| Initial outcome | Exported meetings admitted, reviewed, and approved through ECHO |

This is setup documentation only. It does not authorize a deployment, a credential change, an account connection, or a live-provider rehearsal.

## What exists today

ECHO already has a Granola meeting source. The Authority service selects it in
[`organization-authority-composition-root.ts`](../../services/organization-authority/src/composition/organization-authority-composition-root.ts).

The provider implementation lives in `providers/granola/**`:

- `granola-meeting-source-admission.ts` admits one post-cutoff source after it
  verifies the configured owner and the immutable source commitments.
- `granola-meeting-source-bundle-v1.ts` rechecks those commitments before it
  reads the provider credential and constructs the source adapter.
- `source/meeting-source-adapter.ts` fetches, normalizes, versions, and pages
  meeting material through the meeting-source port.
- `source/record-owner-observation.ts` keeps the admission check
  metadata-only when it proves the configured Granola owner exists.

The current path uses an organization-held Granola credential and an owner
email proof. It is not a personal OAuth connection, a Nango connection, or a
live Ask reader.

After admission, ECHO binds custody and audience, retains immutable source
revisions, processes the meetings, and sends the resulting work through the
existing approval path. Approved meeting records can already reach Ask through
the retained evidence flow. They do not depend on the future live-ticket
Evidence Desk registry.

## Target boundary

The next Granola capability is a per-person, export-equivalent boundary. Its
purpose is to record that a named ECHO person has authorized ECHO to retrieve
meeting material that the person could export from Granola.

The shared access contract represents this with a connected `source_export`
capability. That capability is separate from `live_evidence`: granting export
permission must not create a general live-read permission.

The Granola provider will eventually need to prove the external subject and
any applicable workspace or tenant before it treats a personal authorization
as usable. The provider owns Granola API parsing, item and revision identity,
cursor behavior, and provider-specific permission checks.

ECHO continues to own the safeguards after an export:

- source custody and audience are bound by ECHO rather than inferred from a
  provider token;
- source revisions are immutable and content changes under one revision are
  rejected;
- admission remains explicit and limited to the committed source;
- review and final approval determine whether retained meeting material is
  available to broader ECHO workflows.

An export authorization alone does not allow retention, sharing, or a new Ask
surface.

## Worktree ownership

This worktree owns `providers/granola/**` and Granola-specific fixture tests.
Keep provider transport, parsing, ownership proof, and meeting normalization in
that directory.

Do not modify these shared integration areas in this worktree:

- `packages/organization-api/src/person-*`
- `packages/organization-authority-kernel/src/shared/*`
- `services/organization-authority/src/composition/person-evidence-desk-v1.ts`
- `services/organization-authority/src/composition/person-answer-v3-route.ts`
- `services/organization-authority/src/composition/organization-authority-composition-root.ts`

The final file is especially important because the Slack onboarding worktree
currently changes it. Shared API, Authority composition, and Answer-version
work belong to the shared integration lane.

## Tests and evidence

Use fixture-based tests for Granola payloads, owner observations, cursors,
revision identity, custody, admission, and approval behavior. Extend the
existing tests under `providers/granola/test/` before any live-provider check.

Keep fixture credentials synthetic. Do not add credential files, tokens, or
provider responses containing real meeting text to the repository.

## First research decision

Before choosing a personal connection transport, verify from Granola's current
supported documentation whether the required export-equivalent authorization
can use Nango and which Granola authentication mechanism supports it. Do not
assume Granola offers OAuth, Nango support, user-scoped exports, or a suitable
API merely because the shared contract can represent them.

Until that evidence exists, continue treating the current organization-owned
admission pipeline as the supported Granola path. Personal export status and
authorization plumbing remain open shared-integration prerequisites.
