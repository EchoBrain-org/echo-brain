---
schema_version: 1
id: INV-PERMISSIONS-014
kind: invariant
title: Approval authority is independent from source custody
component_ids:
  - CMP-PROCESSING-ADAPTERS
  - CMP-IDENTITY-ACCESS
  - CMP-PERMISSIONS
created_at: 2026-08-13
reviewed_at: 2026-10-11
reviewed_ref: 3aea847cca4fa44cfa1ab28dbf44b1b707590b8b
normative: MUST
enforcement_status: partial
enforcement_scope: Approval core decide() (frozen reviewer, active membership, project recheck) on desktop and Slack; Slack clicks checked against the identity link
invariant_ids:
  - INV-12
---

# INV-PERMISSIONS-014: Approval authority is independent from source custody

## Statement

The account or installation that holds source custody MUST NOT implicitly gain
approval authority. Approval binds the frozen provider actor to the enrolled
central principal and membership authorized for that exact consequence.

## Scope and failure behavior

Another member's action is a no-op or closed denial and cannot advance the
cursor, publish a record, or become evidence for the intended actor.
Permission mode can change the read audience; it does not delegate approval.

## Enforcement and verification

The approval core's `decide` carries this rule on every surface. It accepts a
decision only from the proposal's frozen reviewer with an active membership in
the same organization, and rechecks every chosen project
(`services/organization-authority/test/approval-core-v1.test.ts`: an actor from
another organization, a revoked reviewer and a non-reviewer are denied). A
Slack click is decided only after it matches the posted card and the clicker's
current identity link
(`services/organization-authority/test/slack-approval-click-v1.test.ts`).
[ADR-0031](../decisions/ADR-0031-unified-meeting-approval-core.md) makes the
person who brings a meeting in its reviewer by explicit rule, so review
authority comes from that rule, not from holding the source.

Earlier focused internal-dogfood evidence on the retired bounded Slack paths
observed the second actor receiving no unintended result. That receipt was
never promoted into an exact qualification report, and this is not a global
role or delegation system.
