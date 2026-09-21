# Person uploads: original context with optional search enrichment

Status: Accepted by the founder for v1 in `feat/person-updates-inbox-v1` and
PR #196. Original title/text, uploader identity, selected permission, and
separate optional search hints are the v1 shape. Additional content types or
templates can follow when demand establishes their requirements.

Prepared: 2026-09-21. Original baseline: `origin/main` at
`7f86b29577afa33806a61a71c2617437aee712e0`.
Worktree: `.worktrees/person-updates-inbox-v1`.
No issue is assigned. Deployment and real-state conversion are separate work.

## Founder direction

The earlier brief and implementation at `87f9e8c` routed every upload through
meeting-shaped decision/action extraction and private Slack approval. That is
superseded by these instructions:

- Uploaded material may be uncaptured meeting notes, notes or a text artifact
  from a work session, a memo, or a reminder from a client interaction.
- Preserve the original material without requiring it to contain a decision
  or action. The bounded original-text upload shape is accepted for v1.
- An LLM may populate auxiliary metadata to help later search. Its output must
  not replace the source, grant access, or establish approved business facts.
- No Slack approval is required for uploads. The person selects the permission
  mode when uploading. The saved context is immediately searchable under that
  permission, without waiting for metadata.
- Make the changes in this worktree and the existing PR.
- Drive the accepted v1 through green CI, merge, and the staging operator lane.
  Expand supported content types or introduce templates later when needed.

The following describes the accepted v1 implementation and its limits. Future
changes to content types, templates, metadata fields, authoring surfaces, or
publication must be decided explicitly.

## User behavior

```text
explicit upload + selected visibility
  -> authenticated durable save + receipt
  -> original context available to permitted read/search requests

saved original
  -> optional, bounded LLM search hints
  -> additional search matches using the same original access policy
```

Examples all retain their original wording:

| Material | What is saved | What enrichment may help with |
| --- | --- | --- |
| Meeting notes that were not captured | The uploaded notes | Grounded topic/name search wording |
| Work-session artifact | Its current text representation | Grounded terms for finding the work |
| Memo | The memo itself | Related search wording |
| Client reminder | The reminder exactly as written | Finding it by the mentioned client/topic |

None of these examples is a required classification. A reminder does not
become a task or notification, and a sentence in meeting notes does not become
an approved organizational decision merely because it was uploaded.

## Permission and provenance

`only_me` is the default. Only the exact uploading membership tenure, while
active, can read that private upload. `team` is an explicit choice making the
original available to current active members of the same organization. An
owner does not get another member's private uploads merely by being an owner.

The server records the authenticated organization, principal, membership,
selected visibility, and receipt time. This identifies **who uploaded** the
material; it does not assert who originally authored it. Receipt time does not
assert when the described event happened. No model output is an authority for
identity, permissions, sharing, or dates.

Read/search applies the current reader's membership and the stored visibility
before using original text or search hints. Another tenure reusing an email
gets no private access to the earlier tenure's material. Already shared Team
context remains organizational material if its uploader leaves; a revoked
reader cannot access it. Optional model enrichment stops for a revoked uploader.

Content and search releases revalidate the exact session and append a
content-free audit witness before returning. Audit failure withholds the
response. Witnesses contain no bearer token, source text, query, or model output.

This version selects visibility at creation. It has no visibility-edit,
withdrawal, deletion, delegation, or paragraph-level permission operation.
A retry with a different visibility conflicts; it is not an edit request.

## Provisional text transport

The existing CLI command family remains:

```text
echo-brain person updates submit --request-id <uuid> --title <title> --file <path> [--visibility <only-me|team>]
echo-brain person updates status --request-id <uuid>
echo-brain person updates search --query <text> [--limit <1-10>]
echo-brain person updates read --context-id <id>
```

The current carrier accepts one explicit regular UTF-8 file up to 8 KiB and a
nonblank title up to 200 UTF-8 bytes. These bounds are implementation limits,
not the final size or shape for all personal context. Binary files, attachments,
URLs, directories, and a native compose window are not supported in this PR.
Accepted title/text bytes are preserved. Unsupported controls, invalid UTF-8,
unknown fields, oversized escaped JSON, and malformed IDs are rejected.

HTTP routes are:

- `POST /v1/person/updates`: current transport fields are `schema_version: 1`,
  `kind: echo-person-update-submit-v1`, caller UUID-v4 `request_id`, `title`,
  `text`, and optional `visibility: only_me|team` (default `only_me`).
- `GET /v1/person/updates/<request_id>`: only the uploading membership's receipt
  and optional enrichment progress; it returns no source or model text.
- `POST /v1/person/updates/search`: `{ query, limit? }`, up to ten permitted
  matches, with excerpts from original text. No global totals or hidden hits.
- `GET /v1/person/updates/content/<context_id>`: the unchanged original,
  title, receipt time, and selected visibility, only after authorization/audit.

The transport is strict so malformed input cannot select server identity or
policy. It has no meeting/memo/artifact enum, decision schema, model-authored
metadata input, or caller-authored canonical record. `context_id` is an opaque
server-derived locator, distinct from the caller's member-scoped retry UUID.

Matching retries return the same immutable `202` receipt after commit, even
if metadata has advanced. A changed title, text, or visibility under the same
organization/membership/request key yields `409`. The CLI performs no automatic
mutation retry; unknown outcomes require status lookup or an exact manual
retry with the same ID. Existing session refresh is retained.

## Optional enrichment and search

The Authority's existing generation port may produce one bounded free-text
`search_hints` value. This is a small replaceable retrieval aid, not the context
schema. There are no mandatory metadata categories or inferred business facts.
Original text and title are searched immediately; hints can supply additional
matches later. Result excerpts and exact reads always come from the original.

This V1 uses a deterministic lexical scan over an explicitly bounded retained
corpus: 100 uploads per membership tenure and 1,000 per organization. Capacity
counts completed and unenriched uploads alike, and matching replay is checked
before the cap. Search requires all normalized query terms to match the original
or hints and prefers original-text matches. It uses no embeddings or additional
index service. Query/result bounds follow the shared Person query rules.

The worker handles at most one eligible enrichment per periodic cycle after
meeting intake. The separate meeting source keeps its own admission, cursor,
extraction, private approval, and record publication. Handled provider failures
do not starve the other work or durable approval publication. Upload intake and
read/search also work with the API alone, without a Slack connection or worker.

An interrupted enrichment is reclaimable. Model failure retries with bounded
backoff for at most five attempts, then marks metadata `unavailable`; the
original remains saved and searchable. Empty hints are valid. Invalid model
output (including attempts to assign visibility) cannot modify the source or
access. Cancellation preserves pending work. Corrupt source data remains an
integrity failure, not an empty successful result. Source/model content
telemetry is suppressed for enrichment.

Status always distinguishes a stored upload from optional metadata progress
(`pending`, `processing`, `ready`, or `unavailable`). Model availability and
Slack linking are not conditions for saving or finding the original.

## Current search boundary

This PR provides authenticated original-upload read/search through the above
API and CLI. Existing `person records`, Ask, and native approved Sources remain
based on approved decision records. Uploads are not inserted into that signed
record, presented as meeting evidence, or disguised as decision/action atoms.

Connecting original uploads to Ask and a unified source viewer requires a
source/publication contract that has not yet been selected. This revision does
not claim that integration is complete. It preserves the ability to choose
that context shape later without turning this provisional upload carrier or
its LLM search hints into canonical business truth.

## Compatibility and custody

Authority V6 adds three narrowly owned tables: immutable uploads and visibility,
mutable optional enrichment, and immutable upload read audits. It does not
change the meeting admission/cursor or candidate foreign keys. V4 record
codecs and all previously signed record bytes remain unchanged.

V6 is the **unreleased candidate in this PR**. Its earlier extraction-specific
prototype layout and build artifacts at `87f9e8c` are superseded. Do not mix
those disposable prototype databases/artifacts with this revision. The shipped
pinned V5 SQL remains unchanged. Ordinary database open performs no migration
and verifies the exact baseline/schema binding before writable startup.

The existing explicit compatibility tool operates only on a stopped V5 snapshot:

```sh
node tools/copy-authority-v5-to-v6.mjs /snapshot/authority.sqlite /output/authority-v6.sqlite
```

It opens exact pinned V5 read-only, requires absent output, preserves old rows,
sessions, meeting admission/cursor, pending and ambiguous approvals, and updates
only the output Authority schema binding. The other databases, root lineage,
and signed record bytes remain untouched. The fixture restarts the revised
runtime with that copy and proves old pending work recovers without reposting.
Rollback requires the complete matching stopped code/state snapshot.

Uploads, selected visibility, receipts, and audits are retained indefinitely in
protected Authority storage/backups; hints are replaceable derived data. No
new deletion guarantee or retention scheduler is implied. Real-host conversion,
deployment, release acceptance, and live provider rehearsal remain separate
operator work under the existing playbook, not this PR.

## Required proof for this revision

Use disposable SQLite, real application/HTTP boundaries, and synthetic sessions
and model/provider fakes:

1. Save, exit, restart, and read/search the original without Slack or a worker.
2. Matching/concurrent retries have one receipt; content or visibility changes
   conflict. Invalid and over-cap inputs create no state.
3. Private versus Team access works for current members; revoked readers and
   reused-email tenures cannot obtain private material. A new owner has no
   blanket private access. Search hints cannot leak a private match.
4. Exact release revalidation and audit failure withhold content; status and
   audits disclose no source, query, model payload, or bearer.
5. Notes, text artifacts, memos, and reminders retain their wording without
   decision extraction, empty-signal filtering, invented authorship, or cards.
6. Empty/failed/malformed enrichment preserves searchability; retries are bounded,
   cancellation/restart resumes, and integrity failure remains visible.
7. Existing meeting processing, signed record, permission, and search fixtures
   still pass. The stopped V5 copy preserves old sessions and ambiguous work.
8. The exact packed CLI supports submit/status/search/read with explicit
   visibility and contains no server processing, provider credential, local
   queue, or automatic uploader.

Run focused proofs, `npm ci`, and `npm run check`. Retain the exact Person
artifact and report its commit/checks in PR #196. Do not merge or deploy as part
of this implementation task.
