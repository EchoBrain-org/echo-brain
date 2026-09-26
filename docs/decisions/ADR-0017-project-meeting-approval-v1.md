---
schema_version: 1
id: ADR-0017
kind: decision
title: Project audiences and explicit transcript release for meeting approval
component_ids:
  - CMP-PERMISSIONS
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-PERSON-CLIENT
created_at: 2026-09-26
reviewed_at: 2026-09-26
reviewed_ref: b22b18337c2fb388e62336a866553a18c1c32c46
status: accepted
supersedes: []
superseded_by: []
updates:
  - ADR-0013
  - ADR-0014
  - ADR-0015
---

# ADR-0017: Project meeting approval V1

## Decision and scope

On 2026-09-26 the founder authorized minimum lean V1 in an isolated worktree,
explicitly requiring an expansion of the existing system and invariant design.
This accepts implementation of the following contract, not a deployment.

The existing private owner approval card adds Projects to Only me and Team.
Projects selects one to twenty of the approver's current projects. The existing
Authority project membership state supplies IDs, grant-tenure IDs and bounded
display names before the card is frozen. The pending contract retains those
eligible choices. A tap must select a canonical subset and reprove each selected
grant, including its project-membership ID, under the existing approval fence.
Removing and re-adding the approver cannot revive a stale card's grant. An
unrelated project grant change does not invalidate the selected choices.

Approval binds `project-members-readable-person-v1`: active organization members
with an active grant in any selected audience project may read the record.
The selected project IDs are intent; current readers are never frozen. Joining
grants history; leaving all audience projects removes access. The existing
single verified owner remains the only approver.

The pending V2 delivery contract is frozen in the existing Authority outbox
before the first Slack operation. A restart reuses those choices and source
coordinates without relisting projects. The static picker supports up to one
hundred eligible projects; an unrepresentable complete card follows the existing
delivery quarantine path. A person with no projects retains Only me and Team.

Audience and association remain separate facts. Lean V1 seeds both sets from
the Projects selection. Only me and Team retain empty associations in this card
version. Project Ask requires current membership in its selected project, an
explicit record association, and a currently satisfied audience. Old unassociated
records remain global-only. This extends ADR-0013's previously excluded record
association through the existing record facts and scoped retrieval path.

Share transcript defaults off. When enabled, the same human action explicitly
authorizes an exact retained source revision and hash under the record's audience.
Transcript sharing is distinct from approving the extracted facts. A versioned
operation in the existing Layer 3 source-release boundary provides a bounded
authenticated transcript read with current audience checks, exact provenance,
final revalidation and minimized audit. Missing approval, rejection, a disabled
toggle, or a mismatched source revision releases nothing. Admission alone never
grants this path. Automatic raw-meeting search or Ask ingestion is outside V1.

## Reuse and invariant trace

The existing source tables retain transcript content. The existing Slack adapter
owns the picker and signed interaction; provider-neutral commands own the selected
policy and consequence. Existing approval persistence, finalization, append-time
policy facts, immutable search generations, Person sessions and release audits
remain the enforcement machinery. There is no additional approval service,
membership mirror, source store, authorization engine or search pipeline.

- INV-02 and INV-09: retain policy intent and project IDs, not resolved readers;
  recording and project association alone confer no access.
- INV-12 and INV-PERMISSIONS-014: bind actor, exact draft, selected projects,
  transcript revision, displayed consequence and signed action before append.
- INV-01, INV-07, INV-11A and INV-11B: derive append-atomic text-free facts and
  authorize both audience and project association before scoring, statistics,
  adjacency or model access.
- INV-03 and INV-04: hidden records expose no title, project list or count;
  positive access follows the explicit current-project membership policy.
- INV-05, INV-06, INV-10 and INV-PERMISSIONS-015: retain current-Person checks,
  exact release evidence, fail-closed final fences and audit-before-bytes.
- INV-PERMISSIONS-013 and INV-ADAPTERS-005: old frozen pending contracts and
  signed records keep their original interpretation; provider grammar stays
  behind its adapter and historical projectors remain available.

The existing separate database owners and recovery ordering remain intact.
Record facts are co-committed with their record; the workflow does not claim a
cross-database atomic transaction. Raw transcripts remain in Authority custody
and are not embedded into the canonical approved decision package (AD-04/AD-06).

## Compatibility and verification

New approval shapes are versioned. Historical card bytes, policy hashes, codecs
and pinned SQL baselines remain unchanged. New immutable baseline/generation
versions describe the added record policy facts. Startup must reject unsupported
state instead of silently migrating or resetting it. An installed-state upgrade
requires a separately reviewed offline operation.

Fresh state uses Authority V10, record-log V4, retrieval facts V3 and retrieval
content/lexical V2. Older pinned baselines remain available for verification.
The direct read is exposed as `POST /v1/person/meeting-transcripts/read` and
`echo transcript`, using the approval ID and exact source coordinates from the
readable record. It works independently of optional Ask model configuration.

Focused proof must cover forged/out-of-set choices, empty project selection,
remove/re-add between stage and tap, duplicate/conflicting retries, old pending
cards, exact policy and source binding, audience union, project association,
cross-person denial, revocation before final response (including uncited model
evidence), transcript-off and rejected/pending meetings, incorrect revision,
and audit failure. Existing approval/restart, source-release and architecture
tests remain part of the full repository check. Live rehearsal remains separate.

The existing fixed synthetic staging canary retains its V1 card: its invented
meeting is not admitted into source custody and cannot grant transcript release.
Real meetings lacking the exact retained source fail closed before provider I/O;
they never fall back to the synthetic or historical path.
