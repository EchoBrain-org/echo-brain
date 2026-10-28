---
schema_version: 1
id: ADR-0044
kind: decision
title: Search rebuilds make no model call; the related-atom projection is removed
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-PERMISSIONS
created_at: 2026-10-20
reviewed_at: 2026-10-27
reviewed_ref: 1adfdf1e15a74a284443a1d66e6f54f8020ca770
status: accepted
supersedes:
  - ADR-0010
superseded_by: []
updates: []
---

# ADR-0044: Search rebuilds make no model call; the related-atom projection is removed

## Context and options

[ADR-0010](ADR-0010-disposable-related-atom-projection-v1.md) let the
Authority ask a model, while rebuilding the search generation, to link
approved facts across meetings. It was built so that a one-shot answer writer
could reach the later decision, action or rationale behind a result. For each
visibility group whose newest facts (at most 200, and 192 KiB) spanned two or
more records, the rebuild sent them to the background model port and stored
the validated cross-record pairs in the generation. Desk open read them back
through `expandReadableSearchRelatedAtomsV1`.

A 2026-10-20 audit of code that exists only to make up for the model found
the feature dead:

- **Nothing reads the links.** The V1 Ask answer packets read them until
  `bc6a9b6` retired V1 and V2 Ask on 2026-09-28
  ([ADR-0022](ADR-0022-agentic-ask-only.md)). Since then desk open has been
  the only reader, and it has kept only items from the anchor's own record
  since it was added in `298ebfd`, so no cross-meeting link reached Ask or a
  person. The expansion also ranked the anchor's own record ahead of every
  link, so the links never changed which items an open showed.
- **Its consumer is gone.** Ask is agentic
  ([ADR-0019](ADR-0019-agentic-ask-v1.md),
  [ADR-0022](ADR-0022-agentic-ask-only.md)) and reaches related records with
  its own searches, lists and opens.
- **It still costs.** A rebuild made a model call for each visibility group
  of two or more records whose newest facts the process had not projected
  yet, so every group after a restart. A failed or timed-out call failed the
  rebuild, so new approvals waited for a retry to become searchable. When it
  failed in the startup rebuild, which runs before the API binds, the
  Authority did not start.

Options:

- **A. Feed the links to Ask.** Ask already finds related records itself; this
  keeps a model call per rebuild to save it steps it can take.
- **B. Keep the projection but stop its failures blocking a rebuild.** That
  keeps a model call and its code for links nobody reads.
- **C. Remove the projection.**

## Decision and consequences

Option C.

- A search rebuild reads approved records only and makes no model call. The
  retrieval contract has no projector section, and the Authority runtime
  passes search no model port.
- Desk open shows the anchor, then up to nine more items of the anchor's own
  record. It reads them with a list for the same reader and project, narrowed
  to that one record, which the anchor read has already admitted, under mine
  too. They come in the record's own order: decisions, actions, then
  rationales. The items, the ten-item cap and the `truncated` and
  `anchor_truncated` flags are what they were.
- The generation no longer stores pairs. The segment manifest drops
  `related_atom_pair_count`, the facts roots return to their pre-ADR-0010
  definitions (`clean-readable-search-facts-root-v1` and
  `clean-readable-search-generation-facts-root-v1`), and the admission budget
  drops `maximum_related_atom_pairs`.
- The facts plane baseline V3 stays byte for byte. Its
  `retrieval_related_atom_pair` table remains, always empty, because the
  state-lineage guard checks every stored generation's facts plane against
  that file's digest.
- The `search_enrichment` and `related_projection` observation phases, and
  the counts only the projection reported, are retired.

Layer 3 remains the only content-release boundary
([INV-PERMISSIONS-015](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md)),
and building the readable-search generation no longer involves a model.

## Migration, rollback, and evidence

No reset and no operator step. The Authority's startup check and
`update-clean-v1.sh` verify stored generations against the unchanged
baselines, so existing state still opens. The retrieval contract digest
changes, so the startup rebuild finds the stored pointer under the old
contract and publishes a new generation from the record log before the API
binds. Old generation directories stay on disk, as they did before.

Rollback is a revert. The older artifact sees a contract it does not know and
rebuilds again, with its model call.

Evidence, from the change that made this decision: desk-open tests that pin
the items, order and flags passed before and after the removal. Before it,
with every cross-record pair of each visibility group stored, the old
expansion returned eight other-record items for an anchor and desk open
dropped all eight. A state written by the old code, with a pair-holding
generation active under the projector contract, passed the lineage guard
under the new code, which then published a new generation and reported it
current.
