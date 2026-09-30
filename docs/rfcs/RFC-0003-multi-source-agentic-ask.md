---
schema_version: 1
id: RFC-0003
kind: rfc
title: Multi-source agentic Ask
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-PERMISSIONS
  - CMP-PERSON-CLIENT
  - CMP-PROCESSING-ADAPTERS
created_at: 2026-09-28
reviewed_at: 2026-09-28
reviewed_ref: df1cd971a68f3c7daa878ecef9302f66fe2af8a6
status: draft
superseded_by: []
---

# RFC-0003: Multi-source agentic Ask

Builds on [RFC-0002](RFC-0002-agentic-ask-v1.md) (amendment A2 at `df1cd97`).
The decisions below were made on the Echo Ask design board, rounds 1 and 2.
The design board is at <https://claude.ai/artifact/EJSC61zFDw2yeMaidhxMNX>.
This RFC is a draft. Nothing here is accepted until an ADR records it.

## Problem, goals, and current boundary

### Problem

Ask reads only meeting records and documents. Much of the context for a team
decision lives in Slack threads written after the meeting, and Linear will add
more. The A2 loop cannot read either.

The A2 loop's tools and prompts were also measured on 13 meeting questions.
Twelve of those are the demo set that V2 was tuned on, so the measurements
cannot show whether the loop generalizes.

A2 also has three observed quality failures:

- it pulled evidence from an unrelated customer into an answer;
- its direct answer disagreed with its own parts;
- stalled provider calls cut research short.

### Goals

1. One research loop with four tools (`search`, `open`, `list`, `finish`) that
   work the same way for every source. A new source adds a desk connector,
   never a tool.
2. Slack is read live, acting as the asker, and never stored in Echo.
3. Research is complete by construction. The model states what each part of
   the question needs, and code confirms that each need was met or searched
   for before research ends.
4. The answer is one readable paragraph with citations. It shows
   disagreements between sources and never resolves them.
5. Quality is measured on a new multi-source test set, with held-out
   questions and a grader calibrated against human grades.

### Non-goals

- Linear. It follows once Slack works, as live lookups acting as the asker.
- Copying Slack into Layer 1, Layer 2 or any index.
- Slack Marketplace distribution.
- Latency and cost optimization. Quality comes first.
- Changing the model before the new test set exists.
- Editing, reconciling or annotating any source. People fix sources; Echo only
  flags disagreements.

### Current boundary

The current boundary is RFC-0002 with A2:

- the evidence desk reads approved records and document passages, acting as
  the asker;
- the A2 loop uses `search`, `open`, `browse` and `finish`, with at most six
  steps, a 180 s request limit and 60 s per model call;
- the response is `PersonAnswerResponseV4`.

Slack is used only for approval DMs, sent with a bot token, and for linking
person identities.

## Design, risks, and alternatives

### Components

1. **Evidence desk** (Layer 3). It gains a `list` operation, a `source` field
   on every item, and a Slack connector that reads with the asker's own Slack
   token.
2. **Slack person connection** (Slack provider). Each person connects their
   own Slack account with OAuth user scopes, and can disconnect at any time.
3. **Ask loop** (Layer 4). A new tool set, needs per part, a 10-step cap, a
   scratchpad sized to the model's context window, and an answer written as
   sentences.
4. **Organization API.** It adds a `slack_message` citation kind.
5. **Answer Lab.** It adds a Slack fixture connector, the multi-source test set
   and the grader.

### Sources

| Source | Read path | Stored in Echo |
| --- | --- | --- |
| Meeting records | Existing desk path over the record index | Yes (Layer 1 approved records) |
| Documents | Existing desk path over the document index | Yes (admitted source revisions) |
| Slack | Live, with the asker's user token, per request | No |
| Linear | Deferred | No |

Slack reads:

- **What it can reach.** Everything the asker can see in Slack: public
  channels, private channels, DMs and group DMs, in every channel. There is no
  project-to-channel mapping.
- **Search.** The Real-time Search API, `assistant.search.context`. It takes a
  user token with the scopes `search:read.public`, `search:read.private`,
  `search:read.im`, `search:read.mpim`, `search:read.users` and
  `search:read.files`, and returns at most 20 results per request.
- **Thread context.** `conversations.replies`.
- **Channel listing.** `conversations.history`, which needs the matching
  `*:history` user scopes.
- **Installation.** The first customers each install an internal app built
  from Echo's manifest. Marketplace listing comes later.
- **Precondition.** Slack confirms that such an app counts as an internal app
  for the Real-time Search API and its rate limits (open question 1).
- **Terms that bind this design.** Slack's API terms (sections "Data Usage by
  Third Parties" and "Data Access API and Real-Time Search API") forbid:
  - using API data to train a large language model;
  - bulk export;
  - persistent copies, archives, indexes or long-term data stores.

  They allow only "limited and temporary handling" that is essential, and use
  that is "transparent to and reasonably expected by users". The retention
  and provider rules below follow from these terms.

### Retention

- Slack text exists only in the memory of the request that read it.
- The release audit records the team, channel, message timestamp, permalink
  and SHA-256 of the text. It never records the text.
- The answer audit already records only hashes of the prompt, answer and
  response. It needs no change.
- Logs, errors and metrics never include Slack text. Runtime content capture
  is switched off for any model call whose prompt can contain Slack text.
- Answers are returned only to the asker and are not stored. No other person
  ever sees Slack or DM content through Echo.
- The Slack connect screen says, in plain words, that Echo searches the
  person's Slack when they ask a question and keeps nothing.

### Scope

- A global question reads every Echo source the asker can read.
- A project question reads that project's meetings and documents only.
- Slack is always the asker's whole Slack. Each Slack result shows its
  channel, and the prompt tells the model to ignore other projects.
- The test set counts cross-project mix-ups, so this choice is measured.

### Evidence desk contract

The contract changes are additive to `EvidenceDeskPortV1`.

- **`EvidenceDeskKindV1`** gains `slack_message`.
- **`EvidenceDeskItemV1`** gains:
  - `source`: `meeting`, `document` or `slack`;
  - `occurred_at`: the date the item was said, approved or revised.
- **Citation.** `EvidenceDeskCitationV1` gains the kind `slack_message`, with
  the fields `team_id`, `channel_id`, `message_ts`, an optional `thread_ts`,
  `permalink` and `text_sha256`.
- **Visibility of Slack items.**
  - A public channel maps to `team`.
  - A private channel, DM or group DM maps to `only_me`, so the answer marks
    statements that cite it as private.
- **`search({ query, limit ≤ 8 })`.**
  - Code queries every source in scope in parallel and interleaves the
    results, because scores from different sources cannot be compared.
  - It returns at most three items from any one document or Slack thread.
  - A failed or unconnected Slack search contributes nothing and adds a
    notice. It is never terminal.
- **`list({ source, kinds?, status?, channel?, since?, until?, page })`.** This
  operation is new.
  - Results are newest first, 25 per page. Meeting and document items carry
    no text; Slack messages carry their text, which is their only title.
  - Meetings and documents come from the existing inventory path.
  - Slack requires `channel` and defaults to the last 14 days.
- **`open({ item, neighbours })`.**
  - Documents and meeting records work as before.
  - A Slack item returns its thread: the parent first, then up to 20 replies.
- **`revalidate`.**
  - Echo items are checked as before.
  - For Slack items, it confirms that the asker's Slack connection is still
    active. The check is cached for 30 s.
  - It does not check whether a message was deleted after it was read (open
    question 2).
- **Audit.** Every Slack release goes through the same audit as other
  releases, and it is audited before any bytes return.

### Slack person connection

- Per-person OAuth with the user scopes above. The Slack provider owns the
  flow.
- Tokens are encrypted at rest with the existing Slack credential custody
  (`slack-private-credentials-v1`).
- Disconnecting deletes the token.
- A desk request binds the asker's token at creation time. The model cannot
  name, choose or see a token.

### Ask loop

**Step output.**

```json
{ "parts": [ { "question": "…",
               "needs": [ { "need": "approved DVT start date", "status": "open", "evidence": [] } ],
               "notes": "" } ],
  "actions": [ { "tool": "search", "args": { "query": "DVT schedule" } } ] }
```

**Tools.** Each tool has a six-part description: purpose, when to use,
returns, limits, related tools and examples.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `search` | `query`: 2–8 keywords | ≤ 8 mixed items with previews |
| `open` | `id`, or a title already shown | Full text plus context, and linked ids |
| `list` | `source`, plus named optional filters: `kind`, `status`, `owner`, `channel`, `since`, `until` | 25 titles per page; repeating the call returns the next page |
| `finish` | none | Accepted, or the reason once |

**Filters for `list`.** They are named fields that the model fills in from
the question.

- Code accepts loose forms, such as `#hw-dvt` or `hw-dvt`, and `2026-09-21`
  or `7d`.
- A rejected value comes back with the values that are allowed.
- A free-text filter was rejected. It needs a second interpreter, and a
  misread filter silently hides items, which then looks like "not found".

**Needs.**

- Step 1 writes each part's needs: what must be found to answer that part
  fully.
- Later steps may add needs.
- A need leaves the list only by being marked `found`, with ids, or
  `not_found`.

**Finish check.**

- No need is still open.
- Every found need cites an item whose full text was read.
- Every not-found need has at least two distinct searches, or a `list`, run
  after the need was written.
- A rejected finish is returned once, with the reason. A second finish is
  accepted.

**Other stops.**

- 10 research steps.
- Two steps in a row that find nothing new.
- The 90 s request limit. Cloudflare drops an origin response after 100 s
  (HTTP 524), so the earlier 180 s limit could not reach the client
  ([ADR-0022](../decisions/ADR-0022-agentic-ask-only.md)). Each research step
  has 25 s, and 25 s is reserved for the answer.
- At the last run's speeds (4 s median and 7 s at p90 per step), 10 steps fit
  in the 65 s of research at the median and about 9 at p90.

**Who is asking.**

- Every step and the answer call see `asked_by`, the asker's name from their
  own directory entry, and `today`. The route looks up only the authenticated
  membership, and uses the name only when that entry names the same principal.
- The prompts read "I", "me" and "my" as that person: research searches for the
  name and lists meeting actions with it as `owner`. Without a name, they do not
  guess.
- The name goes to the model only. Audits keep hashes, never the name.

**Scratchpad.**

- It holds the notes per part, the full text of opened items, and one-line
  previews of everything else seen.
- A search hit's preview is the 240-character window where that search's
  words cluster, not only the item's head, so a long transcript or document
  shows why it matched. With no word in the text, it is the head.
- The budget is the model's context window, from the generation profile,
  minus the prompt, an output reserve and a 10% margin.
- On overflow, the oldest opened items that no need cites shrink back to
  previews. They can be reopened.

### Answer

**Evidence the writer reads.** Within the answer context budget, code admits
items research read in full and cited first, then other items it read in full,
then remaining search hits with text already released by the desk. The
writer receives each admitted item's full released text. A search preview
alone does not limit the writer to that preview or exclude the item because
research never opened it. Inventory entries without text remain excluded.

The research scratchpad and finish check are unchanged: research may mark a
need `found` only with evidence whose full text it read. The writer may cite
any item whose full text is in its own prompt. Desk receipts, revalidation
before model calls, and the final permission check still cover these items.
Adding search hits to the writer's input does not add them to the
records-only fallback: its eligibility remains limited to evidence research
read in full, with the existing citation-based selection rules preserved.

**The model's output.** One call returns
`{ sentences: [{ text, evidence[] }], not_found[] }`, with at most ten
sentences. This is the V4 bound on statements per part, raised from five: in
the first smoke run a five-sentence cap made the writer list facts that
research had found as "not found". The prompt asks for 2 to 6 sentences
usually, and up to 10 when the question asks several things. Code removes
evidence ids that leak into sentence text.

**What code does with it.**

- It drops any sentence that cites an id the model never read, or that cites
  nothing.
- It renders the rest as `PersonAnswerResponseV4`, with no `direct`, and one
  part whose question is the asker's question:
  - `statements` are the sentences, in order;
  - `gap` names what was not found;
  - the records-only fallback is unchanged.
- The client renders a single-part answer as one paragraph with inline
  citation chips.
- The response shape is unchanged apart from the new citation kind.

**Prompt rules on sources.**

- Approved meeting records and documents are the source of truth.
- Slack shows what was discussed, not what was decided.
- When sources disagree, the answer states both and says where each comes
  from, including which one is the record.
- It does not pick one, and it never suggests editing a source.

There is no authority field.

### Model and provider

- The model stays DeepSeek V3.2 through OpenRouter until the test set exists.
  After that, models are compared on it.
- OpenRouter requests already set `provider.data_collection: "deny"`, so no
  host that trains on or retains prompts is used. This becomes a hard
  requirement once Slack text can reach a prompt.
- A request that cannot be routed under that setting fails as provider
  unavailable. It is never retried on a host that allows data collection.
- Requests also set `provider.sort: "throughput"`: the default price-weighted
  routing picked slow providers, and the loop's calls are sequential
  ([ADR-0022](../decisions/ADR-0022-agentic-ask-only.md)).

### Observability

- Staging records an agentic Ask as the Ask journey, so the
  Explorer, dashboard and Ask alarms see it: retrieval is the research desk
  time, planner the research step calls, then context, answer, final fence,
  audit and the V4 outcome.
- Each step, answer call and desk call is a linked core-runtime span; desk
  spans count returned items by source, including shared transcripts.
  RB-OPERATIONS-001 lists the fields.
- Spans and journey events carry counts and timings only. Slack text never
  enters them, and content capture stays off for calls that carry it.

### Evaluation

**Test set.**

- The user describes 8–10 real stage-gate situations.
- The lab turns them into fixtures (meetings, documents and Slack threads),
  plus 30–40 questions with reference answers and the needs each question
  must cover.
- A third of the questions are held out and never used for tuning.
- Every question covers at least two sources. Some cover access differences
  (private channels, DMs, people who were not in the meeting) and
  cross-project distractors.

**Grader.**

- Claude through OpenRouter, in Answer Lab only.
- The rubric grades:
  - correctness;
  - needs covered;
  - each sentence supported by its citations;
  - source handling: discussed versus decided, disagreements shown, no
    cross-project mix-up;
  - readability.
- Grader grades are calibrated against the user's grades on a sample before
  they are trusted.

**V2** is a reference point, not the target.

### Threats and mitigations

| Threat | Mitigation |
| --- | --- |
| Slack or DM content reaches another person | Answers go only to the asker and are not stored; the desk is bound to the asker's token; audits keep hashes only |
| Slack data used to train a model | OpenRouter `data_collection: "deny"` whenever Slack text can be in a prompt; no fallback to other hosts |
| Instructions planted in a Slack message | Messages are data; tools are read-only; scope, actor and limits are bound by code; the worst case is a misleading answer, which the grader measures |
| Stored Slack text | None stored; the audit keeps digests; enforced by a test that the audit rows and logs contain no Slack text |
| Token theft or misuse | Encrypted custody; per-person revocation; the token never enters a prompt or log |
| Cross-project mix-ups from asker-wide Slack | Channel shown on every item; prompt rule; measured on the test set |
| Slack rate limits or outages | Slack degrades to a notice; Echo sources still answer |

### Alternatives considered

- **Copy Slack into Echo and index it.** Rejected: Slack's API terms forbid
  persistent indexes, and it would move Slack into Layer 1.
- **Link channels to projects.** Rejected for now, because it adds setup. It
  is revisited if the test set shows mix-ups.
- **One search tool per source.** Rejected: the tool count would grow with
  every source, and the model would have to pick sources.
- **Native provider tool calling.** Rejected for now. The JSON step had zero
  format failures, and it keeps per-part notes structured.
- **A separate answer shape (V5).** Rejected. One V4 part with sentences
  reads as a paragraph without a protocol version.

## Compatibility, rollout, qualification, and open questions

### Compatibility

- `/v3/person/ask` is unchanged, and it is the only Ask: V1 and V2 are
  retired ([ADR-0022](../decisions/ADR-0022-agentic-ask-only.md)).
- `PersonAnswerResponseV4` gains the `slack_message` citation kind. It is
  emitted only when the asker has connected Slack. Clients render it as a
  link chip.
- `PersonAnswerResponseV4` allows up to 10 statements per part instead of 5.
  Clients that validate with an older `@echo-brain/organization-api` reject
  longer answers, so the desktop client updates with the server.
- Audit rows keep their shape. `rounds` is at most 10.
- The desk port changes are additive. The A2 loop code is replaced, not kept
  side by side. Git history holds it.

### Rollout and rollback

1. **Lab.** Slack fixture connector, test set, grader and the new loop. No
   live Slack.
2. **Baseline.** The new loop versus V2 on the test set. Held-out questions
   are reported separately.
3. **Live Slack on Echo's own workspace.** An internal app and per-person
   connect, used internally first.
4. **First customers.** Each installs an internal app from Echo's manifest,
   once open question 1 is answered.

Rollback is to disconnect the Slack connector (Ask answers from Echo sources
only), or to revert the loop commit. There is no V2 to fall back to: the
agentic Ask is on wherever an answer model is configured, and the tag
`ask-v2-final` is the last release with V2
([ADR-0022](../decisions/ADR-0022-agentic-ask-only.md)).

### Qualification

- **Answer quality.**
  - Grader pass rate on the held-out questions.
  - Needs-covered rate.
  - Unsupported-sentence rate.
  - Cross-project mix-ups.
  - Disagreement-shown rate.
- **Reliability.**
  - Request failures.
  - Protocol failures.
  - Finish rejections.
  - Steps used.
  - Time per request.
- **Retention.** No Slack text in the audit database, logs or lab results for
  live runs.

### Open questions

1. Does an app that each customer installs from Echo's manifest count as an
   internal app for the Real-time Search API? The user is asking Slack.
2. Should a Slack message deleted after it was read be re-checked before the
   answer is released? The candidate is re-fetching cited Slack items only,
   once, at answer time.
3. The desktop client needs a change to render a single-part answer as one
   paragraph. It no longer repeats the question as the part's label; each
   statement is still its own line.
4. Which `*:history` user scopes are needed for `list` and `open` on each
   channel type? To be confirmed at manifest review.
5. What grader agreement with human grades is required before grader numbers
   are trusted?
