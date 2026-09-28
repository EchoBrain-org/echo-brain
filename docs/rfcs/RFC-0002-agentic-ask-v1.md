---
schema_version: 1
id: RFC-0002
kind: rfc
title: Agentic Ask V1 and the evidence desk
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-PERMISSIONS
  - CMP-PERSON-CLIENT
created_at: 2026-09-27
reviewed_at: 2026-09-27
reviewed_ref: 83c8eb63aed78ba760678294ecf7fef863743e06
status: accepted
superseded_by: []
---

# RFC-0002: Agentic Ask V1 and the evidence desk

Accepted for implementation under [ADR-0019](../decisions/ADR-0019-agentic-ask-v1.md).
Acceptance is separate from deployment and live qualification.

## Problem, goals, and current boundary

### Problem

Ask answers from one literal query, at most five original passages plus, in
scope, at most five approved records, and one answer model call
(`services/organization-authority/src/composition/person-answer-v2-route.ts`,
`packages/organization-authority-kernel/src/answer-composition/retrieval-grounded-answer-composition.ts`).
Multi-part questions, questions without keyword overlap, and vocabulary
mismatch lose evidence. Release strips owner, due date, decision status and
meeting title. One malformed answer (for example a schema-valid duplicate
citation) fails the whole request.

Answer Lab evidence (local, not in this repository):

- Phase 4 pilot, 2026-09-24, exact product configuration: complete and
  supported on 3 of 12 development and 5 of 12 holdout questions; 11 of 33
  answerable attempts abstained; a keyword-free project overview released
  nothing in 5 of 5 attempts.
- Staging spike, 2026-09-27, 13 meeting-record questions as one
  owner-approver: current Ask wrongly abstained on 3 and misread 1. A
  throwaway plan → search → judge → per-part write loop answered 13 of 13 with
  no wrong abstention, correct off-scope handling and correct private
  marking, at a median of about 20 s. Findings that shaped this design: one
  combined writer failed on 2 of 13; per-part writing with repair and fallback
  lost none; writers given the whole pad padded unrelated parts; a judge that
  stopped early produced a false "no deadlines" statement.

### Goals

1. Complete answers organized by the parts of the question, with a citation
   on every statement, drawn only from evidence released to the asker in that
   request.
2. Permission scope exactly as today: every read is a Layer 3 release to one
   authenticated Person ([INV-PERMISSIONS-015](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md)).
3. One evidence desk shared by the Ask loop and a CLI door.
4. No answer is lost to malformed model output.
5. Lean: reuse the existing retrieval engines, release ports, audit table and
   structured-generation adapter.

### Non-goals for V1

Latency work; live progress streaming; unattached private notes in project
scope (today's rule stands: a private item counts in project scope only when
associated with the project); structured filters by owner, due date or status;
embeddings or rerankers; conversation memory; an MCP door; moving legacy CLI
searches onto the desk; per-role model selection; any change to `/v1` or
`/v2/person/ask` behavior.

### Current boundary

Client → `POST /v2/person/ask` → route derives scope from the session → one
original-context release (`person-original-context-retrieval-v1.ts`, five
results) and one record release (`person-record-search-route.ts`, limit five,
project-filtered per [ADR-0017](../decisions/ADR-0017-project-meeting-approval-v1.md))
→ kernel composes with one answer call → citations checked against the batch
→ every released source revalidated → answer audit → V3 response. Planning is
the literal question
([ADR-0015](../decisions/ADR-0015-global-and-project-scoped-person-ask.md)).

## Design, risks, and alternatives

### Components

1. **Evidence desk** (Layer 3, organization-authority composition). The only
   code that reads data for Ask. Two operations. No model.
2. **Ask loop** (Layer 4, kernel answer composition). Provider-neutral. Holds
   only a desk handle bound to the request and the structured-generation
   port. No database, storage or lower-layer handle.
3. **Doors**: a new `POST /v3/person/ask` route; the `person ask` CLI and the
   desktop app on that route; a new `person evidence` CLI door onto the desk.

### Evidence desk

The route binds the authenticated Person and scope (global, or one project)
when it creates the desk for a request. Nothing a model outputs can set or
change actor, membership, scope, snapshot or limits.

`search({ query?, kinds?, limit? })`

- `query` present: ranked evidence across notes, document passages and
  approved records readable in scope; `limit` ≤ 10 (default 10).
- `query` absent: list what is in scope (label, kind and exact citation,
  no body text), ≤ 50 entries with a truncation flag. Source version identity
  stays in the citation; V1 adds no separate version browser.
- `kinds` narrows to decision, action, rationale, note or document passage.

`open({ item, neighbours? })`

- The full released item (≤ 3,072 UTF-8 bytes per passage). For a document
  passage, the anchor and up to two neighbours (≤ 9,216 bytes total). For a
  record atom, the anchor first, then sibling atoms in stored order, at most
  ten items and 30,720 text bytes total. Return `truncated` when more remain.

Every full returned item (inventory entries omit `text`):

| Field | Content |
| --- | --- |
| `citation` | Existing approved-record or source-revision citation identity |
| `kind` | decision, action, rationale, note, document_passage |
| `text` | Released text, ≤ 3 KB |
| `visibility` | only_me, team, project, projects, approver_only |
| `label` | Meeting title and date, or filename |
| `attributes` | owner, due_at, status when stored; omitted otherwise |
| `receipt` | Identifier of the release audit that covered it |

Rules:

- Filter by audience, association and current membership before ranking;
  counts and truncation flags count only readable items. Project scope never
  falls back to global.
- The first desk call pins the Layer 2 generation and record head for the
  request; later calls use the same snapshot. A mismatch releases nothing
  (fail closed).
- If the record index is not current at request start, records release
  nothing for the entire request, originals still answer, and the response
  carries a notice. This originals-only mode is fixed at desk initialization;
  index recovery does not switch modes or invalidate the original releases.
  Only a positively identified index lag permits this mode. Authentication,
  audit, corruption and snapshot failures remain terminal.
- Each call commits its release audit before returning bytes (existing
  original-context release audit and record read audit).
- Document ranking fixes on the desk path: match whole terms instead of
  substrings, and return at most three passages per document per search.

CLI door, same code path over HTTP, JSON output, acting as the signed-in
Person: `person evidence search --query <text> [--project <id>] [--kind <k>]
[--limit <n>]` and `person evidence open --item <citation-json>
[--project <id>] [--neighbours <n>]`. Each CLI invocation creates a fresh
authorized desk request; callers repeat the project scope when opening a
project result. Omitting scope explicitly selects global access, never an
inferred continuation of an earlier project request.

### Ask loop

All limits live in one configuration object:

| Limit | Value |
| --- | --- |
| Parts | ≤ 5 |
| Queries per part per round | ≤ 3, plus the literal question in round 1 |
| Results per search | 10 |
| Rounds | ≤ 3 |
| Pad | ≤ 40 items and ≤ 49,152 bytes, filled round-robin across parts, ≤ 8 new items per part per round |
| Writer evidence | Judge-selected items first, then items found for the part and for the literal question; ≤ 20 items and ≤ 32,768 bytes per writer |
| Statements per part | ≤ 5 |
| Model calls per request | ≤ 12 |
| Repairs | 1 per call |
| Deadline | 60 s, with 15 s reserved for writing and summary |

Every model call passes explicit options: model, maximum output tokens per
role, strict JSON schema and provider policy. It records finish reason and
usage, and distinguishes truncated, invalid-schema, refusal and valid-empty
outcomes ([INV-ADAPTERS-003](../invariants/INV-ADAPTERS-003-model-execution-controls.md)).
V1 uses the existing answer-composition model for every role.

No model-call timeout exceeds the remaining deadline. When the call budget or
the writing reserve is exhausted, unwritten parts show their assigned items
and the summary is skipped. The near-spelling judge rerun and all repairs count
against the budget.

1. **Plan.** Input: the question. Output: the question's own parts in the
   asker's order, each with 1–3 keyword queries. An embedded premise
   ("since X…") becomes a part to verify. No invented research steps. On
   failure after repair, the whole question is one part and its query is the
   literal question.
2. **Search.** Round 1 runs the literal question plus every part's queries.
   Results are deduplicated by citation identity, tagged with the part and
   query that found them, and added to the pad fairly.
   If that first search round finds no evidence, list readable sources once
   with query-less search and open inventory items in returned order, subject
   to the same per-part, pad and deadline limits. Assign these discovery items
   round-robin to the parts. This deterministic fallback is V1's bounded
   keyword-free discovery policy; the judge does not choose arbitrary tools.

   **Small-scope shortcut** (experimental switch `small_scope_shortcut`, off
   by default until measured; amendment A1). Before round 1, code counts the
   readable records and passages in scope through the desk. If they fit the
   writer-evidence limit, code releases all of them into the pad through desk
   calls, skips further search rounds and the judge, and gives every writer
   all of them. Planning still defines the parts. Otherwise the loop runs
   unchanged.
3. **Judge.** Input: question, parts with the queries already tried, and the
   pad with every item's full released text; the pad limits bound this input
   (amendment A1). Output:
   `scope {matches_question, note}`, one entry per part `{id, status:
   answered|partial|missing, evidence_ids, new_queries}`, and `done`. The
   reply is invalid unless it has exactly one entry per part and its evidence
   IDs are on the pad. On failure after repair, parts are written from the
   items found for them and for the literal question.
4. **Continue.** While rounds and deadline remain and a part is partial or
   missing, search again for those parts only. Queries come from the judge, or
   when it offers none, from unused planner queries or the part text. Stop
   when every part is answered, no round remains, the deadline reserve is
   reached, or a round adds nothing new.
5. **Off scope.** The judge's scope verdict is advisory and never discards
   evidence (amendment A1). If the judge reports that the evidence is not
   about what was asked, code first looks for a near-spelling: a capitalized
   name in the question within edit distance 1 (≤ 6 characters) or 2
   (longer), same first letter, of a name in released evidence. If found, the
   judge reruns under that stated assumption and the answer displays it
   ("Assuming 'Ecko' means 'Echo'"). Writing proceeds either way. Only if
   every part ends with no released statement does the answer become
   `off_scope`, stating what was asked and what the evidence covers, with no
   citations.
6. **Write.** One call per part, in parallel. Each writer receives the
   judge-selected items for its part first, then the other items found for
   that part and for the literal question, in retrieval order, within the
   writer-evidence limit. A part makes no writer call, and is not found, only
   when none of those sources contains an item for it. At most five
   statements `{text, evidence_ids}` and a gap note for any uncovered portion.
   The writer:
   - keeps each condition, date and limit with its own item;
   - preserves decision status: proposed and unresolved decisions remain so
     even in an approved record; only decided decisions establish a decision,
     and actions remain assigned tasks, not completions or customer promises;
   - names an owner only when the evidence names one;
   - corrects a false premise.

   A part with no items makes no call: code writes "I couldn't find … in the
   records you can access." On failure after repair, the part shows its
   supplied items instead of prose.
7. **Summary.** One sentence that only restates the parts; it may stay
   general rather than combine separate items. On failure the answer has no
   summary line. It uses the same cited statement shape as part statements;
   its allowed evidence is the union cited by those parts and its private
   marker is derived by code. Off-scope and not-found answers have no summary.
8. **Code checks.** Evidence IDs resolve to citations. Unknown IDs are
   removed, and a statement left with no valid ID is not released. A
   statement is marked private when any cited item is `only_me` or
   `approver_only`.
9. **Revalidation and release.** Before every model call and before release,
   revalidate all desk releases, including the upcoming call's items,
   inventory metadata, labels and attributes, cited or not, and the pinned
   snapshot. Parallel writers reserve their call budget before starting.
   Any failure releases no answer. Then write the answer
   audit and return.
10. **Cancel.** A client abort stops desk and model calls, audits the
    cancellation and releases nothing.

The loop never sends a model anything the desk did not release to this
Person in this request, and citations are identifiers resolved by code, never
model-authored evidence
([INV-ADAPTERS-004](../invariants/INV-ADAPTERS-004-source-owned-grounding.md),
[FP-ADAPTERS-004](../failure-patterns/FP-ADAPTERS-004-model-authors-evidence.md)).

### Amendment A1, 2026-09-27: evidence visibility

The first paired measurement of the implementation (Answer Lab, local):
- 24 frozen SCOUT and VIREL document questions, one trial per arm, 23
  comparable pairs.
- V3 finished below V2:

| Metric | V2 | V3 |
| --- | --- | --- |
| Complete and supported | 9 | 6 |
| Unjustified abstentions | 3 | 9 |
| Required parts retrieved | 56/60 | 59/60 |
| Required parts shown to a model | 56/60 | 35/60 |
| Median latency | 2.9 s | 12.7 s |

Two mechanisms specified by this RFC hid the retrieved evidence:
- The judge saw 300-character document snippets, and writers saw only the
  judge's selections.
- The scope verdict discarded all evidence. For example, battery-reserve
  requirements were ruled off scope because they lacked voltage
  specifications.

A1 makes four changes:
- The judge sees full text.
- Writers see everything found for their part, with judge picks first.
- The scope verdict is advisory.
- The small-scope shortcut is added as a separately measured switch.

The principle: permission filtering is strict; a model's relevance judgment
orders evidence and never hides it.

### Answer format

`POST /v3/person/ask` takes `{schema_version: 3, question, project_id?}` and
returns `PersonAnswerResponseV4`:

| Field | Content |
| --- | --- |
| `scope` | global, or the project |
| `outcome` | answered, partial, not_found, off_scope |
| `assumption` | Displayed assumption, if any |
| `notice` | For example: meeting records were unavailable |
| `direct` | `{text, citation_indexes[], private}`, if any |
| `parts[]` | `{question, status: answered\|partial\|not_found\|records_only, statements[], gap?, records?}` |
| `statements[]` | `{text, citation_indexes[], private}` |
| `citations[]` | `{citation, kind, label, visibility}` |

`records` uses the same cited statement shape, with exact supplied evidence
text rather than model prose. It is bounded by the request pad and rendered
with its citation and private marker. Unknown evidence IDs, or IDs not
supplied to that writer, cannot support a writer statement. If no valid statement survives, use this
records-only fallback. All labels and visibility values come from the desk.

The desktop app renders the direct answer, one section per part, citation
chips per statement that open through the existing source reads, a private
marker, visible gaps, and banners for assumptions, off-scope answers and
notices. While waiting it shows elapsed time and Cancel. The CLI prints the
JSON and supports interrupt to cancel.

### Audit

Desk calls reuse the existing release audits. The answer audit adds a
versioned row kind with no content: ordered receipt digests, rounds, model
calls, repairs, fallbacks, outcome, and citation count. The citation bound is
the number of released items, not a fixed 16
(`person-answer-composition-audit-v1.ts`). Existing rows are unchanged.
The terminal audit describes the authorized result at the release decision,
not a guarantee that the client received it. A disconnect after that immutable
audit suppresses delivery without writing a second terminal outcome. Earlier
cancellation records a cancelled outcome with no answer content.
The hard request deadline records `timed_out`, distinct from caller
cancellation, and publishes no late answer. Budget and writing-reserve stops
still use the evidence fallback while enough request time remains to complete
the final authorization and audit.

### Threats and mitigations

| Threat | Mitigation |
| --- | --- |
| Model widens actor or scope | Desk bound by the route; queries are text only |
| Instructions inside evidence | Evidence is data; desk is read-only; the loop has no write tools; hard call limits |
| Privileged read by the loop | No lower-layer handle; Layer 4 is a Layer 3 client only |
| Revocation between rounds | Revalidate everything supplied before each model call and before release |
| Snapshot drift across rounds | Pinned generation and record head; mismatch releases nothing |
| Forged or unreleased citation | Code resolves identifiers; unknown IDs removed; uncited statements dropped |
| Existence hints | Filter before ranking; counts over readable items only; off-scope notes name only released subjects |
| Private content copied onward | Private statements marked; answers return only to the asker |
| Cost or latency runaway | Limits and deadline enforced in code |

### Records to change on acceptance

- INV-PERMISSIONS-015 enforcement: from one plan, one batch and at most one
  answer call to a bounded number of desk calls and model calls in one
  request, under one Person and one pinned snapshot, with every release
  audited and everything supplied to a model revalidated before each model
  call and before release. Malformed output gets one repair and then a
  deterministic fallback to released evidence. Unknown citations are removed
  and never released.
- ADR-0007 (one planner call, planner failure terminates, one answer call) and
  ADR-0015 (no agent loop, at most one answer call): superseded for the V3
  route by a new ADR recording the accepted design. V1 and V2 keep their
  contracts.
- Component pages for the new route, desk and CLI door.

### Alternatives considered

- **Free agentic policy loop** (Answer Lab configuration C: three policy
  rounds over a five-packet cumulative budget). Rejected: repeated actions and
  wasted calls, and no better than deterministic overview retrieval.
- **One combined writer.** Rejected: whole-answer failures and bloat in the
  spike.
- **Four desk operations** (search, list, open, records). Collapsed into
  search with optional query and kinds, plus open.
- **Lean slice without the desk.** Declined in favor of full V1.
- **Quote-verified claims** (lab claims schema). Not adopted; exact quote
  matching discards supported findings (FP-ADAPTERS-004).

## Compatibility, rollout, qualification, and open questions

### Compatibility

`/v1` and `/v2/person/ask` and their response formats are unchanged, so old
clients are unaffected. The additions are the V3 route, V4 response, V3
request, CLI door, desktop rendering and the versioned audit row. There are no
changes to record, original, index or extraction storage. The document ranking
fixes apply to the desk path only.

### Rollout and rollback

- A per-organization server capability flag, off by default, enabled on
  staging for founder dogfooding and the SCOUT role agents.
- For a staged Authority release, the only supported enablement is the
  allowlisted `agentic_ask_v1` boolean in its canonical candidate release
  record. Its record SHA binds the setting; the release wrapper materializes
  `ECHO_AGENTIC_ASK_V1` in the candidate environment and restores the accepted
  environment tuple on rollback. Legacy records omit the field and mean false.
  See the [current-host release lane](../../deploy/release/README.md).
- Clients use V3 when the capability is present and V2 otherwise.
- Authenticated `GET /v3/person/capabilities` reports `agentic_ask_v1`.
  Explicit false, or a canonical missing capability route on an older server,
  selects V2. A V3 execution, authorization, cancellation or validation failure
  never triggers an automatic downgrade.
- Rollback: turn the flag off. Clients fall back to V2; audit rows stay
  readable.

### Qualification and staging comparison

The offline loop, permission, transport and cancellation checks below must
pass before enabling the flag for a bounded staging comparison. Live quality
comparison is qualification evidence for broader enablement; it is not a
claim made by an offline pass. Existing candidate release gates still apply.

- Loop tests with a scripted model covering every branch: plan failure,
  judge invalid or empty, writer prose or truncation, summary failure, off
  scope, near-spelling, forced re-search, deadline and cancel.
- Desk permission suite: existing ADR-0015 and ADR-0017 cases, plus:
  - multiple rounds;
  - revocation between rounds;
  - a team member versus the approver;
  - project scope including project-approved records;
  - snapshot mismatch and record-index lag;
  - counts over readable items only.
- Recorded model responses so failures replay without model calls.
- Comparison against V2 on 13 meeting-record and 24 SCOUT and VIREL document
  questions, asked as an owner-approver and as a team member. Pass requires:
  - zero scope or privacy leaks;
  - no new wrong abstentions;
  - no new unsupported material claims (founder review of at least 30
    answers);
  - zero answers lost to writer failure;
  - sample p95 of 60 s or less.
- Content-free observability: stage timings, model calls, repairs,
  fallbacks and outcome.
- Paired re-measurement after amendment A1, before V3 becomes a default
  candidate:
  - **Arms:** V2; V3 with A1; and V3 with A1 plus the small-scope shortcut.
  - **Trials:** three per question per arm.
  - **Question sets:** the 24 document questions, and the 13 meeting-record
    questions with the meeting-record plane populated, each asked as an
    owner-approver and as a team member. The 13 are the 2026-09-27 spike
    set:
    - Twelve Answer Lab `fixtures/questions.json` IDs:
      `after-team-approval-rollout-question`,
      `approver-private-price-question`, `safe-commitment-question`,
      `first-10-prerequisites-question`, `remaining-work-question`,
      `expansion-rule-question`, `confirmed-launch-premise-question`,
      `approved-commitments-question`, `unsupported-question`,
      `after-team-approval-rollout-question-paraphrase-2`,
      `expansion-rule-question-paraphrase-1`,
      `approved-commitments-question-paraphrase-2`.
    - One question outside that file, ID `northstar-remaining-locations`:
      "What can we safely promise Northstar about the remaining locations?"
  - **Report:**
    - complete and supported answers;
    - unjustified abstentions;
    - required parts retrieved;
    - required parts shown to a model;
    - unsupported material claims;
    - model calls;
    - median and p95 latency.
  - **V3 qualifies only if:**
    - it is at least V2 on both corpora and better on at least one;
    - required parts shown to a model are not below V2;
    - privacy and scope failures are zero.

### Open questions

1. Unattached private notes in project scope (deferred to V1.1).
2. Progress streaming (deferred to V1.1).
3. Structured filters by owner, due date and status (deferred to V1.1).
4. Model per role after a frozen-input comparison.
5. Whether `/v2` adopts the desk's document ranking fixes.
6. Judge completeness tuning against a labelled evaluation set.
