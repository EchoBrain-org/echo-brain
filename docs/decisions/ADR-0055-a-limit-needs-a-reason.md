---
schema_version: 1
id: ADR-0055
kind: decision
title: A limit needs a reason
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
created_at: 2026-11-19
reviewed_at: 2026-11-19
reviewed_ref: 5d1af075c1bdd53f2330cc622c2010446cc47bbb
status: proposed
supersedes: []
superseded_by: []
updates:
  - ADR-0021
  - ADR-0022
  - ADR-0024
  - ADR-0030
  - ADR-0040
  - ADR-0041
  - ADR-0042
  - ADR-0045
  - ADR-0047
  - ADR-0051
  - ADR-0054
---

# ADR-0055: A limit needs a reason

On 2026-11-19 a staging live test refused a 224-character question because it
held 36 different words and the rule allowed 32. The rule was written for the
first keyword search, where each word cost one index lookup, and Ask inherited
it when Ask became a model-driven research loop. The desktop showed "Something
went wrong". The founder's response: "a very weird limit that should not even
exist in the first place. I suspect there is a lot of those in the system. Not
just hardcoded limit but over defensive mechanism that is hurting the system
and hobbling the model's capability", and then "remove everything we don't
need."

This record states the rule that decides which limits stay, and lists the
numbers in earlier records that it replaces. The founder has not yet accepted
this record; the status is proposed.

## Context and options

### What the audit found

Five reviewers read `origin/main` at `5d1af07` on 2026-11-19: the Person API
contracts, the Ask kernel, the Authority service and model adapters, meeting
processing and the connectors, and the desktop and CLI. They read about 560
limits and wrote up 108. Most had no recorded reason. The same few patterns
repeat:

- A rule copied from another feature where its reason does not apply. The
  keyword-search question rule sat in about fifteen places, including the
  searches the model writes and every evaluation case.
- A refusal that hides its reason. The server replaced every validation
  failure with "request is invalid"; the desktop had no wording for 27 codes.
- A small allowance for a capable model. The writer had 2,000 output tokens
  while its instructions said an answer has no size limit.
- A small reading window. Evidence was cut to 3 KiB in seven places; opening
  a note returned one piece with no next; Jira and Confluence search returned
  five results.
- One fault discarding everything. One stored turn that failed validation
  emptied the desktop's Ask history, and the next save erased it. A Jira
  ticket with a screenshot could not be opened. A Granola project with more
  than 1,000 meetings failed every read.
- Code overruling the model. A proposed owner was cleared unless an English
  first-person phrase matched, although the approver already confirms owners.

### Options

1. Raise numbers case by case as live tests find them. This is what happened
   until now, and it finds one limit per failed test.
2. Remove every limit that has no reason, in one pass, and state the rule so
   new ones are not added. Chosen.

## Decision and consequences

### The rule

A limit or defensive check stays only if it is one of these:

1. **Someone else's limit.** A provider's documented maximum, or the model's
   real context window and maximum output.
2. **Protection against abuse or attack.** A request size bound, a sign-in
   rate limit, identity and key checks.
3. **A privacy or permission rule.**
4. **A truth check.** A citation points at evidence that was read; a quote is
   word for word; an error or an unfinished page is never reported as absence.
5. **Protection of the host or of money.** Concurrency sized to memory; one
   paid attempt.

A limit that stays must also:

- be sized to the real constraint, not copied from another feature;
- lose nothing silently: it pages, or it tells the person or the model what
  was left out;
- reject one bad item and never the whole reply;
- give a specific reason when it refuses;
- carry a comment that says why it exists;
- be checked once, at the layer that owns it.

Across a boundary between steps, tell the model; do not enforce. This is the
rule of ADR-0054 applied to limits.

### Numbers this record replaces

Each line names the earlier record and the value that no longer holds.

- **ADR-0022:** Ask's whole-run deadline of 90 seconds, with its reason (a
  proxy that drops a response after 100 seconds), and the client's wait of
  135 seconds. Ask streams its progress with a heartbeat, so the deadline is
  ECHO's own choice of how long a person waits: 300 seconds, with the client
  at 345 and the desktop host at 355.
- **ADR-0047:** the previous turn carried into a follow-up (8 sentences of
  400 characters, 12 citations, 4 per sentence, inside a 16 KiB request) now
  carries the earlier answer's sentences as released (up to 200, 400
  citations, 40 per sentence, inside a 64 KiB request). "What is different
  since" has no count of 6.
- **ADR-0051 and ADR-0045:** a card's entity is not a closed list of four; a
  timeline may run newest first; one layout fault repairs or turns to text
  only the block at fault, and is counted; a code-filled table keeps more than
  six columns; the writer's output allowance is 16,000 tokens, not 2,000.
- **ADR-0054:** the writer is shown every list research read, not at most
  five; a writer entry may cite 40 items, the statement contract's own limit,
  not 12; a list block whose selection cannot be read gets the one repair
  before it is dropped. Its three kept guarantees do not move.
- **ADR-0041, ADR-0040, ADR-0042, ADR-0024:** a list row shows up to 300
  characters of a record's text, not 80; searches return up to 25 results,
  not 5, 8 or 10, and say when there are more; record text over 3,072 bytes
  is carried whole, not dropped.
- **ADR-0030:** the Granola folder list reads 1,000 folders and says when it
  was cut. A mapped folder may hold 100,000 meetings.
- **ADR-0021:** code no longer checks a proposed owner against an English
  first-person phrase; the approver's confirmation is the check. A meeting
  with more than 40 proposed owners offers the first 40, not none.

### What a person can now do

- Ask a question of up to 4,000 characters, on several lines, with no rule
  about how many different words it holds. The keyword rule remains only on
  the real keyword searches.
- Be told which rule a refused request broke.
- Get a long answer: the writer has room for it, research has up to 300
  seconds, 30 rounds and 60 model calls, and a step has 8,000 output tokens.
- Have research read a whole note, document, meeting record or Jira ticket,
  and find up to 25 results per search in ECHO, Jira and Confluence.
- Open a Jira ticket that contains a screenshot or a macro.
- Keep their Ask history when one stored turn is unreadable.

### Kept, on purpose

Visibility follows citations. A follow-up draft points only at an item the
writer was shown. An entry over its citation limit is dropped whole. An
unknown or unfinished read is never reported as "not found". The keyword rule
on real keyword search. Provider maximums. Request size and sign-in bounds.
The session concurrency ceiling. One paid extraction attempt, which now
retries when the provider was overloaded and nothing was billed.

### Not done, because the stored data fixes the limit

These need a schema migration or a staging data reset, and are the founder's
call:

- Follow-up and action text beyond 120 characters: the V17 database checks 1
  to 120.
- A note beyond 8 KiB: the note tables cap text at 8,192 bytes.
- More than 40 owners on a stored decision: the V17 database caps it.
- Extraction output beyond 8,192 tokens: the value is part of the processor
  configuration hash, so changing it stops every admitted source until it is
  admitted again.
- A Granola watch window beyond 7 days and 200 meetings: a wider window
  re-imports older meetings as new and does not fit the stored cursor.

The extraction prompt and adapter versions were not advanced, although
extraction's output changed (owners, trimming, rationales), for the same
reason. They advance with the next reset.

### Not done, because it is a new capability

Reading Jira and Confluence comments. Extraction kinds beyond decisions,
actions and rationales. A next page for Jira and Confluence search inside
research. A multi-line Ask box in the desktop. Whether the desktop shows the
answer's run report remains the open decision recorded in ADR-0054.

### Consequences

- A desktop built before this change refuses answers it now may receive: more
  than five parts, an unfamiliar card kind, a newest-first timeline, a larger
  answer. The Authority and the clients are released together.
- An Ask may take up to five minutes. Whether the proxy in front of staging
  holds a streamed response that long is checked in the first staging round.
- The writer's instructions and allowances changed, so the writer evaluation
  gates the change.
- Larger reads cost more tokens per Ask.

### What would make this a failure even if it works

A truth, privacy or permission check weakened to make a test pass. A limit
removed that was protecting the host, found only under load. A new limit
added later with no reason beside it.

## Migration, rollback, and evidence

No stored format changes. The readable-search analyzer release moves to V5 in
the change this one is built on, and the Authority rebuilds its search index
at startup. Rollback is a revert together with the matching client release.

Evidence is recorded in the pull request: the repository check, the writer
evaluation on the Claude account route, and what remains to check live. The
OpenRouter half of the evaluation is owed, as in ADR-0054.
