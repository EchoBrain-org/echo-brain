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
  source people references and literal action observations. Mentions must cite
  exact retained passage spans. Status observations and derived claims may also
  cite permitted typed payload fields.
  Derived field citations name an exact source and revision and resolve against
  the selected snapshot; pointers therefore support metadata facts without
  inventing passages. A current status is `status_observed`, not proof of a
  `status_changed` event. The latter still needs observed event evidence; comparing
  revisions requires both selected revisions. Source metadata can identify authors,
  speakers, reporters, creators, participants and assignees without inventing a
  quotation; speaker attribution names the retained passages it describes.
- Document payloads preserve media type and optional filename/path. Common provenance
  names an exact external container and an optional opaque upstream version/ETag.
  An optional original-artifact descriptor reuses `SourceArtifactReferenceV1` and
  must match the envelope's artifact reference exactly. Original bytes stay in
  existing artifact custody; Authority must verify that custody during both retain
  and derive. A descriptor supplies no access and initiates no download.
- Authority supplies one project and optional verified Person bindings separately.
  Project association grants no access. Unknown source actors remain unresolved;
  capturing a mention never creates a Person, membership or identity link.
  The configured container scope maps exact external container references to ECHO
  projects within one organization and binds each to an exact adapter ID/instance
  (independent of implementation version). It permits multiple containers and payload kinds
  in one adapter; duplicate/ambiguous mappings, unlisted containers and mismatched
  adapter instances fail closed.
  The store freezes this configuration, then rechecks the current mapping through
  Authority for each retain/derive operation. Configuration is not a continuing grant.
- Source references use canonical `<tool>:<tenant>:<kind>:<id>` strings with encoded
  opaque tenant/ID components. Stable actors may name another tenant of the same
  tool (for example, a Slack Connect author); the reference is metadata, not
  permission to read that tenant. Threads and source-local actors must remain in
  the container namespace. Verified Person linking still requires the exact full
  actor reference and current Authority identity witness.
  Stable upstream accounts use `actor`; unresolved speakers use `local-actor` with
  the exact canonical source-ID digest plus a deterministic local-ID digest. The
  envelope validator checks that source commitment, including adapter instance.
  Names alone cannot distinguish two participants, and a local reference cannot
  become a verified Person binding in this contract. Verified Authority identity links establish cross-source identity.
- Classification names its exact input and versioned producer/configuration.
  Only `local_rules` classification is accepted: pure local deterministic rules,
  with no model, network or paid processing. Callers must already have permission
  to acquire and inspect the selected source representation. This marker does not
  establish that permission, and the later retention check cannot authorize work
  already performed. A future model classifier must obtain processing authorization
  for its exact producer/configuration and representation **before invocation**,
  then recheck permission before retaining anything.
  `retain` is a usefulness decision, not retention consent. `skip` intentionally
  stores no body. `unresolved` is a nonterminal retry, never a successful checkpoint.
  `unresolved` returns only a body-free exact retry reference with
  `cursor_may_advance: false`; neither result currently has a durable receipt. A provider must stop/replay an
  unresolved item and may not advance its cursor until a body-free review receipt
  and checkpoint can commit atomically. There is no poller or cursor in this PR.
  Retained content and its classification/binding annotation commit atomically,
  including on replay. These immutable annotations deliberately live beside
  Layer 1 as intake provenance: they record why/how custody was accepted, not
  source truth or derived Person/Content/Action facts. Derivation cannot cite a
  classifier annotation as source evidence. Changing a decision creates a new
  annotation; it does not rewrite the original source. Immutability does not
  implement retention expiry or erasure.
- Before retention and every derive snapshot, a synchronous Authority port checks
  current custody (including any original artifact), permitted representation,
  adapter/container-to-project association, identity witnesses
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
- `previous_revision_id` links retained revisions. The builder takes an exact prior
  envelope selected by Authority. An unchanged observation reuses its revision and
  original predecessor, including across adapter upgrades; a changed observation
  links to that prior revision. Admission rejects a fabricated identical-content
  successor. An immediate transaction rejects a second distinct successor for the
  same organization/source/predecessor, and rejects a second root after that source
  is retained. Exact revision replay remains valid. A stale
  predecessor must be reread and retried. This prevents forks through V2 intake;
  it does not elect a global current head or change V1 admission.
  Upstream version IDs are opaque observations, not ECHO revision IDs
  or a generic ordering key; poll timestamps never select a predecessor. Durable
  checkpoints, current-head selection and scheduling remain separate work.
  An explicit upstream deletion
  is a body-free tombstone with source time and a retained predecessor. A failed
  read, missing poll result, 403 or 404 is not sufficient deletion evidence.
  Tombstones cannot be derive inputs. This is historical selection, not current-head
  selection: annotations do not implement expiry, erasure or global suppression.
  The current-policy port must reject withdrawn inputs, even when an older retained
  annotation is selected. Provider branches must not activate until that policy is
  implemented and tested for their source.

## Migration, rollback, and evidence

V1 contracts and installed paths remain unchanged. No baseline or migration is
needed. The new API accepts V2 captures only. Existing Jira, Slack and Granola
outputs are not V2-compatible: each needs an explicit mapper for the new reference,
container, classification and binding contracts before it can enter this path.
A provider can activate independently once its mapper and current policy checks
pass; this PR activates none of them. Existing document/meeting custody
keeps its native schema and approval boundary. Remote document metadata and accepted
original-artifact descriptors can be mapped into V2 without duplicating blob storage.
No provider I/O, model calls, automatic analysis, usage collection, Layer 2 indexing,
Evidence Desk or Ask activation is included. Derived output persistence/scheduling
is deferred; this slice validates its schema and exact evidence inputs.
V2 validates its own identity, provenance and lifecycle directly. It reuses the
explicit payload/representation validators for inherited shapes, without
constructing a synthetic V1 envelope or disguising documents as notes.

[Contract tests](../../packages/organization-processing/test/core/context-capture-v2.test.ts)
and [SQLite integration tests](../../services/organization-authority/test/capture-foundation-v1.test.ts)
cover evidence fidelity, closed schemas, replay after restart, skipped-body absence,
transaction rollback, current authorization and stored integrity. The
[connector contract tests](../../packages/organization-processing/test/core/capture-connectors-v2.test.ts)
add document descriptors, heterogeneous containers/kinds, namespace isolation and
replay-safe lineage; [reference tests](../../packages/organization-processing/test/core/capture-source-ref-v1.test.ts)
cover canonical encoding and source-local identity separation. Live validation
is deferred until provider composition exists.

Connector implementations should normalize each provider response once and produce
separate capture/live projections. Each projection retains its permission and
completeness checks. Shared HTTP/Nango helper extraction, retries, incremental pulls
and webhooks are follow-ups, not part of this contract amendment.

After this contract is reviewed and merged, Slack, Jira and Granola mappings can
use separate worktrees. Each owns its provider files and fixtures; shared Authority
policy/composition stays with one integrator. Each adapter must emit deterministic
V2 observations, preserve original source references, select an explicit project,
and pass the common custody/derive tests before activation. Usage and search remain
later stages.
