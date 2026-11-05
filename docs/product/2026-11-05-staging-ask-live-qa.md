# Ask staging rehearsal, November 5, 2026

The staged source was `d138023300d75f5c2c9ea841cc5ada76e5e5667b`
(`clean-v1-20261104-ask-qa-d138023`). Matching Mac CLI and desktop clients
were installed and the owner approved that release's synthetic canary.
This is a rehearsal report, not a promotion or deployment approval.

## What ran

The main live batch contained 27 questions. Twenty-two returned answers;
two failed with HTTP 401 and three with HTTP 429. All five failed requests
returned answers in a subsequent sequential run with a fresh session and
tracing enabled. That ten-question run also repeated the historical-action
case, checked raw meeting notes globally, and included the three required
open-ended release questions. All three required checks passed with complete
release-matched traces. Two more questions isolated the completion-history
retrieval failure. Successful retries do not establish that a failure was fixed.

| Everyday use | Result on the staged build |
| --- | --- |
| Current launch plans, revised dates and budget arithmetic | Correct fixture values; plans distinguished from approvals |
| Unfinished work, overdue work and work due today | Correct four-action register and date distinctions |
| Comparing projects | Separate project facts preserved; missing approvals stated |
| Private and unfiled context | Own private note readable; unfiled note available globally and absent from project scope |
| Project boundaries | Other project's content and unmapped Jira content withheld |
| Uploaded PDF and exact quotation | Page-two requirement and marker found; requirement distinguished from passing evidence |
| Counts, percentages and long lists | 22 ledger entries total 253; 43 matching Jira tickets returned; duplicated ledger presentation found |
| Explanation, ordered next steps, timeline, profile and source quote | All seven block kinds returned; timeline actor ambiguity found |
| Missing facts and requested writes | Missing approvals stated; Ask explained that it cannot change data or send messages |
| Historical completed actions | Empty structured lists hid a completion note; naming A4 retrieved it |
| Imported notes and review status | Global read kept unapproved source notes separate from approved decisions |
| Older citations | 29 distinct note/document anchors reopened; older imported meeting reference opened with a neutral title |

Native desktop checks verified reopening a saved answer, opening its citations,
keeping the selected/latest statement visible as the source pane opened and the
window resized, copying the full Markdown answer with sources, and retaining an
unsaved Capture draft across closing/reopening. The test draft was cleared.
A new long explanation and short lead answer completed in the desktop.

The remaining native table-copy, cancellation/recovery, relaunch and block-by-
block interaction checks are incomplete: computer use subsequently reported
`cgWindowNotFound` for the installed app, although its process was running.
A request to bring its window forward remains pending.

## Root causes and candidate fixes

1. **Shared session lifetime.** Desktop refresh coordination covered only its
   own calls. A second process could rotate the credential during an active
   read; requests could also start too close to natural access expiry. The
   candidate holds private cross-process read leases through complete requests,
   waits for readers before rotation, and checks transport headroom first.
   Reads remain concurrent. Server revocation, account checks, single-use
   refresh claims and ambiguous-refresh handling remain in force.
2. **Duplicated ledger rows.** The writer declared all 22 member IDs, but the
   renderer recognized only whole titles and ticket-style keys. It rejected
   shortened note titles and added a second table. Whole-cell, unambiguous
   title phrases now count beside the existing ID and citation checks; shared
   labels, numeric amounts and mismatched members still do not.
3. **False event attribution.** The timeline contract allowed `who` to mean
   anyone involved. It now means the explicitly recorded actor for that event;
   a current owner does not establish a creator, updater or completer.
4. **Premature absence.** A completed empty filtered list could authorize
   `not_found` even when other sources held narrative evidence. When no items
   have been found and only filtered inventories were read, completion now
   requires observing a successful search outside those inventories or across
   the catalog. This checks coverage without guessing intent from wording or
   naming a provider.

The session and ledger failures have focused red/green reproductions. The
completion-rule reproduction accepted false absence before the change and
refuses it afterward, including unobserved results from a native tool batch.
A separate-process session proof covers a terminal read versus desktop refresh;
additional checks cover parallel readers, cancellation, expiry headroom, dead
process cleanup and unsafe local operation files.

Three exact live timeline-payload native Sonnet 5.5 replays changed from two
bad actor attributions before the contract change to three correct results.
Six additional actor probes passed, including preserving explicitly named
historical actors. Three native research/writer fixture replays with the new
completion rule found A4 and its completion date; the actor question explicitly
reported that the person who changed its status was not recorded. These are
local native model replays, not deployment evidence for the new commits.

## Remaining limits

- Upstream Jira/Confluence responses reported HTTP 429, allowance 120 and
  remaining zero during the concurrent stress batch. Sequential reruns passed.
  No model-call rate-limit failure was observed. Sustained concurrency at that
  source allowance is not qualified; this candidate does not weaken permission
  fences or silently retry a complete Ask to conceal it.
- The person asking was the owner. Own-private and project-scope checks do not
  prove isolation between two independently signed-in employees.
- Linux packages built in an x64 container emulated on Apple silicon; this is
  not a native Linux desktop rehearsal.
- No saved imported-meeting citation was found for a historical-anchor desktop
  check. That regression retains automated coverage; a saved imported meeting
  reference and historical note/document anchors were checked live.
- The new fixes require review, CI and another release-bound staging rehearsal.
  The staged build remains the earlier `d138023` candidate, not these fixes.

Private execution outputs, source reads, normalized traces, native replay
results and screenshots are under the operator's
`$HOME/.local/state/echo-staging-ask-qa-20261104` directory. Raw traces and
account material are not included in the repository.
