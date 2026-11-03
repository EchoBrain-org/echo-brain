# Ask answer wording evaluation

On 2026-10-26 the founder's staging Ask answered "Who owns the follow-up
'Approve release clean-v1-20261026-ask-timeline-aa79d90 and choose who can read
it.'?" with "Zhen Ye owns the follow-up "Approve release
clean-v1-20261026-ask-timeline-aa79d90 and choose who can read it."": the lead
restated the question, and the release name was written again. This opt-in
evaluation measures how often Ask's writer does that, before and after a change
to its wording rules.

It measures only the writer of a laid-out answer, the answer every desktop and
`person ask` gets: answer layout v2, since they send `x-echo-answer-layout: 2`
([ADR-0051](../../../docs/decisions/ADR-0051-ask-answer-layout-v2.md)); the
2026-10-26 result measured layout v1
([ADR-0045](../../../docs/decisions/ADR-0045-ask-answer-layout.md)). Each case is
a question and the synthetic items that answer it. Ask runs as the kernel runs
it, with answer layout v2, over a synthetic desk with Jira and follow-ups
bound. Research is scripted, so every trial hands the writer the same evidence:
one search returns the case's items, research opens them all and finishes with
one need found on them. The writer is the product's: its prompt, block catalog
and schema, through the shipped bundle's OpenRouter answer model
([ADR-0037](../../../docs/decisions/ADR-0037-openrouter-routing-for-research-calls.md)),
or, with `--writer claude-account --claude-executable <signed-in claude binary>`,
the personal Claude account writer (`providers/openrouter/src/claude-research`):
the same model through the Claude Agent SDK and your own `claude` sign-in. The
report names the route under `model.route`. Nothing is read from any tool.

```sh
npm run build:workspaces
npm run eval:ask-wording -- --run --credential-file /absolute/private/credential-file --out /absolute/private/report-directory \
  --writer claude-account --claude-executable /absolute/path/to/claude
```

The bundle reads the credential file; the runner only checks that it is a
private file, and makes no request without `--run`. `--out` must be a private
directory outside the repository; the report is written there with mode 0600.
It keeps case ids, each trial's statements, lead and grade (synthetic text),
the writer prompt's SHA-256, the layout the writer was given and model
metadata; never prompts, raw replies, credentials or provider payloads.
`--cases` and `--trials` make a smaller diagnostic run, which never decides
anything. Trials run four at a time by default (`--concurrency`, 1 to 6); the
report keeps them in case order.

## Cases (pre-registered)

Written before any run. Cases live in `cases.json`; `grade.mjs` refuses a
different set. The asker is Noor Haddad; today is 2026-10-26 in
America/Los_Angeles.

| Case | Group | The question |
| --- | --- | --- |
| `follow-up-owner-quoted-title` | names a long id | The founder's question, about a follow-up the asker owns |
| `release-decision-named-id` | names a long id | What a review decided for a named release |
| `follow-up-due-quoted-title` | names a long id | When a follow-up, quoted by its title, is due |
| `ticket-status-key-and-title` | names a long id | A Jira issue's status, by key and quoted title |
| `decision-approver-quoted-title` | names a long id | Who approved a decision, quoted by its text |
| `rollback-named-id` | names a long id | What a named release's rollout plan says, which names another release |
| `review-decision-plain` | plain | What a review decided |
| `owner-plain` | plain | Who owns a piece of work |
| `blocker-plain` | plain | What blocks a gate |
| `which-release-plain` | plain | Which release a review approved: the answer must name it |

Each case declares its long identifiers (release names, one word to the
grader), the facts the answer must say (each a list of alternatives) and the
kinds of item it must cite.

## Pre-registered rules

Written before any run. Three trials per case, 30 in all. Grading is
deterministic: no model judge.

- **Words** are runs of letters and digits, joined across an inner hyphen, dot,
  underscore or apostrophe, ignoring case: a release name is one word, quotes
  and punctuation are none.
- **The lead** is the statements of the answer's first part's lead block, or,
  without one, its first statement.
- **The answer's text** is every part's statements and gap.

1. **Answer, don't restate:** in at least 90% of trials, the lead shares at
   most 4 consecutive words with the question.
2. **Long identifiers once:** in at least 90% of trials, no long identifier is
   written more than once in the answer's text, and the lead writes none that
   the question names.
3. **Nothing lost:** in at least 90% of trials, the outcome is `answered`,
   every statement cites a source, the case's item kinds are cited, and the
   statements say every required fact.

A trial with no statement (an error, or code's fallback when the writer gave
nothing usable) passes no rule. The wording change ships when all three rules
pass on the code with the change. The same run on the code before it is
reported beside it, with each trial's mean and longest shared run, its lead's
length, and how many times long identifiers were written.

## Result, 2026-10-26

Cases `sha256:6ad26dc1…6a2bfa`, the product route `anthropic/claude-sonnet-5.5`
through OpenRouter, 30 trials a run, no errors and no repairs. Before is the
writer at `7d28e8f` (main's prompt, `sha256:9363a07e…`); after is the change
at `daa503d` (`sha256:f575af97…`). Rules 1 and 2 failed before; all three
passed after, so the wording ships.

| | Before | After |
| --- | --- | --- |
| 1. Answer, don't restate (27 of 30 to pass) | 22 | 28 |
| 2. Long identifiers once (27 of 30 to pass) | 23 | 30 |
| 3. Nothing lost (27 of 30 to pass) | 30 | 30 |
| Words shared with the question, mean and longest run | 5.3, 16 | 2.0, 5 |
| Lead length, mean words | 18.4 | 10.2 |
| Long identifiers written | 13 | 6, each one the answer had to name |
| Leads writing an identifier the question named | 7 | 0 |

The same trials, before and after:

| Case | Before | After |
| --- | --- | --- |
| `follow-up-owner-quoted-title` | Noor Haddad (you) owns the follow-up "Approve release clean-v1-20261026-ask-timeline-aa79d90 and choose who can read it."; its status is open. | You own it. |
| `follow-up-due-quoted-title` | The follow-up "Publish the release notes for clean-v1-20261020-meeting-routing-b62b11b to the team space" is due on 2026-10-30. | It is due Oct 30, 2026. |
| `decision-approver-quoted-title` | Lena Brandt approved the decision "Ship fan curve v2 before DVT and hold PVT until the soak passes" on 2026-10-14. | Lena Brandt approved it. |
| `release-decision-named-id` | The release review decided that clean-v1-20261022-ask-layout-56461ff may go to staging once the desktop layout check passes, then waits one day in staging before production. | It may go to staging once the desktop layout check passes, then waits one day there before production. |

Both trials that failed rule 1 after the change are `blocker-plain`, whose leads
said THERM-482 "is blocking the DVT gate", 5 words of the question; one of its
three trials did so before too.

## Layout v2, 2026-11-02 (pre-registered)

Written before any run. Every desktop and `person ask` will send
`x-echo-answer-layout: 2`
([ADR-0051](../../../docs/decisions/ADR-0051-ask-answer-layout-v2.md)): the
writer arranges the answer from seven blocks. Its prompt is the answer prompt
followed by a blocks layout part whose two wording rules are layout v1's word
for word, its input carries `block_catalog` beside `source_catalog`, and it
replies with blocks. That change ships only when this evaluation still passes
its three rules on it
([Ask answer layout v2](../../../docs/product/2026-11-02-ask-answer-layout-v2.md),
"Gates"), so the evaluation now measures the v2 writer: Ask runs with answer
layout v2, and the kernel reads, checks and releases the answer as it does for
the desktop.

- **The same cases:** `cases.json` is unchanged (`sha256:6ad26dc1…6a2bfa`).
- **The same three rules and thresholds,** each at least 27 of 30 trials,
  graded as above. The lead is the statements of the first part's `answer`
  block, layout v2's lead, or, without one, its first statement; a layout v1
  answer is still read by its lead block. The answer's text is still every
  part's statements and gap, as the audit reads them, so it includes the
  statements code writes for a table row, a timeline event, a card fact and a
  quote: a long identifier that titles a card is written once in each of its
  facts.
- **The writer route:** the personal Claude account writer (`--writer
  claude-account`): `claude-sonnet-5-5` through the Claude Agent SDK and the
  signed-in `claude` binary, the route of the block evaluation's run of record
  and of its gate. The report names it under `model.route`.
- **Decided by a complete run:** all 10 cases, 3 trials each, and every
  trial's writer given the block catalog (each trial's `writer_layout` is 2).
  The v2 writer passes when all three rules pass (the report's
  `wording_ships`). A smaller run, or one whose writer was not given the block
  catalog, decides nothing.

The 2026-10-26 results above measured layout v1 through OpenRouter and stay as
they are.

## Result, layout v2, 2026-11-02

At `e9ccc09` with no uncommitted change, through the founder's Claude account
(`claude-sonnet-5-5`): 30 trials, every writer given the block catalog, no
errors and no repairs. All three rules pass, so the v2 writer's wording ships.
This is the writer with no count of statements or citations (ADR-0051's second
amendment), whose prompt adds that the answer prompt's "up to 10" does not
apply; its answers held 2.0 statements on average. The run at `b48c2d7` is the
writer with no count caps (its first amendment; 1.73 statements). The layout
v1 column is the 2026-10-26 run after its change, through OpenRouter: another
route to the same model. Two earlier complete v2 runs passed too: at
`4769016` (30, 30, 30; leads of 17.7 words) and at `294bf37`, with the caps
and the review's fixes (29, 30, 30; 14.9 words; its one miss was
`blocker-plain` saying "is blocking the DVT gate", as v1's misses did).

| | Layout v1, 2026-10-26 | Layout v2, no count caps (`b48c2d7`) | Layout v2, no count of statements or citations (`e9ccc09`) |
| --- | --- | --- | --- |
| 1. Answer, don't restate (27 of 30 to pass) | 28 | 30 | 30 |
| 2. Long identifiers once (27 of 30 to pass) | 30 | 30 | 30 |
| 3. Nothing lost (27 of 30 to pass) | 30 | 30 | 30 |
| Words shared with the question, mean and longest run | 2.0, 5 | 2.4, 4 | 2.4, 4 |
| Lead length, mean words | 10.2 | 17.2 | 15.2 |
| Long identifiers written | 6 | 6 | 6 |
| Leads writing an identifier the question named | 0 | 0 | 0 |

The v2 lead, the answer block, is longer: it often adds a second sentence or a
qualifier ("The soak cannot finish until the fixture holds 45 °C. The ticket is
In Progress and owned by Dev Okafor."). No rule measures its length; it belongs
with tuning the block descriptions, which the design leaves for later.

## Limits

- One model route and synthetic items only: a staging release and the
  founder's desktop check remain the qualification.
- No case names two long identifiers at once; there a short reference could be
  unclear, and rule 2 would not apply as written.
- The source labels the desktop shows under an answer, and the question it
  shows above it, are not the writer's and are not measured.
