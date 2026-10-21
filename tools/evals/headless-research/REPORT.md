# Claude research experiment summary

These trials motivated the native SDK integration and removal of the writer's
fixed 100-row handoff limit. They do not establish production success rates,
latency improvements or live deployment readiness.

The [archived report](https://github.com/EchoBrain-org/echo-brain/blob/070b6adeb4c1cceccc7b8d309a2f9c4ad17e6601/tools/evals/headless-research/REPORT.md)
retains methods, limitations, exclusions, validation records and links to the
full results. The [archive instructions](README.md) include a downloadable source
snapshot with the matching runners, fixtures, tests and dependencies.

## Synthetic comparisons

The original trial used Claude Agent SDK `0.3.305`, CLI `2.1.302` and
`claude-sonnet-5-5` with invented ECHO-shaped evidence. Both engines used the
existing renderer. The SDK opened the records needed for the yesterday answer;
the custom-loop trial stopped at metadata. Both paginated all 105 tickets, but
the writer saw only 100 rows and reported an artificial coverage gap.

A subsequent limit comparison ran seven question types twice per arm:

| Case | Bounded prototype | Unbounded prototype |
| --- | --- | --- |
| Two active projects and leads | 2/2 pass | 2/2 pass |
| Yesterday across sources | 2/2 pass | 2/2 pass |
| All 60 projects and leads | 0/2 pass | 2/2 pass |
| Open work across 105 tickets plus a meeting action | 0/2 pass | 0/2 pass |
| Eighteen briefing entries | 2/2 pass | 2/2 pass |
| Sixteen-document handoff chain | 0/2 pass | 2/2 pass |
| Absent acquisition approval date | 2/2 pass | 2/2 pass |

The bounded roster lost names at rendering; the chain hit the prototype's
12-turn cap. Replaying the same ticket research with the writer cutoff removed
eliminated the false five-row gap. Unbounded research still missed the meeting
action's body in both end-to-end runs. More allowance did not guarantee a
complete answer, and no trial established the effect of time or cost ceilings.
The archive preserves 28 valid comparisons, three writer replays and four
excluded executions affected by a prototype metadata/body adapter bug.

## Local staging reads

A local SDK client answered project/lead and known dated-meeting questions from
authenticated Person reads. Yesterday and open-action queries remained partial
where event dates or current completion state were not established. The public
client lacked live Jira/Confluence research tools, so those sources were not
qualified. That comparison did not replace the server engine. Private record
bodies were kept outside the repository; the archive contains bounded summaries.

## Native integration evidence

The final synthetic native-driver runs passed projects, yesterday, 105-ticket
open work and the planner-disabled sweep. The open-work answer included all six
open tickets and the meeting action after the writer cutoff was removed. These
were individual smoke trials, not a representative production benchmark.

Retained application tests cover access admission, observed evidence, pagination,
writer coverage, auditing, provider/network recovery, cancellation and unchanged
cited answers. The offline package check exercises the actual packaged SDK and
MCP transport with synthetic replies. These proofs do not substitute for live
provider/source checks or the separate canary and release decisions described
in the [integration README](README.md#staging-service-adapter).
