---
schema_version: 1
id: ADR-0029
kind: decision
title: Project-scoped capture and exact derivation inputs
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-PERMISSIONS
created_at: 2026-10-03
reviewed_at: 2026-10-03
reviewed_ref: df1902c49c1ca1ee1d6f4c884fa3be8097594e23
status: proposed
supersedes: []
superseded_by: []
updates:
  - ADR-0014
  - ADR-0028
---

# ADR-0029: Project-scoped capture and exact derivation inputs

## Context and options

The founder requested one capture path for all context sources, with Person,
Content and Action domains scoped by project. Useful source observations enter
Layer 1; Layer 2 derives from them and, eventually, authorized usage evidence.
Layer 3 remains the permission-aware Evidence Desk that Layer 4 searches.

Steps 1 and 2 implement the shared schema and internal intake/derive handoff.
Provider activation and public capture release are separate work. This proposal
extends [ADR-0028](ADR-0028-broadened-layer-1-source-captures.md); it does not
rewrite accepted record, document or meeting release boundaries.

## Decision and consequences

Reuse the existing immutable source and representation tables. A new database,
queue or projection engine is unnecessary for this foundation.

- The outer source envelope identifies the adapter, original item, exact revision,
  content digest and predecessor. The V2 inner capture carries typed content,
  source people references and literal action observations. Mention/action evidence
  must match exact retained passage spans. Source metadata can identify authors,
  speakers, reporters, creators, participants and assignees without inventing a
  quotation; speaker attribution names the retained passages it describes.
- Authority supplies one project and optional verified Person bindings separately.
  Project association grants no access. Unknown source actors remain unresolved;
  capturing a mention never creates a Person, membership or identity link.
- Classification names its exact input and versioned producer/configuration.
  `retain` is a usefulness decision, not retention consent. `skip` and `unresolved`
  return without storing the body or a durable receipt. Retained content and its
  classification/binding annotation commit atomically, including on replay.
- Before retention and every derive snapshot, a synchronous Authority port checks
  current custody, permitted representation, project association, identity witnesses
  and processing eligibility in the same transaction. The store additionally checks
  the active project and each Person's organization membership. An annotation is
  historical provenance, never a current grant. No production implementation of
  this policy port or provider binding selector is installed by this change.
- Derivation explicitly selects source/revision/content digest and annotation ID.
  The bounded, frozen snapshot verifies those commitments and has a stable digest.
  Binding/classifier changes create a new annotation, leaving source bytes intact.
  Typed outputs separate inferred/deterministic Person, Content and Action claims
  from observations and bind every claim to selected evidence. They cannot mint
  approval; approved human acts remain in the signed record log.
- `previous_revision_id` links retained revisions. An explicit upstream deletion
  is a body-free tombstone with source time and a retained predecessor. A failed
  read, missing poll result, 403 or 404 is not sufficient deletion evidence.
  Tombstones cannot be derive inputs. This is historical selection, not current-head
  selection: annotations do not implement expiry, erasure or global suppression.
  The current-policy port must reject withdrawn inputs, even when an older retained
  annotation is selected. Provider branches must not activate until that policy is
  implemented and tested for their source.

## Migration, rollback, and evidence

V1 contracts and installed paths remain unchanged. No baseline or migration is
needed. The new API accepts V2 captures only; existing document/meeting custody
keeps its native schema until an explicit mapping preserves its approval boundary.
No provider I/O, model calls, automatic analysis, usage collection, Layer 2 indexing,
Evidence Desk or Ask activation is included. Derived output persistence/scheduling
is deferred; this slice validates its schema and exact evidence inputs.

[Contract tests](../../packages/organization-processing/test/core/context-capture-v2.test.ts)
and [SQLite integration tests](../../services/organization-authority/test/capture-foundation-v1.test.ts)
cover evidence fidelity, closed schemas, replay after restart, skipped-body absence,
transaction rollback, current authorization and stored integrity. Live validation
is deferred until provider composition exists.

After this contract is reviewed and merged, Slack, Jira and Granola mappings can
use separate worktrees. Each owns its provider files and fixtures; shared Authority
policy/composition stays with one integrator. Each adapter must emit deterministic
V2 observations, preserve original source references, select an explicit project,
and pass the common custody/derive tests before activation. Usage and search remain
later stages.
