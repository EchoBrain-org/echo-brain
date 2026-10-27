---
schema_version: 1
id: ADR-0043
kind: decision
title: The Ask receipt counts every item research looked through
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-PERMISSIONS
  - CMP-PERSON-CLIENT
created_at: 2026-10-19
reviewed_at: 2026-10-19
reviewed_ref: afde76a0c6304d068ca220317ab3d7f731c1e8dc
status: proposed
supersedes: []
superseded_by: []
updates:
  - ADR-0039
  - ADR-0042
---

# ADR-0043: The Ask receipt counts every item research looked through

The founder asked on 2026-10-19 for the receipt to say plainly what Ask
looked at. The
[research tool contract design](../product/2026-10-19-research-tool-contract-v1.md)
left both fixes below out of research ("Not in this design"). This record is
proposed until the founder confirms the wording. It does not mean the change
is deployed or qualified.

## Context and options

On staging on 2026-10-19, an Ask that found items only through lists and
searches ended with "Looked through 0 items · 59s", beside "Searched
meetings, documents, Jira and Confluence · 58 found". It read as if Ask had
seen nothing. Two counts caused it:

1. **`looked_through` counted only items read in full**
   ([ADR-0039](ADR-0039-ask-progress-names-after-the-access-check.md)). A
   list row, or a search hit shown as a preview, was looked at but never
   counted.
2. **`found` counted rows research was never given.** A list fetches up to
   50 rows and gives research a page of at most 25. ECHO's own owner and
   status filters can drop fetched rows. All of them were counted. The
   small-scope preload counted up to 20 items even when it did not fit, so
   research was never shown any of them, and counted items whose text did not
   fit its budget.

Options for the headline:

- **A. Count rows in every progress version.** Released desktops would show
  the right number at once. But they show "and N more not listed" for every
  counted item the receipt does not name, so a list-only Ask would read
  "Searched … · 58 found" and then "and 58 more not listed".
- **B. Count rows only in progress V3.** V3 has not been released
  ([ADR-0042](ADR-0042-research-tool-contract.md)), so its meaning can still
  change. V1 and V2 keep theirs: a client of an earlier version keeps
  receiving its own events, as ADR-0039 requires.
- **C. Keep the count and word a zero differently**, such as "Searched 58
  items". Two numbers would mean two things, and an Ask that read 2 items in
  full and 50 as rows would still say "Looked through 2 items".
- **D. Add a second count to the receipt.** That needs a new progress version
  and header value, for a line meant to stay quiet.

## Decision and consequences

Option B, with the `found` fix in every version.

- **Looked through, in V3.** The receipt's `looked_through` counts each
  distinct item a research call was shown: a row of a list or search, a
  preview, or an item read in full. Like ADR-0039's names, it counts only
  what a read returned itself (a search or list row, an open's anchor, a
  starting or preloaded item). It never counts a neighbour an open brought
  along, or an item released beside a row. An item counts at the model
  gate's `before_call` hook, where names are sent, so every counted item has
  passed the access check before that call. The count leaves the Authority
  only in the receipt, after the final check. It is still at least the
  number of items named.
- **Looked through, in V1 and V2.** Unchanged: the items read in full.
- **Found, in every version.** A searched row counts what its reads gave
  research: every hit of a search; a list's page, never the rows fetched
  behind it or those ECHO's filter left out; and the preload's items only
  when research is shown them. An empty preload still says it found nothing.
  A later list page taken from rows already fetched now gets its own searched
  row. The count includes nothing this person cannot see.
- **Wording.** The headline keeps its words: "Looked through 58 items · 59s".
  The opened receipt no longer adds "and N more not listed". In V3, the found
  counts and the names account for what was looked through. V1 and V2
  receipts now reach the desktop only from an Authority older than it.
- **Clients.** The validators are unchanged: exact keys, and `looked_through`
  at least the items named. `person ask --progress` prints the receipt as
  validated.

What follows:

- The two counts can differ. Found can exceed looked through when research
  stops (budget or no progress) before a step is shown the last reads' rows.
  Looked through can exceed found by starting items and opened items that no
  search or list returned.
- The answer writer may also be given rows research never saw, when research
  stopped before a step was shown them. Those are not counted.
- If ADR-0042's V3 ships before this change, a desktop from that release
  would show "and N more not listed" beside a V3 receipt until it updates.

## Migration, rollback, and evidence

There is no schema change and no data migration. Rollback is a code revert.

The kernel test
`packages/organization-authority-kernel/test/answer-composition/agentic-ask-progress-v1.test.ts`
runs a V8 Ask that only lists 30 Jira rows, a page of 25 and then the other
5. It checks that its V3 receipt counts 30 with nothing named, and that the
same Ask's V2 receipt counts 0. The same file covers the V3 count of rows and
previews, never an open's neighbours; a preload research is never shown; and
a preload item it is not shown. The desktop's end-to-end proof is
`product/echo-desktop/test/e2e/ask.spec.ts`: a `/v7` Ask that only listed
rows shows "Looked through 30 items" and opens onto its one search.

On 2026-10-25 [ADR-0047](ADR-0047-ask-timeline.md) retired progress V1 and V2,
and `9863883` removed the V2 receipt check above: the kernel test now checks
the V3 receipt only. The preload tests went with the small-scope preload,
which `ec92b9b` removed on 2026-10-19.
