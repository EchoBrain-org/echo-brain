---
schema_version: 1
id: ADR-0015
kind: decision
title: Global and project-scoped Person Ask over authorized evidence
component_ids:
  - CMP-PERMISSIONS
  - CMP-PERSON-CLIENT
  - CMP-ORGANIZATION-AUTHORITY
created_at: 2026-09-23
reviewed_at: 2026-09-23
reviewed_ref: 6c4e8c80c4c67d0a8c15dbf3a374d75067dba8fa
status: accepted
supersedes: []
superseded_by: []
updates:
  - ADR-0007
  - ADR-0013
  - ADR-0014
---

# ADR-0015: Global and project-scoped Person Ask over authorized evidence

## Context and disposition

The founder selected global Ask with optional project scope on 2026-09-23,
removed the requirement for a separate file browser, and authorized implementation.
The inspected baseline in `reviewed_ref` is not a qualified implementation.
PR approval, installed-client acceptance, and deployment remain separate.

## Scope and evidence

Global Ask considers relevant evidence the current Person may read: personal,
organization-shared, and joined-project originals, plus approved records.
Project Ask additionally requires current project membership and authoritative
association of each source with that project. It never silently falls back to
global context. Project names in text are not associations. Approved records
without a project association are eligible only globally.

Project scope includes the current person's related personal context. For this
round, the explicit project association defines relatedness: the person's own
only-me notes or documents associated with the selected project are eligible;
unassociated personal material and unrelated organization or other-project
material are excluded. Broader relevance rules belong to the next search and
answer refinement and must not widen another person's private audience.

Audience and association remain independent. Project-associated only-me content
stays private. Shared context survives its contributor's departure; removed
readers lose access and newly authorized members gain access to history.
Original-context retrieval admits saved Person text and usable document
extraction. Generic source admission alone does not grant access to raw meeting
snapshots or pending approvals.

The new versioned transport carries optional project scope and returns that
scope. Existing approved-record-only clients retain their old contract.
Identity and grants come from the current session, never planner/source/model
text. Each submitted question and answer retain their original scope even if
the user navigates while the request runs.

## Released evidence and composition

ADR-0007's bounded workflow remains: original question plus at most three planned
queries, one request-local released batch, and at most one answer call. Layer 3
combines authorized record retrieval with an original-context retrieval port.
Adapters own storage access; the answer core receives released contracts only,
without database, source repository, or provider handles. There is no agent
loop, cross-request memory, query-triggered indexing, or automatic semantic
ingestion.

Authorization precedes model-context release. Before returning an answer,
revalidate the current Person, selected project, and every source supplied to
the model, including uncited sources. Changed or revoked grants/associations
fail closed. Audits bind the exact released evidence and selected scope.

Citations distinguish approved records from source revisions and identify the
immutable original/revision and derived representation actually used. Originals
never acquire counterfeit record identities. The model may cite only its exact
released evidence. Opening a source applies current authorization again and
must not silently substitute a newer revision.

Answers distinguish source statements from approved decisions and acknowledge
insufficient or conflicting evidence. Asking about an upload does not approve
it or trigger decision/action extraction or publication. ADR-0014's requested-only
analysis and human approval rules remain intact.

## UI and people selection

Remove Find saved context without a replacement file browser. Show the active
Ask scope and submitted question; clear valid submissions, preserve invalid
input, and prevent silent replacement of a running request. Persistent chat
history and conversational memory remain outside this refinement.

Project leads select from a bounded, paginated directory of active organization
members, including owners. Show names only; professional metadata is deferred.
Add preserves an existing member's role, even for stale selections. Intentional
role changes remain distinct. Remove the organization People sidebar row while
retaining owner administration in the menu bar.

## Verification and release

Required proofs cover cross-person denial, independent audience/association,
revocation/dissociation during generation, uncited-source revocation, exact
citation provenance, no raw-meeting bypass, document-only corpora, evidence late
in extraction, missing/partial extraction, bounded retrieval, invalid citations,
scope binding, submission, directory pagination, and role-preserving Add.
Boundary tests cover the new release path.

This decision does not reset data, deploy, or install a client. Implementation
evidence and limitations belong in the PR and feature documentation. Claude's
separate navigation/draft reversibility patch requires its own integration and
verification. This feature does not add Undo of completed uploads or approvals.
