# ECHO scaling decision guide

Scale the resource that is actually limiting completed work. Start with host
capacity and concurrency tuning; change the architecture when measurements show
that shared state or processing is the bottleneck.

Source baseline: `aa92138e4a7d8386b2ff51a95c7d2f82e86236be`, checked October 30,
2026; record search was measured and raised on October 31, 2026. Numbers below
are configuration limits, not a tested maximum customer count.

## Choose what to change

| Symptom | Who controls it | First change to evaluate |
| --- | --- | --- |
| Questions wait before research starts | ECHO | Raise SDK session and model-call concurrency together, with enough memory. |
| Memory fills or processes are killed | AWS capacity and SDK resource use | Increase host RAM; measure the whole process tree, not just the ECHO process. |
| Requests expire while waiting | ECHO, plus proxy timeouts | Improve admission and queue handling. Use durable asynchronous jobs if work needs to outlive a request. |
| Meetings or sweeps fall behind while Ask stays busy | ECHO | Reserve background capacity and improve scheduling; then increase worker concurrency. |
| Documents wait to be processed | ECHO | Increase the bounded parser worker pool; it currently parses one document at a time. |
| The app slows as stored history grows | ECHO | Profile synchronous database work and full search rebuilds; improve queries and consider incremental indexing or separate workers. |
| Older items disappear from search or summaries | ECHO | Fix coverage limits with pagination or indexed queries. More RAM does not fix a truncated search. |
| The log shows `echo-clean-live-search-capacity-v1`, or approved items stop reaching search, lists, or Ask | ECHO | Check the record-search ceiling below. Raising it is a code change backed by a new measurement; more RAM does not raise it. |
| Providers return rate or budget errors | OpenRouter, model provider, or connector service | Check the exact account, app, tenant, and endpoint limit. Add capacity where available; batch and pace requests. |
| More customers are hard to provision or upgrade | ECHO operations and AWS quotas | Automate isolated deployments, staged rollouts, backups, and recovery; check regional quotas before adding hosts. |
| One organization needs several active servers | ECHO architecture | Design shared persistence and job coordination before adding replicas. |

## Limits to check first

- **Research:** 3 SDK sessions total, at most 2 background. Model calls: 6 total,
  at most 4 background. These are ECHO settings, not SDK service limits.
- **Request duration:** Ask has 90 seconds including waiting, with 25 seconds
  reserved for writing. Background research has 300 seconds. Ask allows 24
  model requests; background research allows 48.
- **Intake:** 3 meeting-processing lanes; 4 running trigger jobs, which still
  share the smaller research limits. One document parser.
- **Coverage:** upload-search V2/V3 endpoints consider the newest 1,000
  submissions. Some open-item scopes read at most 500 project records or 5,000
  item rows. A 25-row research list page supports continuation and is not a
  total inventory limit.
- **Record search:** one search generation admits at most 8,192 approved items
  (atoms) organization-wide, 128 permission segments (one per approver with
  Only me items and one per distinct set of audience projects), 4,096 bytes of
  text per item, and 204,800 index postings (25 per item; approved items carry
  about 15 to 17). At about 9 items per approved meeting and 0.35 approved
  meetings per person per workday, a 10-person organization reaches 8,192
  items in about a year and a 25-person one in about five months.
  Each publication rebuilds the whole generation synchronously, so the process
  pauses for roughly 0.13 ms per item plus 9 ms per segment. At the full
  ceiling that measured about 2.5 s to build and 0.5 s to prewarm on an
  Apple-silicon laptop; expect roughly twice that on a `t4g.small`. The warm
  generation holds about 10 KB per item in memory. Each publication then
  deletes every generation it replaced; a failed deletion is logged as a
  worker failure and retried at the next publication.
  After a publication at 75% or more of any limit, the service logs
  `echo-clean-live-search-capacity-v1` with `status` `near` and the counts. A
  build past a limit is refused: on every worker cycle the service logs the
  same kind with `status` `over` and the limit's name, plus
  `echo-clean-live-worker-failed-v1`. Reads need a generation built for the
  record log's exact head (`PersonRecordSearchIndexLagV1`), so record search
  and lists become unavailable, Ask answers without approved meetings, and
  impact checks keep retrying. A restart still opens the API. Raise the ceiling
  again only with a new measurement; well beyond it, move the rebuild off the
  request thread or make it incremental.
- **Infrastructure:** the staging template permits only `t4g.nano`, `small`,
  and `medium`. Larger hosts require a template change. AWS CPU, memory,
  storage performance, and regional quotas are separate capacity decisions.

See the [concurrency settings](../../services/organization-authority/src/composition/model-call-limiter-v1.ts),
[research budgets](../../packages/organization-authority-kernel/src/answer-composition/agentic-research-v1.ts),
[upload search](../../services/organization-authority/src/adapters/persistence/sqlite/project-context-v1.ts),
[open-item limits](../../services/organization-authority/src/composition/person-open-items-v1.ts),
[search ceiling](../../packages/organization-retrieval/src/readable-search-engine-v1.ts),
[startup order](../../services/organization-authority/src/composition/organization-authority-service-lifecycle.ts),
and [deployment template](../../deploy/organization-authority/authority-staging-host-v1.template.json)
when updating these values.

## Prove an improvement

1. Compare the same workload at 1, 3, 6, and 10 simultaneous questions, with
   representative data and background processing enabled.
2. Measure completed answers per minute, queue wait, slow-answer latency,
   partial answers/errors, peak host memory, CPU, and background backlog.
3. Keep the change only if completed work improves without unacceptable
   failures or delayed background work. Stop increasing concurrency when the
   bottleneck moves elsewhere.

More concurrency does not inherently increase tokens per answer. It increases
the rate of work and can increase wasted spend if failures cause retries.

## Boundaries to preserve

More organizations can reuse the same application image. The accepted design
keeps [one isolated Authority per organization](../decisions/ADR-0008-echo-hosted-authority-by-default.md).
Running several replicas for one organization requires the later coordination
design described in [workspace boundaries](organization-workspace-boundaries.md).
Keep identity, access checks, and evidence isolation intact when parallelizing.

Provider limits must be checked for the actual account and route:
[OpenRouter](https://openrouter.ai/docs/api_reference/limits),
[SDK hosting](https://code.claude.com/docs/en/agent-sdk/hosting),
[AWS quotas](https://docs.aws.amazon.com/ec2/latest/instancetypes/ec2-instance-quotas.html),
[Cloudflare](https://developers.cloudflare.com/fundamentals/reference/connection-limits/),
[Jira](https://developer.atlassian.com/cloud/jira/platform/rate-limiting/), and
[Confluence](https://developer.atlassian.com/cloud/confluence/rate-limiting/).
Use the [Authority operator playbook](../operations/PB-OPERATIONS-001-authority-operator-lane.md)
for deployment changes.
