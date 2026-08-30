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
reviewed_at: 2026-08-13
reviewed_ref: 808ac89eaf3e8eba529b356bd80d4509b9a2a293
normative: MUST
enforcement_status: partial
enforcement_scope: Bounded Slack reviewer and organization-member approval modes only
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

The bounded Slack paths enforce this rule, and focused founder-live evidence
observed the second actor receiving no unintended result. That receipt is not
yet promoted into an exact qualification report, and this is not a global role
or delegation system.
