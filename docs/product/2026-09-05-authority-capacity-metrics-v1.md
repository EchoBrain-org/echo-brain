# Authority capacity metrics V1

Status: pinned evaluation rules; the harness and baseline are not implemented.
No capacity milestone has passed. The numerical contract is
[metrics.v1.json](../../tools/capacity/metrics.v1.json), including its profile
digest. Check it with
`node tools/capacity/verify-contract.mjs`. That command checks the definition;
it does not run a benchmark or establish capacity.

## Scope and milestones

N and searchable history are the two milestone coordinates. Every point must
pass the same usability, efficiency and correctness gates. This exercise
excludes extraction accuracy/recall, relationship quality, answer/planning
quality, prompt tuning, model selection and live LLM variability. All external
inference is simulated, in production wire format, with deterministic outputs
and scripted delays. No live model or model-based grader participates.

| Point | Active employees N | Searchable history | Historical atoms minimum | Historical postings minimum |
| --- | ---: | --- | ---: | ---: |
| M1: baseline checkpoint | 10 | 30 calendar / 20 working days | 350 | 8,750 |
| M2: capacity target | 50 | 365 calendar / 250 working days | 21,875 | 546,875 |
| M3: capacity target | 250 | 730 calendar / 500 working days | 218,750 | 5,468,750 |

M1 may pass unchanged. Measure it before describing any optimization gain.
M2/M3 prove usable capacity under this workload, not a particular architecture
or the maximum capacity of the machine. Passing by a simple, correct
optimization is valid. After the baseline, measure the N/history frontier and
resource use before deciding whether a larger target is useful. There is no M4
or smaller reference machine in V1.

An active employee is a distinct current Person membership that performs its
share of real authenticated HTTP requests and completes at least one correct
search and answer. M1 covers consumption of the current single-owner feed.
M2/M3 require independent admitted source coverage for all N employees, each
with a historical or timed source revision and independently verified cursor
state. Configuration entries and inactive accounts do not qualify.

History means the complete approved corpus is retained and searchable at both
start and finish while new work is processed. Spread atoms over ten equal
calendar-age buckets with equal counts, rounded deterministically; at least
one source is the full target age. Volume is N * working days * 0.5 distinct
meetings * 70% approved * five atoms. A shared meeting is counted once. Use
70% organization-member and 30% exact-reviewer private atoms, spread across the
required owners. Only the current two policy types are used.

## Pass/fail gates

| Metric | Observable completion | Pass |
| --- | --- | --- |
| Authorized search | Complete correct HTTP response | p95 <= 500 ms |
| Complete answer | Expected fixture answer with request-local authorized citations; release audit durable before any answer body bytes | p95 <= 15 seconds |
| Source to review card | Complete source available to delivery of the complete, correctly addressed frozen card matching the expected extracted atoms and provenance | p95 <= 3 minutes |
| Approval to search | First signed approval offer to successful authorized retrieval with independent proof of membership in the actual active exact-head generation | p95 <= 60 seconds |
| Request reliability | Correct response within 2 seconds for search / 30 seconds for answers, without user retry | >= 99.5% per population |
| Historical retrieval | Positive historical probes plus negative probes | 200/200 positives for M1/M2, 250/250 for M3; 20/20 additional negatives |
| Corpus completeness | Complete expected atoms/content/policy and logical postings versus actual approved record/index | Zero missing, extra or wrong entries |
| Provider work | External per-stage call and wire-byte ledger against its permitted work budget | <= 1.02x expected; no hedged calls |
| Final backlog | All eligible work complete after the fixed eight-hour trace boundary | Zero within 10 minutes |
| Timed correctness | Permission probes, crash/recovery and publication/audit ordering | 100% required assertions pass |
| Durable replay | Required process-death and storage-fault outcomes | Zero lost acknowledged work, duplicate canonical appends, invalid publications or unexpected effects |

Search p95 and reliability are evaluated independently for direct user searches,
availability probes and historical probes; historical probes require 100%
success. Answers have their own independent gates. Combined rates are
diagnostic. No large probe population can dilute user failures.

All timings begin at scheduled offer time on an external monotonic clock,
including driver emission lag, network time, queueing and processing. The
driver never waits for previous completions before offering the next request.
Driver overload needs independent evidence and makes the affected run
inconclusive, not a quieter workload.

Use nearest-rank p95: sort all offered eligible operations and select rank
ceil(0.95 * count). Incorrect, failed, timed-out and unfinished operations have
infinite latency. Zero samples is NOT-RUN. HTTP 200, a refusal, an empty result,
a queued receipt or an extra user retry is not successful work unless that is
the predeclared expected result. Report raw counts; 99.5% with only 55 M1
answers means all 55 must succeed, not a statistical production guarantee.

The source/card population includes every planned actionable source revision,
including missing cards. Observe unresolved cards through ten minutes from
source availability, and unresolved publication through five minutes from
approval offer; misses remain in the denominator. Approval timing begins at
the first offered signed request even if its acknowledgement is lost. A missing
card has no fictitious approval latency sample and remains failed source work
and unfinished backlog.

Normal meetings receive a sealed approve/reject decision, 70% approved with
deterministic rounding, offered 30 seconds after the complete card. The final
drain starts exactly at hour eight. Dependent actions continue during the
drain; they never move its ten-minute deadline. Missing cards and delayed human
actions cannot excuse unfinished work. Predeclared fault-only quarantines have
their own expected outcomes.

## Sealed runs and independent verification

Determinism means reproducible after reveal, not known to the candidate before
execution. Use this order for a qualification attempt:

1. Freeze the independently reviewed verifier, generator, oracle and environment
   artifacts. Record their digests in the verifier-owned environment lock.
2. Register the immutable candidate image, source commit, configuration,
   requested milestone and V1 profile digest.
3. The verifier generates fresh held-out corpus content, trace, queries,
   fixture realization and fault schedule. Publish a timestamped, salted
   manifest commitment in an append-only registry before startup.
4. Start from freshly seeded historical state, build/warm the candidate within
   its resource budget, then execute the trace. Warm-up is capped at 30 minutes;
   report its time and effects. It includes no future query/probe information.
5. Record every result, reveal the manifest, verify the commitment and issue
   the verdict. Revealed seeds may be used for diagnostics but never qualify
   another candidate.

Anchor each registration and manifest commitment outside the runner's rewrite
authority before startup: use a signed tag pushed to a protected remote with
independently retained receipts, or an independently verifiable third-party
timestamp over the commitment. A local append-only file, an unpushed tag or a
remote tag the runner can silently delete is insufficient. Keep the external
receipt with every attempt; inability to obtain it is NOT-RUN.

The candidate cannot read verifier files, seeds, expected results, future
arrivals, registry credentials or administration endpoints. Use separate hosts
and identities, restricted mounts and network access only to the normal
provider interfaces. Candidate image/configuration is identical across warm-up,
load and faults. No benchmark recognition, fixture branch, test-mode bypass or
state copied from an earlier attempt is allowed.

The driver mints a nonce at each actual offer. An external ledger binds it to
the request, provider exchanges, response digest and matching durable release
audit digest. Transport correlation may use existing request metadata; if the
current client/audit path cannot supply the binding, implementing that support
is a qualification prerequisite. Current audits have no offer nonce: repeated
identical response digests alone cannot uniquely bind two different requests.
Qualification needs a durable request/nonce binding with a reviewed audit/trace
design; headers alone are insufficient. Do not silently change canonical schemas or
treat an unbound nonce echoed in a response as proof.

A nonce proves correlation, not retrieval or computation. General indexing,
warming and correct generation/scope-aware caches are valid optimizations.
Sealed future-query answer tables are forbidden. Evidence-bound fixtures,
broad held-out queries, complete index comparison and independent release-time
storage observations jointly detect shortcuts. This assumes a trusted runner
and independently reviewed oracle, not an adversary controlling the verifier
or host kernel. The oracle must not import candidate implementations.

One registered qualification attempt is allowed per candidate/configuration,
profile and milestone. A measured FAIL cannot be rerun away. Only an
independently evidenced infrastructure INCONCLUSIVE permits a replacement, and
all attempts stay in the report. A measured gate failure remains FAIL even if
a later infrastructure fault occurs. Cosmetic image/metadata changes do not
create a fresh qualification entitlement. Local exploratory runs are separate.

## Retrieval workload

Use a 4,096-word vocabulary of ordinary lowercase alphabetic words, 4-12
characters, with vocabulary ranks sampled from Zipf exponent 1.1. Each atom has
20-30 distinct content terms; construct the full corpus to average exactly 25
postings per atom including controlled category terms. For repeated content
terms, frequencies 1/2/3 have probabilities 70%/20%/10%. Record actual vocabulary
usage, frequency histograms, text bytes and the analyzer-derived posting count.
The sealed generator and its shape checks are part of the locked verifier;
failure to construct the declared shape is INCONCLUSIVE before load, never
permission to substitute an easier corpus.

| User/availability query class | Share | Shape and oracle |
| --- | ---: | --- |
| Selective | 40% | Two ordinary terms, each present in at least two documents; identifying co-occurrence is unique |
| Medium | 30% | 2-4 terms matching at least 100 authorized atoms before ranking |
| Broad | 20% | 1-3 terms matching at least 200 authorized atoms for M1, 1,000 for M2/M3 |
| Negative | 10% | Ordinary-looking absent terms; exactly zero hits |

Candidate count means the authorized union of matches to any analyzed query
term, before top-k. The current engine scores term-frequency sums, not Boolean
AND matches. The sealed oracle computes the exact ordered top ten under the
current analyzer and tie-break rules: score descending, log position descending,
atom order ascending, then bytewise atom ID. Selective positive probes require
their designated atom in that top ten. This tests deterministic retrieval
semantics, not subjective relevance or LLM quality.

Every direct Layer 3 search uses limit=10 and must return the entire expected
ordered list of atom IDs, record hashes, policy IDs and text/content digests;
returning only the named target fails. Negative responses must be empty. Apply
shape/count checks after query analysis, including decision-family expansion.
Answer retrieval retains its existing batch merge and related-packet behavior;
the single-query top-ten rule does not replace that composition contract.
Compute each ordinary search's expected list against the independently observed
active record head at offer time, or a newer independently validated head used
at release, never an older head; the existing exact-current-head and current
Person release fences still apply. Bind the oracle to that actual head's hash
and verified lineage, not the start/end corpus or position alone.

Select max(200, N) distinct historical target atoms across all age buckets
(at least ten per bucket), both policies and all required owners, using positive
ordinary-term queries whose expected top ten contains the target. Add twenty
negative history probes; those do not substitute for positive coverage.
Queries are held out until offer, not stored as searchable marker fields.
Owner coverage means each owner at least once and both policies globally,
not every owner/policy pair; M3 has 250 positive probes, not 500.

Independently derive every logical (term, atom_id, term_frequency) entry from
approved source content with the pinned analyzer, including all non-query
terms. Compare that entire multiset and the full fact/content/policy set to the
actual index at start and finish, and validate sampled active generations during
load. Different physical index layouts are allowed if an independent decoder
can verify the same logical contents. Dumping a manifest supplied by the
candidate is not a comparison. Five million declared postings without these
entries cannot pass.

The trusted decoder checks every physical segment's logical contents and
policy scope. Each sampled active generation must equal the trusted expected
fact/content/policy sets and independently recomputed logical roots for its
exact approved head, not merely contain no unapproved facts.

## Production-shaped fixtures and bounded provider work

Fixtures are separate HTTP servers reached through production provider clients.
They return the production model wire envelope, including text-encoded structured
output where that is the real protocol. Parsing, validation, canonicalization,
retrieval, ranking, permission checks, persistence and response composition all
stay inside the candidate allocation. The fixture cannot return preprocessed
internal objects or answer a search on the candidate's behalf.

The planner returns query terms only, no atom IDs or citations. The answer
fixture parses the supplied evidence and verifies required atom IDs and content
digests against this request's actual authorized Layer 3 release. Reject missing
required evidence, unauthorized extras, stale evidence or mismatched content.
Return only citations already present in valid supplied evidence. Independent
storage/response/audit observations establish the release; the fixture's hidden
oracle is an input validator, never a source of missing evidence.

The current answer wire payload contains sources as citation aliases and text,
not raw atom IDs or content digests. Preserve that production shape: the
verifier binds aliases/text digests to the independently observed Layer 3
release and checks the final atom citations and prompt/response audit digests.
Do not require a test-only evidence schema or hand atom IDs to the candidate.

The fixture server issues attempt ordinals and causal tokens. An answer-generation
request must follow its planner response and Layer 3 evidence release. A
projection request must follow a verified approved-record snapshot for its exact
segment; an extraction response token alone does not establish approval.
Keep causal tokens in the transport/effect ledger, not as raw-transcript or
identity fields in the projection model payload. The verifier validates every
edge and counts cancelled, rejected and duplicate requests.

The current generation port does not forward such causal metadata. A generic
production transport mechanism is required: the planner HTTP response returns
an opaque token that the answer HTTP request must present, and a snapshot-bound
token similarly precedes projection. External ledger timestamps alone cannot
prove a dependency. This missing transport support is a prerequisite, not an
assumed property of today's port or a fixture-only candidate branch.

Ordinary answers permit at most one planner and one answer call, as the current
release contract requires. Extraction permits one call per actionable revision;
projection permits at most one per eligible segment and approved head. No
concurrent duplicate or successful-stage retry is allowed. The per-stage upper
call budget is floor(1.02 * expected calls); stages cannot pool allowances.
Expected work comes from the sealed trace's prescribed outcomes, not the
candidate's successfully completed subset; dropping a planned operation cannot
shrink its denominator or earn a correctness credit.
Projection's overall bound is (planned approved meetings + 1) * admitted
segments, counting initial build. Legitimate coalescing/reuse may reduce work.
The single timed crash permits at most one additional call per affected stage,
only for a root the external ledger proves was interrupted; add that to expected
calls before the multiplier. Separate failure cases have explicit case budgets.

Also bound production request-plus-response wire bytes per inference stage to
1.02x the permitted canonical payloads for those calls, including every attempt.
For answers, canonical request bytes mean the oracle's expected evidence packet
under the existing ranking, batch merge, related expansion and context bounds,
not all authorized matches or the candidate's chosen oversized packet.
Byte counts are deterministic; live model token accounting is outside this
exercise. No unused allowance authorizes violating per-request call contracts.
Other provider effects must match their declared source-poll/card/action protocol.
Report call counts and bytes even when the candidate fails.

Draw delays from continuous uniform distributions, deterministically using the
sealed seed, semantic root and server-issued ordinal, rounded to milliseconds:

| Stage | Delay range |
| --- | --- |
| Source HTTP | 50-500 ms |
| Extraction | 10-45 seconds |
| Relationship projection | 1-8 seconds |
| Answer planner | 0.5-3 seconds |
| Answer generation | 3-10 seconds |
| Approval provider HTTP | 50-500 ms |
| Identity provider HTTP | 25-200 ms |

These are assumptions, not measurements of live models. Every candidate gets
the same distribution and rules, with a fresh hidden realization. End-to-end
gates include the simulated wait; no subtraction of provider time is allowed.
Continuous delays do not prevent all inference about remaining wait, so the
call/causality limits remain essential. Changing the distribution, payload
contract or budgets requires V2.

Report scripted-wait p95 and sample count for every operation population,
alongside end-to-end p95: use the prescribed causal path's per-operation sum of
scripted waits, including failed/unfinished operations' planned waits, rather
than adding stage percentiles. Also report actual observed provider waits and
their completed/missing counts. These diagnostics attribute near misses; they
never subtract latency or change pass/fail thresholds.

## Publication and observable completion

Card availability requires the complete frozen content, expected atom set,
provenance and correct recipient in the external provider ledger. An empty
shell or placeholder does not start approval. Subsequent semantic content
mutation fails; declared status/button changes after action remain allowed.

No unapproved atom content, IDs or postings may appear in a Layer 2 staging or
published generation or projection request. Preapproval processing is limited
to ordinary extraction/review-card work and generic scaffolding; reusing already
approved index data is allowed. The generation must be rooted in the verified
approved record snapshot. Delaying the card does not authorize building an
approval-specific generation before approval.

At every successful approval-visibility poll, an independent observer must
correlate the release with the actual active pointer, record head, immutable
manifest and returned atom's content/policy membership at that release. Preserve
the matching observation before later publication can replace it. A response
label alone is insufficient. If races prevent this correlation, do not award
success; the first later verifiable result determines latency. Poll every 250 ms
without subtracting the interval.

Dependent visibility polls do not enter ordinary reliability. Rotating
availability probes do, including failures during publication. At each
approval's 60-second deadline, add its facts to the availability pool and probe
with the owner and a different reader using the expected policy result.
Record every such probe as declared additional traffic. Inspect at least 24
sealed-time generation snapshots during load and verify they contain only their
approved snapshot, including staging generations where applicable.

Record every full build, incremental update, compaction and recovery operation,
with causal head, bytes and duration. Full rebuilds are allowed, including at
the end; their time/resource cost counts, and they cannot repair an earlier
failed publication observation. Load-adaptive maintenance is allowed; using
the sealed peak schedule is forbidden.

## Timed load, faults and hardware

Offer one real eight-hour workday: 0.5 distinct meetings, five full answer
requests and five direct searches per employee. Raise those three arrival rates
to 4x for 15 minutes, with peak start chosen uniformly by the verifier between
hours two and six. Reveal the time only after the run. Peak load adds traffic:
ceil(base count * (1 + 3 * 15 / 480)).

| Point | Meetings | Answers | Direct searches |
| --- | ---: | ---: | ---: |
| M1 | 6 | 55 | 55 |
| M2 | 28 | 274 | 274 |
| M3 | 137 | 1,368 | 1,368 |

Add 2,880 rotating availability searches (one per ten seconds), historical
probes, publication checks and new-fact policy probes. Record all traffic and
its population. All N employees must participate; quiet identities do not
inflate N.

Interleave forty permission cases, four seeds for each of: wrong reviewer,
revoked member, revocation during an answer, cross-org session, expired session,
invalid approval signature, cross-segment relationship, unapproved content,
unreleased citation and stale-generation release. At least ten occur during
peak. Their planned deny/fail-closed results are excluded from ordinary success
rates but must all pass. Isolate fault-case identities where necessary so their
expected access changes do not silently reclassify ordinary failures.

Kill the entire candidate cgroup once at a sealed time during peak and restart
from the same image/state. Arrivals continue. Ordinary operations affected by
the crash remain in the usual denominators and keep the same deadlines.
Recovery must restore authorized search/answer readiness within 60 seconds,
and preserve every required durable effect. A separate recovery statistic
cannot forgive a failed ordinary gate.

The 60-second readiness check is an additional ceiling, not a grace period.
Depending on arrival timing, the ordinary deadlines can require a much faster
restart; a single failed M1 user answer or direct search fails its 99.5% gate.
One sealed attempt therefore retains workload variance: M1 has little answer
headroom, and a kill during an in-flight answer can produce a measured FAIL
without a rerun. The peak is observable, so a candidate can anticipate that
V1's kill will occur during peak. V2 may move the kill anywhere in the run;
V1 makes no claim to hide that conditioning.

The reference machine is an AWS EC2
[c7i.xlarge](https://aws.amazon.com/ec2/instance-types/c7i/), four vCPUs and
8 GiB RAM, in us-west-2, running Ubuntu Server 24.04 LTS x86_64. Use a dedicated
100-GiB encrypted [gp3](https://docs.aws.amazon.com/ebs/latest/userguide/general-purpose.html)
state volume at 3,000 IOPS / 125 MiB/s, ext4 with normal write barriers.
Driver/fixtures run on separate hosts in the same availability zone; candidate
children all remain in its allocation. No swap or durable tmpfs/overlay state.
The image root is read-only; durable writes go to the named state volume.

Before baseline, lock exact AMI, kernel, CPU topology, device/mount properties,
runtime/native libraries and observer versions in a verifier-owned environment
manifest. Freeze that lock across comparisons. This pin is not yet created;
no qualifying run can start without it. An unrestricted Mac run is diagnostic.
No infrastructure provisioning is authorized by this metric document.

## Durability and audit ordering

The current record, Authority, control and retrieval writers set
`journal_mode=DELETE` and `synchronous=FULL`. Record each writer's policy,
native SQLite/VFS identity and changes throughout the run; a final PRAGMA query
on a different connection is insufficient. Trace commit/sync completion and
external acknowledgements independently. Forbid silent weaker durability,
memory-backed persistent state or bypassing audited release.

Whole-cgroup SIGKILL clears candidate processes, not kernel page cache. Add
eighteen process-death cases, before/after candidate persistence, cursor advance,
approval receipt, provider effect, V4 append, terminal receipt, generation rename,
pointer publication and answer-audit commit. Verify every expected durable
record, cursor and effect after restarting. Retain duplicate-source,
duplicate-approval, lost-provider-acknowledgement and existing regression tests.

Add four separate storage-fault cases at acknowledged approval receipt,
acknowledged V4 append, committed active pointer and answer audit before first
response byte. Use a verifier-controlled flush-aware volatile storage layer:
preserve successfully completed flushes, discard only unflushed data/metadata,
then recover with caches gone. Validate this fault model with both a synced-write
survival control and an unsynced-write loss control. Record the modeled faults;
this is bounded durability evidence, not proof against every physical failure.

Do not substitute `dm-flakey drop_writes` alone: it
[silently drops all writes during its down interval](https://docs.kernel.org/admin-guide/device-mapper/dm-flakey.html),
which is not the same as losing only unflushed writes. Do not require one fsync
per acknowledgement: group commits may safely cover multiple operations. Require
the durable commit to cover every acknowledged effect before release. A WAL/FULL
or other storage change is eligible only with preserved contracts and independent
fault evidence, never a faster PRAGMA setting alone.
[SQLite documents](https://www.sqlite.org/pragma.html#pragma_synchronous)
that WAL/NORMAL can lose committed transactions on power failure, and that
DELETE/FULL itself does not establish unconditional power-loss durability.
The baseline therefore has to earn this gate too.

The current answer path already awaits the audit insert before HTTP completion.
Protect that ordering by withholding/failing audit persistence and observing
that no answer body bytes escape, then killing after audit commit but before
HTTP write. “Response sent, audit not durable” is a forbidden state, not an
acceptable crash boundary. Verify request/response/audit digest binding after
restart. A completed answer must include the cost of its durable audit.

## Versioning, evidence and limitations

The V1 rules are now content-pinned in the JSON. The final search-head,
evidence-byte, diagnostics and external-commitment clarifications were re-pinned
before any baseline or qualification attempt, as explicitly authorized.
Earlier drafts had no qualifying
runs; they are not alternate profiles on which a milestone can be claimed.
Changing any pinned rule requires metrics V2 and a comparable baseline.
The verifier must check the accepted V1 digest against its own registry;
a candidate cannot update its local hash and award itself a new V1.

A claim includes the candidate/configuration/profile/environment/verifier
digests, every qualification attempt, sealed commitment and reveal, corpus and
query-shape checks, all offered/failed/unfinished counts, external timings,
provider causal/cost ledgers, complete-card history, release-time generation
proofs, logical index comparisons, crash/storage-fault results and repository
checks. Candidate telemetry may diagnose but cannot award PASS. CPU, memory,
disk bytes and phase timings remain diagnostics; provider budgets and durable
ordering are hard gates.

The sealed runner, independent oracle, production-wire fixtures, causal audit
binding, host/environment lock and storage-fault observer are implementation
prerequisites. Their absence is NOT-RUN, not evidence of zero violations.
The checker accompanying this document only validates definitions and digests.

Current-code anchors:
[search admission limits](../../packages/organization-retrieval/src/readable-search-engine-v1.ts),
[analyzer and ranking](../../packages/organization-retrieval/src/application/analyzer.ts),
[record DB durability](../../packages/organization-record/src/persistence/open-organization-record-database.ts),
[search release](../../services/organization-authority/src/composition/person-record-search-route.ts),
[answer/audit ordering](../../services/organization-authority/src/answer-composition/retrieval-grounded-answer-composition.ts).
The [release invariant](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md)
and [projection decision](../decisions/ADR-0010-disposable-related-atom-projection-v1.md)
remain binding. The current reader scans admitted postings/facts; actual
on-disk bytes, RSS and maximum usable capacity must be measured. Atom/posting
counts alone neither establish a 50-MB footprint nor force an architecture.

Overall PASS requires the requested N/history/source coverage and every gate
for the same candidate, with complete evidence. Measured misses are FAIL;
missing prerequisites are NOT-RUN; independently evidenced harness faults are
INCONCLUSIVE. Short or virtual-time runs support iteration but cannot qualify.
