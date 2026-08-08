# Organization brain direction

**Status:** Direction, not current implementation. The append/derive half is
designed in
[2026-08-07-org-decision-record-append-derive-design.md](2026-08-07-org-decision-record-append-derive-design.md).

The organization brain is a trusted log of accepted organization records with
replaceable ways to search and reason over them. Slack and MCP are interfaces,
models are reasoners, and indexes and embeddings are rebuildable projections.
None is the brain itself.

```text
signed approved records
  -> organization ingest
  -> immutable organization log
  -> rebuildable retrieval
  -> authorization filter
  -> model with citations
  -> user interface
```

## Design choices

- Raw-source custody remains local by default. Shared records contain approved
  signals and bounded evidence, not whole transcripts or vendor payloads.
- One approved decision, action, rationale, or future alternative is the query
  atom. Approval-group provenance keeps related atoms connected.
- History is append-only. Corrections, supersession, and publication changes are
  new linked events rather than edits to accepted records.
- Approval, delivery, organization ingest, and retrieval are separate acts.
- Identity is explicit. Participants are observations until a later resolution
  binds them to an organization principal.
- Claims require evidence, but optional reasoning stays optional. The system
  must not encourage a model to invent alternatives or rationale merely to fill
  a template.

## Permission boundary

Audience, sensitivity, retention, and payload scope travel with the approved
record as intent markers; resolved access is never stored on records and is
computed at read time against current membership. Retrieval is default-deny and
filters records before any model receives context. Bounded evidence inside the envelope shares that policy, and queries
are auditable.

Exact audience tiers, group rules, participant access, administrative override,
and access to separate delivery or organization-ingest receipts remain
undecided. They should be chosen from real multi-user use rather than assumed
now.

## Sequence

Trusted capture comes before sophisticated retrieval. Enrollment, signed
records, organization ingest, receipts, and revocation establish trustworthy
input. Search technology, embeddings, entity resolution, deduplication, model
choice, and query surfaces remain replaceable later decisions.
