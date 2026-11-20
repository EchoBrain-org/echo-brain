---
schema_version: 1
id: ADR-0055
kind: decision
title: The only limits are capability limits
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
created_at: 2026-11-19
reviewed_at: 2026-11-20
reviewed_ref: 5d1af075c1bdd53f2330cc622c2010446cc47bbb
status: proposed
supersedes: []
superseded_by: []
updates:
  - ADR-0021
  - ADR-0022
  - ADR-0023
  - ADR-0024
  - ADR-0030
  - ADR-0032
  - ADR-0036
  - ADR-0039
  - ADR-0040
  - ADR-0041
  - ADR-0042
  - ADR-0045
  - ADR-0046
  - ADR-0047
  - ADR-0049
  - ADR-0051
  - ADR-0053
  - ADR-0054
---

# ADR-0055: The only limits are capability limits

On 2026-11-19 a staging live test refused a 224-character question because it
held 36 different words and the rule allowed 32. The rule was written for the
first keyword search, where each word cost one index lookup, and Ask inherited
it when Ask became a model-driven research loop. The desktop showed "Something
went wrong".

The founder's instructions that day, in order:

- "a very weird limit that should not even exist in the first place. I suspect
  there is a lot of those in the system. Not just hardcoded limit but over
  defensive mechanism that is hurting the system and hobbling the model's
  capability."
- "remove everything we don't need."
- "since we don't have any live users, let's do a full removal and move
  backwards if something breaks."
- "the only limit should be the capability limit like the context window,
  model capability, storage limit etc."
- "do the reset and remove the 5 stuck ones too", for the limits that stored
  data enforced.

This record states the rule, what it removed, and what it kept. The founder
has not yet accepted this record; the status is proposed.

## Context and options

### What the audit found

Five reviewers read `origin/main` at `5d1af07`: the Person API contracts, the
Ask kernel, the Authority service and model adapters, meeting processing and
the connectors, and the desktop and CLI. They read about 560 limits and wrote
up 108. Most had no recorded reason. The patterns:

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

1. Raise numbers case by case as live tests find them. This finds one limit
   per failed test.
2. Raise every unreasoned limit to a generous number. Tried first, and
   rejected by the founder: a generous number is still a number ECHO chose.
3. Remove every limit ECHO chose, keep only capability limits, and add one
   back when something breaks. Chosen.

## Decision and consequences

### The rule

A limit stays only if it is one of these:

1. **The model's capability.** Its context window and its maximum output,
   stated once in the model profile. Anything sized to the model is computed
   from those two numbers.
2. **Another system's hard maximum.** What Jira, Confluence, Granola, Slack
   and the Claude SDK accept or return.
3. **Storage and transport capacity.** What a database value, a file, a
   request or a response stream can hold. One byte bound per transport, shared
   by the server and every client, is the only limit on how much a person or
   the model sends or receives.
4. **Host capacity.** Concurrency sized to memory and to provider rate limits.
   Work beyond it waits; it is never refused or cut.

These are not limits on capability and are unchanged: privacy and permission
rules; truth checks (a citation points at evidence that was read, a quote is
word for word, an error or an unfinished or untestable read is never reported
as absence); identity, key and signature checks; sign-in rate limiting; a paid
model call that was or may have been billed is never repeated automatically;
a single repair.

Everything else is removed: every count, every field length, every whole-run
deadline and step budget, every lower bound that forces a shape.

A limit that stays loses nothing silently (it pages, or it says what was left
out), rejects one bad item and never the whole reply, names its reason when it
refuses, carries a comment saying why it exists, and is checked once.

### Time: liveness in place of clocks

No Ask, research run, extraction or impact check is stopped by a clock while
it makes progress. A model call or read that produces nothing for a stated
silence period is stalled and fails with that reason. Progress means model
output or a completed read; a keep-alive or a heartbeat is not progress.
Clients wait as long as the server's heartbeat arrives. Both OpenRouter paths
stream so that silence can be measured.

### What was removed, by earlier record

- **ADR-0022:** the 90-second Ask deadline, its round, call and receipt
  budgets, and the client's fixed wait.
- **ADR-0047:** the previous turn's counts; the one-hour follow-up window;
  the 200-turn and 90-day history retention; the check of the 10 newest turns.
  A follow-up carries a sentence of the earlier turn only when every citation
  it rests on was checked and is still readable; a project citation is now
  checked against current membership.
- **ADR-0051, ADR-0045, ADR-0053:** field lengths, the closed card kinds, the
  timeline's one direction, the six-column table rule, follow-up draft counts,
  and the writer's fixed output allowance. One layout fault repairs or turns to
  text only the block at fault, and is counted.
- **ADR-0054:** the five-list cap; the citation counts, and with them the rule
  that an entry over its citation limit is dropped whole, which has nothing
  left to act on. A sentence may stand on a list row it was shown. Visibility
  follows every citation, and a sentence that cites a list now carries every
  row of it, whatever the row's visibility. A follow-up draft still points
  only at an item the writer was shown.
- **ADR-0041, ADR-0040, ADR-0042, ADR-0024, ADR-0036:** search and list
  counts, the 80-character list row, the dropped record text over 3,072 bytes,
  and lists cut at their newest 100. A search or list returns every match,
  paged; an open returns the whole source.
- **ADR-0021, ADR-0023, ADR-0046, ADR-0049:** the English first-person owner
  rule, the 40 proposed owners, owner length, and 20 projects per approval or
  capture. Who may read is still decided by membership.
- **ADR-0030:** the folder and meeting counts; the transcript kept is sized to
  the extraction model's window.
- **ADR-0032:** an impact check's lease renews on progress.
- **ADR-0039:** progress counts and clamps. The server accounts for its own
  stream bound and always keeps room for the answer.

### What a person can now do

- Ask a question of any length the request can carry, on several lines.
- Be told which rule a refused request broke.
- Get an answer as long as the model can write, from research that reads whole
  notes, documents, meeting records and tickets, and runs as long as it makes
  progress.
- Open a Jira ticket that contains a screenshot or a macro.
- Keep their whole Ask history, and follow up on any earlier turn.

### Stored data

The limits stored data enforced were removed with it: follow-up text length,
note size, owners per decision, extraction output, and project counts. The
Authority database baseline moves from V17 to V18, and the extraction
processor versions and configuration digests move. An Authority built from
this code does not start on V17 state. Staging is reset through the operator
playbook (the row for moving to a V18 release) before the release that carries
this change; the reset empties the record log.

Notes have a byte quota (250 MiB per member, 25 GiB per organization, the
figures documents use) in place of a count of 100.

### Not removed, and why

These need something built first, and remain as they were:

- The Granola watch window (30 days) and its 50 most recent meetings: a
  checkpoint format and an API cursor.
- The document transfer deadline (10 minutes for a whole transfer): resumable
  upload.
- An extraction in flight for more than 11 minutes can be marked interrupted
  if two server processes overlap; it is never spent twice. Fixing it needs
  progress recorded in the attempt ledger.
- The Ask source check's 15-second live read: a miss answers "unknown", never
  a refusal. Whether it becomes silence-based is the founder's call.
- Single-request waits of 15 and 75 seconds on small replies that do not
  stream.

Not built, because they are new capabilities: reading Jira and Confluence
comments; extraction kinds beyond decisions, actions and rationales; a next
page for Jira and Confluence search inside research; a multi-line Ask box in
the desktop. Whether the desktop shows the answer's run report remains the
open decision recorded in ADR-0054.

### Consequences

- An Ask can read up to the model's whole window and write its whole output,
  for as long as it makes progress. A hard question can cost many times what
  it did. This is accepted and is the first thing to measure on staging.
- A desktop built before this change refuses answers it may now receive. The
  Authority and the clients are released together.
- The model, not code, decides how much to read and write. Only the writer's
  instructions and its evaluation guard quality where a count used to.

### What would make this a failure even if it works

A privacy, permission or truth check weakened to make a test pass. A paid call
repeated. A run that cannot be stopped. A limit added back with no reason
beside it.

## Migration, rollback, and evidence

Stored state changes: baseline V18 and new processor versions, so the change
is released with a staging reset. The readable-search analyzer release moves
to V5 in the change this one is built on. Rollback is a revert, the matching
client release, and another reset.

A Codex review (`gpt-6.2-astra`, 2026-11-20) of the whole change found twelve
defects, four of them blocking: two privacy defects that predate this change
(a follow-up carrying a roster after project access was lost; a sentence
citing text and a list dropping the list's non-private citations), and paid
calls that could be repeated once clocks became silence timers. All twelve
were fixed, each with a test that failed first. Evidence is recorded in the
pull request: the repository check, the writer evaluation on the Claude
account route, the review and its fixes, and what remains to check live. The
OpenRouter half of the evaluation is owed, as in ADR-0054.
