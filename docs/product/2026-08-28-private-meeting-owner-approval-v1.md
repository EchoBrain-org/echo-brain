# Private meeting-owner approval V1

**Status:** implemented and locally verified. Staging, qualification, and
production deployment remain separate gates.

## Decision

ECHO delivers each pending meeting decision as one private Slack Block Kit DM
to the verified meeting owner. The card has real **Approve** and **Reject**
buttons, an optional comment, and an explicit policy choice: **Only me**
(default) or **Team**.

A pending candidate has no canonical-record visibility policy. Approve binds
the selected policy atomically with the canonical record; Reject creates no
readable record or policy fact. The server, not Slack card values, reproves the
current candidate, owner identity link, membership, and authorization for every
action. Duplicate, stale, malformed, and unauthorized actions fail closed.

## Scope

- One verified owner, one private DM, one explicit terminal action.
- **Only me** means the final approver, which is the meeting owner in V1.
- The existing public `slack_approval_channel_id` remains only for founder
  identity linking; it never receives approval cards.
- Re-onboard the same Slack app with `im:write` and `im:history`, stage its
  signing secret privately, and configure Interactivity only after the active
  runtime prints its URL. The approval-card canary is the proof.

Delegation, reassignment, shared channels, App Home, reminders, external
reviewers, custom policies, and multi-approver review are out of scope. V1 does
not render a Delegate control.

## References

- [Control-plane architecture](../architecture/organization-control-plane.md)
- [Onboarding and rollout](2026-08-22-organization-onboarding-and-employee-rollout-v1.md)
- [Authority deployment runbook](../../deploy/organization-authority/README.md)
