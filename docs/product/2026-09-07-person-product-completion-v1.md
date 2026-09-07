# Person product completion V1

Status: implementation sprint in progress; no new release accepted.

## Outcome

People can install ECHO, return to an existing account, switch accounts, manage
employee invitations as an owner, and inspect an answer's approved sources
without using Terminal. The same app serves owners and employees; the Authority
continues to authorize every request.

## Scope

1. Complete Account in the installed app and graphical setup: Google sign-in
   for an existing identity, invitation onboarding, account status, confirmed
   sign-out and account switching. Remember only a successfully used organization
   HTTPS origin as a convenience; it does not establish trust or membership.
   Require an authenticated permission-aware read before showing ready.
2. Complete People feedback: distinguish known input, membership, access and
   invitation-save failures from unknown remote outcomes. Do not retry an
   uncertain mutation automatically. Label a redeemed invitation **Onboarded**,
   not **Signed in**. An existing active member signs in again; owners reissue
   only pending or expired invitations.
3. Expose Sources on an answer: retain validated citation references, fetch an
   exact cited record through the current Person authorization boundary, and
   show its readable meeting title and approved decisions, actions and rationales.
   Missing and unreadable sources must not disclose existence. Clear prior
   answer/source content across account transitions and loss of access.

## Boundaries

Reuse the Person client and session store. No new daemon, admin build, browser
admin service, release channel, background polling, or account store. Preserve
runtime workers, processing, Slack approval behavior, visibility policies,
telemetry, logs, alarms, evaluations and capacity checks. Source reads retain
their existing audit requirements. Deployment and acceptance remain in the
operator playbook.

Slack identity linking and personal ingestion exclusions are later product
surfaces, outside these three priorities. This sprint does not add automatic
email delivery, silently correct an invitation address, or loosen server-side
owner authorization.

## Acceptance

- Existing identities sign in from setup or the installed app without a new
  invitation or terminal. First-time identities still need an invitation.
- Sign-out/account switching requires the person's action. Failed or cancelled
  login does not claim readiness, replace another account silently, or expose
  a grant, token or authorization URL in the UI or diagnostics.
- A submitted People mutation blocks account switching until its outcome is
  handled; stale private results never appear under another identity.
- Known invitation rejections show a specific safe next step. Transport,
  timeout and malformed/ambiguous results retain explicit uncertainty.
- Sources are tied to the current answer, fetched on demand, readable and
  bounded. The exact source can be older than the latest record page; an
  inaccessible source is withheld under current server permissions.
- Focused regressions reproduce before implementation and pass afterward;
  native macOS compilation and the full repository check pass. Packaging binds
  every new native source to the same committed release source.
- Live graphical and staging validation are recorded separately from offline
  checks. No existing candidate is promoted as a side effect of this sprint.

## Work lanes

Platform-neutral CLI/API implementation uses the repository's Codex Cloud lane.
Native macOS implementation and offline native proof use isolated local
worktrees. Integration and final review happen on `sprint/person-product-completion`.

## References

- [Person client architecture](../architecture/person-client-architecture.md)
- [Lean employee onboarding](2026-09-07-lean-employee-onboarding-v1.md)
- [Authority operator playbook](../operations/PB-OPERATIONS-001-authority-operator-lane.md)
