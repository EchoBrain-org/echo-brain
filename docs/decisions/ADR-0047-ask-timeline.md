---
schema_version: 1
id: ADR-0047
kind: decision
title: Ask keeps a device-only timeline that says what changed, and answers follow-ups
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-PERSON-CLIENT
created_at: 2026-10-25
reviewed_at: 2026-10-27
reviewed_ref: aa79d90c81dbcf8f0147ecb66bfbbe4edbf2c2ff
status: accepted
supersedes: []
superseded_by: []
updates:
  - ADR-0015
  - ADR-0022
  - ADR-0024
  - ADR-0026
  - ADR-0034
  - ADR-0039
  - ADR-0040
  - ADR-0042
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
timeline" canvas. The founder accepted this record on 2026-10-31, as built in
#365 (`aa79d90`). Acceptance does not mean the change is deployed or
qualified.

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
  person session, owner-only, pruned to at most 200 turns and 90 days each
  time a turn is saved. Our own sign-out or an account change deletes it. The
  Authority still stores no Ask content.
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
  the `off_scope` outcome leave the contract: no current path produces them
  (only the A1 pipeline did, from `298ebfd` on 2026-09-27 to `e0b6980` on
  2026-09-28), and nothing re-reads stored audit outcomes, so ADR-0022's
  off-scope outcome no longer exists. `notice` and `gap` stay in the contract
  for the person client and the evals.
- **Only `/v7`.** Ask routes before /v7 are retired: no Authority serves only
  them, and clients older than the 2026-10-22 release update from the feed.
  `POST /v3/person/ask` to `/v6/person/ask`, Ask progress V1 and V2, and
  `person ask --tickets` and `--live` go. The person client and the desktop
  ask `/v7` alone, and an Authority without it fails the Ask as
  `not_supported`.

## Migration, rollback, and evidence

- Server first: the Authority that takes `previous` and serves the two new
  reads is released before the desktop that sends and reads them. The desktop
  never retries an Ask without `previous`, and a failed check or activity
  read stays quiet: it adds no tag or dot, and a failed activity read leaves
  the dots as they were.
- An Authority rolled back must still serve `/v7`: no client asks an older Ask
  route, so one without it fails every Ask as `not_supported`.
- Rollback is a desktop that stops sending `previous` and stops reading the two
  routes; the timeline file is device-local and can be deleted with the app's
  data.
- Evidence: the eval report for follow-up resolution, the Authority and
  desktop test suites, and the founder's validation on the desktop.
