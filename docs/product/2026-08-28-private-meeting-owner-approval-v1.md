# Private meeting-owner approval V1

**Status:** DEV implementation is wired and locally verified; staging,
qualification, and production deployment have not been claimed.
**Scope:** one private Slack DM to one verified meeting owner, followed by one
explicit approval or rejection with an optional comment. The implementation is
isolated from the current deployed runtime until it passes the rollout gate.

## Decision

V1 sends a pending approval only to the verified meeting owner in a private
Slack DM. The pending candidate has no canonical-record visibility policy.
The Block Kit approval UI defaults its policy selector to **Only me**. The
current approver must click a real **Approve** or **Reject** button. Approval
atomically freezes the selected **Only me** or **Team** policy; rejection
creates no readable canonical-record policy. Either action may carry one
optional plain-text comment.

For this V1, **Only me** means the final approver. With no delegation, that is
the verified meeting owner.

## Slack re-onboarding and staging boundary

The existing public `slack_approval_channel_id` is transitional and exists only
for the founder's Person-to-Slack identity-link challenge. It is not an
approval delivery destination, creates no shared-channel/reaction approval
binding, and does not gate approval readiness. Readiness requires the exact
active Slack connection and the founder's active external Slack identity link.

For a private-approval V1 staging run, operators must use one Slack app for the
bot token and signing secret. Grant `channels:history`, `channels:read`,
`chat:write`, `im:history`, `im:write`, `reactions:read`, and `users:read`,
then reinstall the app before using its new bot token. The same app's signing
secret goes in a separate current-user `0600` regular no-newline file. The run
uses a wholly fresh V2 staging lineage and never upgrades or reuses a
shared-channel rehearsal database, state directory, or approval binding.

Only after bootstrap, founder identity link, credential installation,
finalization, and active-runtime health, enable **Interactivity & Shortcuts**
and save this Request URL before creating the first post-cutoff canary meeting:

```text
https://<staging-authority-host>/v2/integrations/slack/interactions
```

The endpoint intentionally returns `503` before finalization, so it must not be
validated against the pre-finalize runtime. Event Subscriptions, Socket Mode,
and a Slack OAuth redirect are not required for this V1.

## Block Kit interaction

The owner's one-to-one DM contains one versioned Block Kit card with:

- a two-option policy selector: **Only me** and **Team**;
- **Only me** selected initially as a presentation default;
- one optional multiline plain-text comment field;
- one primary **Approve** button; and
- one danger-styled **Reject** button.

Clicking **Approve** submits the currently selected policy explicitly. Clicking
**Reject** ignores the presentation selection and submits no policy. Merely
rendering or changing the selector does not approve the item or bind a policy.
The optional comment is durable action/audit context and is not automatically
released as meeting knowledge.

Delegation remains behaviorally out of V1. When it is added, **Delegate** must
be a real Block Kit button that opens an assignee-selection flow. V1 does not
render a dead or misleading Delegate control.

## Retired flow versus private V1

| Stage | Retired shared-channel behavior | Private V1 behavior |
| --- | --- | --- |
| Policy selection | Source-folder metadata selects a policy before the approval card is staged. | Canonical-record policy is unset while approval is pending. |
| Delivery | A card is posted to a configured shared Slack approval channel. | A card is delivered in a private DM to one verified meeting owner. |
| Approval | A reaction confirms the already-frozen policy. | A signed Block Kit action carries an explicit selected policy; the server freezes it with approval. |
| Rejection | No approved record is created. | No approved record or readable policy is created. |
| Canonical write | Approval finalization persists the approved record and its preselected policy. | Approval finalization persists the approved record and the policy selected by the approver in one atomic outcome. |

## Security invariants

- Slack delivery is not approval authority. The server authorizes the actor
  for every command.
- The interaction ingress verifies Slack's signature and freshness before
  acknowledging a Block Kit action. The payload's ECHO actor, policy names,
  and capability claims are never trusted directly.
- The system must prove the candidate is current, a meeting-owner observation
  is verified, the owner resolves to one active organization principal, and
  that principal has a verified Slack identity link. Failure at any point
  leaves the item unassigned and creates no DM or approval capability.
- A pending approval has no canonical readable-policy binding. A UI default is
  not a server-side policy selection.
- The fresh Slack connection contract requires the existing Person-link scopes
  plus `im:write` to open the verified owner's DM and `im:history` to reconcile
  it. A token missing either scope cannot activate the connection.
- Approval must bind the current candidate, authorized actor, selected allowed
  policy, and immutable approved snapshot in one transaction. A stale,
  duplicate, malformed, or unauthorized request is denied.
- The two V1 choices are the existing organization-member-readable policy
  (**Team**) and restricted reviewer policy (**Only me**). A private approval
  binds its restricted readership to the final approver.
- Rejection and any failed proof create neither an approved canonical record
  nor a readable policy fact.

## Implementation boundary

The active clean runtime uses only the private Block Kit path. Founder
onboarding no longer activates, queries, reports, or gates on the retired
shared-channel reaction approval binding. The transitional public Slack
channel remains only for the founder's Person-to-Slack identity-link challenge;
it is not an approval destination.

The pending contract remains immutable with a null canonical policy. Approval
binds policy in the immutable terminal resolution and V4 record; rejection
creates a terminal resolution but no V4 record. There is no preselected-policy
alternate route to canonical publication.

Slack input is a provider subject, never an ECHO actor tuple supplied by the
client. Inside the stable authorization transaction, the server resolves that
provider subject through the current exact external identity link, active
membership, and assignment-scoped capability. The final resolution's approver
must equal the D2 `authorization_allow` actor consumed by the V4 policy
projection. A mismatch denies finalization.

For command retries, durable command lookup precedes current candidate and
assignment-version checks. A recognized completed command returns its durable
outcome idempotently; an unseen command is then subject to the current
freshness and authorization checks.

## Acceptance criteria

1. Given a current candidate with a fully verified meeting-owner-to-active-
   principal-to-Slack-link chain, exactly one private DM is staged for that
   owner and no shared-channel card is staged.
2. Given any missing, ambiguous, inactive, or stale proof in that chain, no DM
   and no approval capability are created.
3. While pending, inspection shows no canonical-record visibility policy.
4. The Block Kit card renders **Only me** as the initial policy, offers exactly
   **Only me** and **Team**, accepts an optional bounded comment, and exposes
   real **Approve** and **Reject** buttons.
5. Approving with either explicit selection writes one immutable approved
   snapshot with the corresponding policy; retrying the same action is
   idempotent and a stale or unauthorized action is denied.
6. Rejecting writes no readable canonical record or policy fact.
7. Focused tests cover the success path and every fail-closed identity,
   linkage, candidate-freshness, and duplicate-action boundary above.

## Non-goals

- Delegation, reassignment, owner recall, or multi-approver/quorum review.
- Shared Slack channels, App Home, email, reminders, threaded discussion, or
  escalation.
- External reviewers, custom policies, or a policy that gives both owner and
  reviewer access.
- Inferring ownership from an attendee, display name, or unverified email.

## Forward-compatible seam for delegation

This V1 deliberately has one fixed assignee. Its command and card contracts
should nevertheless be shaped so a later delegation change can introduce a
`current_assignee` and an `assignment_version` as authoritative server-side
concepts. Those are design seams only: this document does not claim a persisted
schema, a delegation transition, or a second reader today. A future delegation
must transfer authority, invalidate the former card by version, and bind a
private approval to the final approver.

## Rollout gate

This capability starts in DEV and must not be enabled in the current live
runtime from an uncommitted checkout. After the complete private pending,
delivery, finalization, and V4 projection path passes local checks, build one
versioned candidate from a pinned commit and deploy it with an isolated staging
state lineage, database, credentials, logs, and rollback command.

Staging must prove the full flow on that exact artifact: one verified owner gets
one DM; missing or ambiguous proof creates no DM; pending policy remains null;
both buttons, both policy choices, and optional comments have the specified
result; retries do not duplicate cards or records; stale cards fail closed; and
an approved record is readable under exactly the selected policy. Production
promotion may use only those same qualified bytes after the staging evidence is
reviewed. Existing V1 state is not mutated in place or silently carried into
the private lane.
