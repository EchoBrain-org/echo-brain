---
schema_version: 1
id: ADR-0031
kind: decision
title: One meeting approval core with optional surfaces
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-MEETING-PROCESSING-CORE
  - CMP-PERMISSIONS
  - CMP-PERSON-CLIENT
created_at: 2026-10-07
reviewed_at: 2026-10-07
reviewed_ref: 57b31260209293a7da7822ff46e82a2beb3c887e
status: proposed
supersedes: []
superseded_by: []
updates:
  - ADR-0017
  - ADR-0021
  - ADR-0030
---

# ADR-0031: One meeting approval core with optional surfaces

## Context and options

Meeting approval runs as two separate lanes that share only extraction and the
record log:

- The desktop lane (ADR-0030) reviews a person's imported Granola meetings in
  the app. It allows one project, signs extraction-proposed owners into the
  snapshot, and writes its own record reference.
- The Slack lane reviews meetings from the organization source (source key
  `'1'`), which has no production input; only the staging canary, the
  synthetic-demo fixtures and the evaluation harness feed it. It keeps signed
  receipts in the control plane and its own record writer and references.

Nothing stops one meeting from being approved in both lanes, and the same note
imported into two projects is extracted and reviewed twice.

Options considered:

1. **Keep both lanes and add a cross-lane check at the record log.** Smallest
   change, but two proposal stores, two decision paths and two proof formats
   remain, and a race still needs a second backstop.
2. **One approval core; desktop and Slack are surfaces on it (chosen).** One
   proposal per meeting, one decision table where the first decision wins, one
   publisher and one proof format.
3. **Slack as the core, desktop as a viewer.** Rejected: most people have no
   Slack link, and the desktop must work alone.

## Decision and consequences

Adopt option 2, as specified in
[unified meeting approval v1](../product/2026-10-07-unified-meeting-approval-v1.md):

- Every meeting enters through a person, who reviews it. The organization
  meeting source is removed; staging uses a synthetic personal source.
- One source per person and tool account; one proposal per meeting per
  reviewer. Project choices at import are suggestions frozen on the proposal.
- `decide()` writes one row per proposal in `authority_approval_decisions_v1`;
  the unique approval id makes the first decision win across surfaces.
- One publisher appends the record with a neutral reference,
  `echo-approval-decision-ref-v1`, and runs after-record hooks in the same
  Authority transaction as the receipt, so each hook runs once per record.
- Audience is Only me or one to twenty projects (ADR-0017's audience equals
  association rule unchanged). The Team option leaves the Slack card.
- Owners follow ADR-0021 on both surfaces: the snapshot carries none; each
  grounded proposal is a pre-filled field the approver confirms; the reference
  records confirmed owners in `action_owners`.
- Slack is an optional plug-in: a DM copy for reviewers with a link, tracked
  in `authority_approval_presentations_v1`, whose verified clicks call
  `decide()`.
- ADR-0030's personal custody, consent and grant rules stay. Its in-app review
  module and its statement that historical Slack record codecs stay readable
  are replaced: the in-app V1 and Slack V1 to V3 codecs and projectors are
  removed together with the state that held such records.

Consequences: about 15,000 lines of lane-specific code and tests go; the
desktop and server must ship together (meetings API `schema_version: 2`).

## Migration, rollback, and evidence

- Fresh state only: Authority baseline V12 and control-plane baseline V4, with
  an empty record log. No migration reaches them; staging is reset by the
  founder's existing replace-rehearsal procedure.
- Rollback is the previous image on its own retained state; this state cannot
  be read by older images.
- Evidence: the acceptance tests in the spec (cross-surface race, one meeting
  in two projects, supersession before and after a decision, crash recovery,
  exact owners, refusals, desktop-only start), unchanged Ask goldens, and the
  founder's staging rehearsal.
