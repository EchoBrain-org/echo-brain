# Claude research-loop feasibility trial

The latest source candidate is the [staging service integration](#staging-service-integration-2026-10-20).
The earlier [local staging comparison](#local-staging-comparison) used a local client.
The earlier [limit-removal comparison](#limit-removal-comparison) confirms that
numerical caps can truncate a complete inventory and stop a successful research
path. Both earlier synthetic trials below are retained as historical evidence.

The SDK can research ECHO-shaped evidence and hand a usable bundle to the
existing Ask and sweep renderers. This is a promising synthetic prototype,
not a staged replacement or proof of live permission equivalence.

Base: `819a9efac47b6e53355f6227936c7c6c68ddfbb8`. Model:
`claude-sonnet-5-5`. Claude Agent SDK `0.3.305`; installed CLI `2.1.302`.
All data is invented. No Authority endpoints, AWS actions or live user records
were used. Production code, triggers, renderers and release feeds are unchanged.

## Observed results

One run per engine/case, including the existing renderer:

| Case | Existing loop in trial | SDK loop | Result |
| --- | --- | --- | --- |
| Active projects and leads | 11.8 s, answered | 6.9 s, answered | Both named the two projects and their respective leads with project citations. |
| Yesterday across sources | 15.9 s, partial | 10.8 s, answered | SDK opened all four bodies after listing; existing loop stopped at metadata. |
| Open items across 105 tickets | 28.6 s, partial | 26.7 s, partial | Both finished pagination. SDK found the six open tickets and the meeting action's text; the existing writer still declared a gap. |
| Sweep of an existing item | 2.0 s, answered | 1.9 s, answered | Both preserved the no-planner path and existing `still_open` sweep output. |

These are observations, not a speed claim. The existing loop uses a fresh
headless query for each structured decision instead of its deployed OpenRouter
transport. The SDK retains one research session. Prompt caching, extra structured
output calls, model variation and instant fixture reads affect timing and cost.
The live server's earlier timeout was not reproduced here: both engines finished
the synthetic ticket scan within budget.

## What the SDK changed

For yesterday, both saw the same three sources and the same date window in
America/Los_Angeles. The current loop returned a complete inventory but did not
open its four records. Its writer correctly reported that the record bodies were
missing. The SDK listed those same sources, opened the decision, action, ticket
and page, then returned evidence and notes that the unchanged writer could use.

For open items, the SDK retrieved all 105 tickets across five pages without a
Jira status filter. It identified the six open tickets, including DEMO-102 on the
last page, and their owners. Its final answer contained those six tickets and
the meeting action, but was still `partial`.

The remaining gap was downstream: ECHO's current writer receives at most 100
members of a list (`AGENTIC_LIST_WRITER_MEMBERS_MAX_V1`). The writer reported the
five omitted rows as a gap even though research had finished, the notes named
the last open ticket, and the deterministic list renderer selected all six open
tickets from the complete bundle. Changing research alone does not remove this
handoff limitation. No renderer change is included in this experiment.

## Validation and evidence

- 15 focused adapter/assessment tests passed, covering scope, source availability,
  pagination, metadata/body distinctions, citation ids, revocation, cancellation,
  starting evidence and trigger options.
- `npm run check` passed: 366 test files; 5,841 tests passed, two expected
  failures and two skipped. Architecture, documentation, lint, build and TypeScript
  checks passed in that run. The experiment's 15 focused tests passed separately.
  [Validation record](validation.json) records the commands and source hashes.
- Eight real model trials completed. Revised smoke checks pass three SDK cases
  and two current-loop cases. The partial cases remain failures.
- An additional real SDK probe revoked fixture access during its first read.
  It stopped without returning a bundle in 4.7 seconds. This proves that observed
  loss stops the prototype, not the full per-model-request authorization fence.
- [Trial evidence](trial-results.json) contains model metrics, research plans,
  read counts, list completeness, cited outputs and hashes of raw local results.
- [Reproduction and integration limits](README.md) describes the synthetic fixture
  boundary and production requirements.

The initial smoke checker required the asker's literal name, so it falsely failed
the correct statement “You lead Atlas.” It also did not reject a `partial` final
outcome. The corrected checker accepts the requester pronoun and requires an
answered result. The saved outputs were re-evaluated without changing or rerunning
them; original and corrected checks are retained in the evidence.

## Next integration gate

Before any live-data comparison, prove ECHO's access check runs before **every**
outbound SDK model request, including retries, repairs and compaction. Tool hooks
alone do not establish that. Then integrate the shared audit/progress lifecycle
and exercise real provider and trigger contracts. The current prototype keeps
those requirements explicit and cannot be selected by the live Authority.

## Limit-removal comparison

Removing application caps improved the synthetic SDK prototype from 8/14 to
12/14 passing comparisons. The same `claude-sonnet-5-5` model ran seven question
types twice per arm. Three additional writer replays held the research evidence
fixed. These results establish specific failure mechanisms, not a general
production success rate.

| Question type | Original bounded prototype | Unbounded prototype | Interpretation |
| --- | --- | --- | --- |
| Two active projects and leads | 2/2 pass | 2/2 pass | Both answer the ordinary question correctly. |
| Yesterday across meetings, Jira and Confluence | 2/2 pass | 2/2 pass | Both include the decision, action and source changes. |
| All 60 active projects and their leads | 0/2 pass | 2/2 pass | The bounded list renderer names 25 and says “and 35 more”; unbounded names and cites all 60. |
| Open items across 105 tickets plus a meeting action | 0/2 pass | 0/2 pass | The bounded writer declares a gap for five hidden rows. Unbounded research skips the action body and the answer omits its checklist detail and owner. |
| Eighteen separate briefing entries | 2/2 pass | 2/2 pass | Bounded fits all 18 entries into nine statement objects; unbounded uses 18. No requested facts were lost in this case. |
| Follow a 16-document handoff chain | 0/2 pass | 2/2 pass | Bounded stops at the 12-turn SDK cap. Unbounded reaches the final page and returns `TEMPEST-816` with its citation. |
| Acquisition approval date absent from the records | 2/2 pass | 2/2 pass | Both correctly return not found without inventing a date. |

### Where the limits caused harm

The project roster demonstrates loss after successful research. Both arms
retrieved all 60 projects. The bounded renderer then applied its 25-name cap.
One bounded answer additionally mentioned the last project in a range, but
neither supplied the full requested list. Replaying the exact first bounded
research bundle through the unbounded writer produced all 60 names and citations.
The model did not need to search better to fix this failure.

The ticket comparison isolates another handoff problem. Bounded research read
all 105 ticket rows and opened the meeting action. Its answer correctly named
all six open tickets, their owners, and the action to publish the calibration
checklist. Nevertheless, the writer saw only 100 list rows and added a gap for
the five rows it could not inspect. Replaying that exact research bundle with
the unbounded writer produced the complete answer with no gap. This is evidence
against the 100-row writer cap, even though unbounded end-to-end research had
its own omission.

The linked-chain failure occurred in research itself. Both bounded runs ended
with `Reached maximum number of turns (12)` after 15.3 and 16.4 seconds. The
unbounded runs completed in 31.4 and 28.7 seconds. They needed more work and time;
the artificial turn ceiling prevented them from finishing that work.

### What removing limits did not fix

Both unrestricted open-items runs listed all 105 tickets in one call but did
not open the meeting action. Its generic title did not contain the checklist
instruction. Although the research notes included the action's owner, the final
answer omitted that owner too. Both answers marked themselves answered. More
allowance did not guarantee sufficient reading or a complete final answer.

The ten-statement limit constrained representation in the briefing test, but
the model retained all 18 separately numbered entries, codes, owners and dates.
The first scorer incorrectly equated one renderer statement with one requested
entry. The corrected scorer accepts multiple separately numbered entries in a
statement; original scores and outputs remain in the evidence. An unbounded
writer replay also produced all 18 entries from the same saved research bundle.

No trial hit the old time or estimated-cost ceiling. The runs do not establish
whether those specific ceilings help or hurt representative workloads. Shorter
times in some unbounded cases can reflect fewer pages, prompt caching and model
variation; these are not production speed measurements.

### Scope and experiment integrity

The unbounded path removes the prototype's numerical deadlines, turn/call/cost
caps, page maximum, plan/notes/reference size bounds, writer input budget,
list/name/statement/citation/output-size maxima, and application repair-count
restrictions. It retains source access checks, citation validity, types and
source-grounded answer rules. Four production source files are transformed into
a disposable renderer bundle inside the experiment cache; production source and
compiled workspaces are not edited. Each unbounded result records the patch
hashes and bundled hash.

Model context/output capacity, SDK defaults and account rate limits still apply.
Neither trial arm forwards production's OpenRouter output-token allowance to
the SDK, so this study does not test that allowance. Synthetic sources do not
exercise production network, database or external-service limits. Responses
from the unbounded writer can exceed the current client/server schema sizes;
they are prototype evidence, not release-compatible payloads.

Investigation found a prototype adapter bug: metadata-only plan citations were
incorrectly promoted into the writer's full-text evidence. That differs from
the real research loop and could mask the 100-row problem. The adapter now
prioritizes only actual full text. All four affected open-items runs were kept
but excluded, and both arms were rerun twice after the fix. No other case had
that invalid metadata state. The first comparison round also retained one
semantic-repair restriction; no additional model repair was observed there.
The final variant removes that restriction too.

There are 35 saved executions: 28 valid end-to-end comparisons, three valid
writer replays and four excluded pre-fix executions. SDK usage was unavailable
for the two turn-cap failures; their costs are unknown, not zero. Automated
checks are fixture-specific factual checks, not a semantic judge; final prose,
gaps and citation associations were also inspected.

### Follow-up validation and evidence

- 24 focused prototype tests pass, including larger plans, all 105 writer rows,
  more than five lists, 60 names/citations, more than ten statements, responses
  over 64 KiB, metadata/body separation and rejection of invented evidence or
  revoked access.
- `npm run check` passes: architecture, documentation, lint, build, TypeScript,
  and 366 test files with 5,841 passing tests, two expected failures and two
  skipped. The final suite took 260.37 seconds; focused prototype tests run
  separately from that repository suite.
- [Limit comparison evidence](limit-trial-results.json) preserves outputs,
  metrics, original/corrected checks, exclusions and raw-result hashes.
- [Limit validation record](limit-validation.json) records the final local check
  results and source hashes. [README](README.md#limit-removal-comparison) gives
  reproduction commands and the remaining integration boundaries.

This remains an isolated synthetic prototype. Nothing in this follow-up is
staged or released, and it does not qualify the SDK for live user data.

## Local staging comparison

The SDK successfully ran on this Mac against authenticated records and projects
from the existing staging Authority. It used four public Person read methods,
not the synthetic fixture and not the staging server's current research loop.
No server engine, deployment, runtime profile or client feed was changed.

This is a limited live smoke comparison. The public client does not expose the
Authority's full Jira/Confluence research desk or its follow-up source. Those
sources cannot be qualified by pointing the original prototype at a URL. The
new reader explicitly reports that limitation, uses its own comparison answer
format, and does not fabricate Authority receipts or claim to be a desktop Ask.

| Query | Local SDK observation | Assessment |
| --- | --- | --- |
| Active ECHO projects and leads | Answered from the project list and both member lists in 7.6 seconds. | Correct project identities and leads; a final-code repeat also checks this path. |
| October 16 date-handoff decision | Answered from approved meeting content in 9.0 seconds, distinguishing the imported unapproved record. | Correct decision and citation; agrees with the current server's answer. |
| Yesterday, ECHO meeting records only | Partial in 12.9 seconds. | Some canaries lack an explicit event date. The model disclosed that its day assignment was inferred from title/added date; this is not verified event-date coverage. |
| Open actions in approved meeting records | Read all 17 approved meeting records; partial in 56.0 seconds. | Retrieved actual task details and owners, but the public records did not establish current completion state. Its canary count said eleven and then thirteen in the same statement: a visible quality defect. |
| Nonexistent meeting | Not found in 4.5 seconds after a complete metadata list. | Correct abstention. |
| Yesterday across meetings, Jira and Confluence | Partial in 10.4 seconds. | Correctly disclosed that live Jira and Confluence were unavailable to this adapter; not an end-to-end success. |

Two current-server Asks provide a reference. The project query returned partial
in 62.7 seconds and described external Jira/Confluence project efforts instead
of the authoritative ECHO project list. The date-handoff question answered
correctly in 22.9 seconds. These are not controlled engine or latency comparisons:
the public-client tools, model transport, source coverage and answer writer
differ, and there is only one baseline sample per question. In particular, the
SDK project result benefits from an explicit project/member tool interface.

### Access and transport checks

The local model transport checks current Person access and repeats every
previously exposed logical read before forwarding a model request to the fixed
Anthropic HTTPS endpoint. Changed content, revoked access, an account switch or
an unverifiable read stops the run; final output gets the same check. Only
previously released S ids can be cited. The SDK receives no Person credentials.

A real synthetic SDK probe made two model requests and both traversed this
check. A second probe revoked synthetic access after a tool call: the initial
request was forwarded and the next was stopped before forwarding. Unit tests
also cover repeated requests, token counting, cancellation during a check,
unknown routes and permanent refusal after account/content changes. The final
code additionally latches a pre-dispatch account-switch failure; the first six
live cases predate that hardening and observed no account change. A final-code
project run checks normal live operation after it.

The checks intentionally reread data rather than claiming that local status
proves current permission. That costs work: the open-actions trial made 420
authenticated reads, including revalidation. This is unsuitable as the final
server design and is one reason its latency is not a production forecast.
Actual SDK compaction, service authentication, concurrent users and integration
with ECHO's audit/progress/trigger lifecycle remain unqualified.

### Evidence and next gate

Full live outputs and citations are retained only in a private local directory,
with mode 0600 files, outside the checkout. The committed
[content-free summary](staging-trial-summary.json) records result hashes, counts,
timing, model and manual assessment. [Validation](staging-validation.json) records
the focused tests and full repository check. The [runner documentation](README.md#local-staging-comparison)
describes the exact scope and reproduction path.

The next integration needs the server's real source catalog and evidence desk,
including Jira/Confluence and follow-ups, a per-request permission check tied to
that desk, supported service authentication, and the shared progress/audit and
trigger lifecycle. The local smoke results justify that work, but do not yet
satisfy the release gate for making the SDK the staging agentic engine.

## Native research integration, 2026-10-20

The next candidate connects the SDK to the actual ECHO research tool state,
request model gate, writer and release audit. It does not construct synthetic
invocation receipts in the old bridge. The model ran locally through the SDK;
source data in this round was synthetic. The preceding local staging reads
remain a separate, narrower test. No live staging deployment or default-engine
change took place.

| Case | Final result | Time |
|---|---|---:|
| Active projects and leads | Correct Atlas/Beacon leads and asker roles | 7.4 s |
| Yesterday across sources | Meeting decision/action, Jira update and Confluence change, client-local day | 11.6 s |
| Open items across 105 tickets | All six open tickets, including DEMO-102, plus the meeting action and owners | 23.3 s |
| Planner-disabled sweep | Existing sweep output says still open; SDK researcher not invoked | 2.3 s |

All four final smoke checks passed. The final answers were also inspected, not
only keyword-scored. This is one final run per case, not a latency benchmark or
proof across all real provider data. Projects/yesterday were rerun after exact
outbound evidence-packet admission was added. The sweep predates that change,
which it cannot exercise because its brief disables planning. Evidence metadata
is in [engine-integration-results.json](engine-integration-results.json); raw
synthetic outputs and logs stay in the ignored results directory.

The open-items case failed twice before the writer fix. Research had all 105
rows and the six open tickets, but the writer saw only 100 metadata rows. It
reported a false five-ticket gap. The first run also used `which_say` for a
status/owner metadata selection; clearer need-kind guidance corrected that in
the second run, which still failed at the row ceiling. Removing only the fixed
writer row ceiling resolved the remaining gap. The writer's actual context
budget still applies and accurately reports omitted rows. A focused regression
first failed with 100 versus 105 rows, then passed. Answer layout, citation and
response-size limits are unchanged.

The SDK harness uses the same scoped source catalog, normalized tools, list
continuations, known-id opens, starting evidence, completion checks and progress
as the existing loop. Each exact outbound body has a real audit digest; every
request is access-checked, including repeated requests and token counting.
Only released evidence packets actually present in an admitted inference count
as read. Streaming input/output/cache usage and actual model identity are
recorded when supplied. An audit update accommodates native request counts
without pretending they are old ECHO planner rounds. The normal final release
and retained-evaluation-result checks still run.

There is no additional SDK turn/cost limit or old numerical research-note cap.
The production request call/deadline budget, writer reserve, tool bounds and
output contracts remain. SDK-internal repair/retry classification is not inferred:
they appear as outbound requests, while `repairs` remains ECHO's explicit repair
counter. Compaction admission has a deterministic transport test, not a live
long-context stress run.

At that integration checkpoint, the service composition exposed this only as an operator-injected staging
**evaluation** driver. The shipped bootstrap does not select it, and ordinary
Ask/trigger dispatch keeps the existing engine. The SDK adapter/dependencies
remain in the evaluation package. Server packaging, provider authentication,
host concurrency/cancellation and live source canaries are the remaining
integration/release work. OpenRouter documents native Claude Agent SDK support
through its Anthropic Messages endpoint, which offers a candidate path for the
existing service provider binding; it has not been exercised by this candidate
([OpenRouter guide](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration)).

Validation of this integration candidate on 2026-10-20:

- `npm run check` passed: 367 files, 5,858 passing tests, two expected failures
  and two skipped tests. Architecture, documentation, lint, build and TypeScript
  checks passed in that same run. The local evidence is
  `results/integration-full-check.log`.
- The isolated evaluation package's 32 Node tests passed, including the outbound
  authorization fence and streaming usage parser. Focused core, audit, renderer
  and staging-evaluation tests passed before the full run.
- `npm run check:docs` and `git diff --check` passed after the report and aggregate
  result artifact were added. No deployment or update-feed operation was run.

## Staging service integration, 2026-10-20

The follow-up candidate includes #349's removal of related-atom projection and
#348's correction telemetry. It packages the SDK in the OpenRouter provider and
selects it for ordinary staging Ask and background research when the fixed
connector rehearsal profile is active. The old engine remains selected outside
staging. The existing service credential authenticates the parent's native
Anthropic Messages requests; the SDK child receives only a loopback placeholder.
The developer's Claude sign-in is not the service authentication mechanism.

Source checks now cover the shared model queue before authorization, cancellation,
provider-rate-limit retries, per-call private traces, isolated process environment,
temporary-home cleanup and the authenticated Ask route's unchanged cited answer.
The packaged executable has also completed search and finish through its real
MCP transport using synthetic local Messages replies. That local smoke observed
three model requests, all three admitted, and both requested tool calls.

No live deployment, feed publication or new OpenRouter model inference was run
for these source checks. Real provider compatibility, source canaries, long
context compaction and concurrent live load are not established by synthetic
protocol replies. Staging and final release remain subject to the existing
operator playbook and exact candidate evidence.
