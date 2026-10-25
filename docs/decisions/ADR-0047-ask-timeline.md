---
schema_version: 1
id: ADR-0047
kind: decision
title: Ask keeps a device-only timeline that says what changed, and answers follow-ups
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-PERSON-CLIENT
created_at: 2026-10-25
reviewed_at: 2026-10-25
reviewed_ref: 8cc3ffffe517ba5e67fc96890d40ae8eef39304d
status: proposed
supersedes: []
superseded_by: []
updates:
  - ADR-0015
  - ADR-0022
  - ADR-0045
---

# ADR-0047: Ask keeps a device-only timeline that says what changed, and answers follow-ups

The founder asked on 2026-10-25 for Ask history that keeps the rule behind
having none: the context underneath changes quickly, and a stale answer is
more dangerous than no answer. History is welcome only if an old answer always
says whether what it was based on has changed. It must read as one continuous
conversation, not sessions to open, take two or three steps at most, and let a
question follow from the answer before it. The design is
[Ask timeline v1](../product/2026-10-25-ask-timeline-v1.md) and the "Ask
timeline" canvas. This record is proposed until the founder confirms the
result on the desktop. It does not mean the change is deployed or qualified.

## Context and options

ADR-0015 left persistent chat history and conversational memory out of Ask.
The desktop kept a thread only until the page changed. A bounded follow-up
experiment on 2026-09-30 carried only the previous question and failed its
pre-registered bar: the model guessed what "the second concern" meant, which
lived in the answer it never saw.

1. **Keep answers on the Authority.** Rejected. The Authority stores no Ask
   content today, a stored answer would outlive the asker's access, and every
   Person read would need new retention and deletion rules.
2. **Keep questions only and always ask again.** Rejected. It cannot show an
   old answer, and every revisit costs a full research run.
3. **Keep the timeline on the device, check its sources cheaply, and pass the
   previous turn on the Ask.** Chosen.

## Decision and consequences

- **Device-only.** The desktop keeps one timeline file per account next to the
  person session, owner-only, at most 200 turns and 90 days. Our own sign-out
  or an account change deletes it. The Authority still stores no Ask content.
- **An old answer always says what changed.** A new content-free Person read,
  `POST /v1/person/ask/check`, takes the sources an old answer cited and
  returns `same`, `changed`, `unreadable` or `unknown` for each, deciding
  readability first. It makes no model call, writes no audit row and returns
  no content. The desktop tags a changed turn, highlights the sentences whose
  sources changed, and leaves out sentences whose sources the asker can no
  longer read.
- **The previous turn rides on the Ask.** Request V3 gains an optional
  `previous` (the earlier question and the sentences still readable). It is
  the asker's context, never evidence, and is never stored. For a follow-up, one
  small model call resolves what the question refers to and research starts
  from that source, or the answer asks "Which one?" with full questions to
  choose from (outcome `clarify`). It never guesses. For Ask again, the writer
  adds a cited "since" list. A request without `previous` is unchanged byte for
  byte, so baselines do not move. Follow-ups ship only if the pre-registered
  eval in the design passes its "never guess" and "resolve the obvious" rules.
- **Project dots.** `GET /v1/person/project-activity` returns, per project, the
  newest arrival from someone else that the caller can read. The sidebar marks
  projects with something new since the asker last opened them. Home does not
  change.
- **Quieter answers.** The desktop drops the coverage note ADR-0045 introduced,
  the "Asked as" idea, and Try again on a successful answer. `assumption` and
  the `off_scope` outcome leave the contract: nothing ever produced them, so
  ADR-0022's off-scope outcome no longer exists. `notice` and `gap` stay in the
  contract for the person client and the evals.

## Migration, rollback, and evidence

- Server first: an older Authority answers 404 for the two new reads (no tags,
  no dots) and rejects `previous` (the desktop retries without it).
- Rollback is a desktop that stops sending `previous` and stops reading the two
  routes; the timeline file is device-local and can be deleted with the app's
  data.
- Evidence: the eval report for follow-up resolution, the Authority and
  desktop test suites, and the founder's validation on the desktop.
