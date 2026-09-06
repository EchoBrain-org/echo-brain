# Authority core capacity metrics V2

No capacity milestone has passed. This frozen profile measures the Authority's
core runtime only: current-Person authorization, canonical record append,
publication, retrieval, deterministic evidence composition, audit ordering and
replay. It excludes providers, HTTP transport, OIDC, Slack, model behavior,
prompt quality, provider costs and provider latency.

The executable coordinates are [metrics.v2.json](../../tools/capacity/metrics.v2.json).
`node tools/capacity/verify-contract.mjs` checks its definition digest and
numeric invariants. That check is not a run and never passes a milestone.

| Point | Active employees N | Searchable history | Atoms minimum | Postings minimum |
| --- | ---: | --- | ---: | ---: |
| M1 | 10 | 30 calendar / 20 workdays | 350 | 8,750 |
| M2 | 50 | 365 calendar / 250 workdays | 21,875 | 546,875 |
| M3 | 250 | 730 calendar / 500 workdays | 218,750 | 5,468,750 |

The history shape is `N * workdays * 0.5 meetings * 0.7 approved * 5 atoms`.
Every atom has exactly 25 analyzer-derived postings on average. M1 is the
baseline checkpoint; M2 and M3 are usable targets, not architecture claims.

## Workload and gates

The timed qualification run lasts eight real hours. A verifier chooses a hidden
15-minute 4x peak between hours two and six. Arrivals are fixed before the run
and do not move for backlog. A ten-minute drain begins at hour eight.

| Population | p95 | Deadline | Required success |
| --- | ---: | ---: | ---: |
| Direct Layer 3 search | 500 ms | 2 s | 99.5% |
| Deterministic evidence answer | 2 s | 5 s | 99.5% |
| Canonical input to durable complete candidate | 1 s | 30 s | 100% |
| Canonical approval to durable acknowledgement | 1 s | 5 s | 100% |
| Approval offer to visible search result | 60 s | 300 s | 100% |

Every incorrect, unfinished or deadline-missed offered operation has infinite
latency. Empty populations are NOT-RUN. Search, answer and history populations
are graded separately. History probes are 100% required and include held-out
selective, medium, broad and negative queries across ten age buckets.

Core input ports accept sealed canonical meeting decisions and approval actions.
Their deterministic processor and evidence-composition outputs run inside the
candidate allocation. They may not bypass current Person authorization, record
append, generation publication, release audit or replay code, and may not use a
side index. Approval authorization, scheduling and driver back-pressure remain
inside this core path. A complete candidate is content-complete only after its five
canonical facts match the sealed input; a later mutation is a failure.

The retained synthetic corpus is an oracle template, not live canonical state.
Its atom IDs, record heads and record hashes must be independently bound to the
actual canonical records and released generation before a qualification run.
Template identifiers alone never establish a release or permission proof.

The corpus uses a 4,096-word ordinary vocabulary with Zipf exponent 1.1,
20-30 distinct terms per atom, and term frequencies 1/2/3 at 70%/20%/10%.
Queries are ordinary held-out terms: 40% selective, 30% medium, 20% broad and
10% negative. Medium queries match at least 100 authorized atoms; broad queries
match at least 200 for M1 and 1,000 for M2/M3. Shared and restricted policy
facts are 70% and 30% respectively.

The independent oracle computes the complete ordered top ten using the pinned
analyzer and ranking rules. It uses the independently observed active head at
offer, or a newer independently validated release head, never an older head.
The returned head must still satisfy exact current-record-head and current
Person release fences. At start, finish and sampled active generations, the
verifier compares every fact, content, policy and logical posting
`(term, atom_id, term_frequency)` and recomputes segment roots. Candidate
telemetry and candidate manifests are not evidence.

## Permission and durability hard gates

Forty timed permission cases are interleaved with capacity traffic: wrong
approver, revoked member, revocation during answer, cross-organization or expired
session, invalid canonical approval binding, cross-segment relationship,
unapproved content, unreleased citation and stale generation. A denial can never
release content. A verifier-minted
operation correlation binds each core-port offer, result digest and durable
release audit; it proves correlation, not computation.

One whole-cgroup process kill lands during the hidden peak. SQLite starts at
DELETE/FULL; weaker synchronous modes are forbidden unless independently proven
equivalent under the existing durability contract. Storage-fault cases cover an
acknowledged approval receipt, acknowledged V4 append, active-generation pointer
and audit boundary with positive and negative flush controls. Zero acknowledged work may be lost; zero duplicate canonical
appends, invalid publications, permission releases, missing/wrong postings,
unapproved generated atoms or audit-after-result violations are allowed. A
process kill does not prove power-loss durability: a qualifying storage-fault
runner must discard unsynced writes on a block-backed state volume.

## Sealed, independent runs

Before startup, freeze the verifier, generator, oracle, core-port adapter,
candidate artifact/configuration and environment digests. After the candidate
digest is registered, the verifier generates and seals the corpus, queries,
arrival trace, fault schedule and hidden peak. The candidate cannot read those
files, seeds, expected results or verifier administration. It receives only
normal core-port inputs and current Person requests.

Each candidate/profile/milestone receives one registered qualification attempt.
A measured failure remains FAIL; an INCONCLUSIVE replacement requires
independent infrastructure evidence and every attempt remains recorded.
Precomputed answer maps, benchmark recognition, test-only fast paths, future
query access and candidate self-reported verification are forbidden. General
indexing and current-head scope-aware caching remain valid.

The reference environment is EC2 c7i.xlarge in us-west-2 on Ubuntu Server 24.04
LTS x86_64: four candidate vCPUs, 8 GiB memory, no swap and a dedicated 100 GiB
gp3 ext4 volume at 3,000 IOPS and 125 MiB/s with ordinary write barriers. Driver
and verifier capacity are outside the candidate allocation; every candidate child
is inside it. The exact host image and hardware fingerprint belong in the
environment lock. No AWS provisioning or timestamp-service implementation is
part of this profile.

This V2 profile replaces V1 because V1 measured external provider transport.
No V1 baseline exists, and no result is comparable across the profiles. The V2
rules are frozen, its baseline is NOT-RUN, and its full qualification runner is
not implemented.
