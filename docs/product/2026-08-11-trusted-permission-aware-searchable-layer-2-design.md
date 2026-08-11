# B: Trusted permission-aware searchable Layer 2

**Status:** deferred architecture design. This document defines the separate
trust and retrieval project that begins only when Layer 2 must support an
actual searchable or cross-record permissioned corpus. It is not approved for
implementation and does not authorize a search, model, API, merge, deployment,
or release.

**Code baseline:** `aaae7509f6b62434b1f23e811b82f3926c38eae3` on
`feat/organization-permission-pilot-v1-clean`. Code and schemas remain
authoritative for landed behavior.

**Predecessor capability:**
[A: Reviewer permission minimum V1 with append-atomic log facts](2026-08-11-reviewer-permission-v1-log-facts-design.md).

**Builds on:**

- [Organization permission architecture](2026-08-09-organization-permission-architecture.md)
- [Org decision record: append and derive](2026-08-07-org-decision-record-append-derive-design.md)

## Decision

Layer 2 becomes permission-aware only when it can form a caller-admissible,
text-free candidate scope and ensure that protected search, ranking, graph, or
model work operates exclusively inside that scope.

This is not needed for A's per-record reviewer lookup. B begins when the
product needs a capability that the append-side exact index cannot provide:

- lexical or vector retrieval over an authorized corpus;
- cross-record links, clusters, ranking, or structured traversal; or
- observed scale that makes canonical per-record selection insufficient for a
  stated product operation.

B pays the mutable-projection trust cost because its unique value is
cross-record computation. It does not move A into another database merely for
architectural neatness.

B is a new retrieval-owned Layer 2 projection with its own generation and
publication lifecycle. It does not silently turn the landed record follower
into a search-index builder or amend the append/derive rule that request-time
scoring is not deterministic record derivation. A B builder may consume
verified Layer 1 records and a pinned deterministic content snapshot, but it
builds private, policy-isolated retrieval generations outside requests.
Requests never trigger indexing, catch-up, embedding, linking, or rebuild.

## Current state: permission-shaped, not permission-aware

The landed `record-derived.sqlite` contains useful provenance derived from
immutable source records, but the SQLite projection itself is disposable and
mutable and is not a permission-query boundary:

- `restricted` is projected, but normally ingested envelope v1 pins it to
  `true`, so it discriminates no policy;
- atoms retain reviewer principal but discard exact reviewer membership;
- no index covers policy, reviewer principal, or reviewer membership;
- broad `atoms()`, snapshots, observations, rejections, and edges accessors
  read all rows, and atom reads include protected text; and
- the derived cursor records a position but no record hash, build identity,
  policy-fact contract, or served projection root.

The current store is deterministic and rebuildable. Those are necessary but
not sufficient properties for a served permission-aware corpus.

## Entry criteria

B does not start until all of these are true:

1. A or another reviewed policy-record admission contract has landed with
   exact immutable policy, actor/provenance, item identity, and content
   bindings.
2. A concrete approved product operation requires search or cross-record
   computation. “We will need search later” is not sufficient.
3. The initial authorization-equivalence partition is named and bounded.
4. Layer 3 has an accepted current-Person resolver, final head recheck,
   pre-response audit, and no-store response contract for that operation.
5. Operations accepts retrieval-projection availability, rebuild, restore,
   reconciliation, and version-transition obligations.
6. The search/index implementation can prove candidate-first filtering and
   caller-scoped statistics rather than global retrieval followed by an ACL
   post-filter.

If any entry criterion is false, use A for its exact reviewer read or defer the
new operation.

## Ownership and non-authority

### Layer 1 input

Layer 1 remains the immutable truth for approved content, policy consequence,
frozen actor/provenance, record hashes, positions, and item order. B consumes a
closed verified-record interface. It never reinterprets Slack, invents intent,
or upgrades a legacy record.

The minimum canonical-input contract is conceptually:

```text
atom_id
record_hash
log_position
atom_order
content_policy_key
policy_contract_version
reviewer_principal_id | null
reviewer_membership_id | null
content_binding_sha256
provenance_binding_sha256
```

The exact fields vary by reviewed policy family, but missing policy version or
binding denies. Reviewer membership is not interchangeable with principal.

B computes its own canonical `upstream_input_root` over the ordered, verified
Layer 1 records at the pinned head. A does not persist a projection root or
wait for B. A's log-local facts may be used as an equivalence oracle in shadow
validation, but they are not a second source of truth and B does not copy an
allow decision from them.

The first named input contract is `reviewer-policy-fact-input-v1`. Its root
commits:

```text
organization_id
input_contract_version
record_head_position
record_head_hash
ordered per-atom policy classification
record/item identity and order
reviewer principal and membership
content and provenance bindings
```

B derives these logical input facts directly from strict canonical envelopes.
At shadow/cutover time it also requires exact equivalence with A's append-
atomic table. Head position without the matching hash never aligns, and
unknown, legacy-unmarked, or misclassified rows never enter the input root.

### Layer 2 role

Layer 2 owns disposable, deterministic projections:

- text-free permission facts;
- protected atom/content projections;
- lexical or vector indexes;
- provenance-bound cross-record projections; and
- manifests and roots that prove the served generation.

Layer 2 never owns:

- current membership, enrollment, installation, or lease state;
- current permission-act or identity-effect state;
- a resolved reader list;
- a reusable positive authorization result; or
- the final decision to release content.

Layer 3/Authority remains the policy enforcement point. A Layer 2 candidate is
never an allow.

## Separate data planes

B keeps four logical planes separate even if one implementation co-locates
their tables or files:

| Plane | Contains | Must not expose through |
| --- | --- | --- |
| Permission facts | IDs, policy keys, frozen actor facts, positions, binding digests | content or unscoped APIs |
| Protected content | text, subject, evidence, meeting/provenance metadata | facts APIs |
| Search indexes | lexical postings, terms, chunks, embeddings, algorithm state | global/unbound query APIs |
| Cross-record projections | scoped links, clusters, rank features, complete input bindings | any path that raises visibility |

Binding digests connect planes. They are not bearer capabilities, public
metadata, or substitutes for final authorization.

Authority-reachable serving code cannot import the raw derived database or a
broad `atoms()`-style store. Source-boundary tests enforce the separation.

## Internal ports and request scope

The served path exposes only narrow ports:

```text
PermissionFactsPort.readCandidateFacts(pinned_generation, path_inputs)
Layer3Resolver.bindCandidateScope(l3_snapshot, facts)
SearchPort.lexical(scope, query)
SearchPort.vector(scope, embedding)
CrossRecordPort.expand(scope, seed_ids)
ContentPort.fetch(scope, atom_ids)
CitationPort.verify(scope, atom_ids, bindings)
```

The facts port returns only a verified, text-free snapshot. Layer 3 alone
evaluates current Person and policy roots and mints `scope`, an in-process,
request-local `BoundCandidateScope`. It binds:

- organization and request digest;
- operation: exactly `search-readable`, `discoverable-label`, or
  `fetch-readable`;
- caller principal and exact current membership;
- required visibility, one permitted path family, and policy version;
- exact eligible physical segment IDs or atom IDs;
- record head and Layer 2 manifest/root;
- Person, permission-effect, and identity-effect versions when applicable;
- request nonce and short in-process expiry; and
- the active authorization turn.

It cannot be client supplied, serialized, cloned, persisted, cached, logged,
replayed, transferred across callers, or reused after the request or head
change.

No port returns global counts, raw postings, vocabulary, unfiltered neighbors
or edges, hidden stubs, or protected diagnostics.

The first implementation supports only
`restricted-reviewer-v1` exact-active-reviewer-membership readable search.
Every item in one physical segment is eligible for the same operation and
visibility under the same immutable reviewer-policy conditions, and Layer 3
checks the current exact membership before naming that segment. It does not
union reviewer, grant, attendance, floor, role, or discoverability paths.
Overlapping path families require a separate cardinality, deduplication, and
caller-scoped ranking design.

The operation boundary is exact:

| Operation | Admissible indexed material |
| --- | --- |
| `search-readable` | lexical/vector content only for items already readable in the bound scope |
| `fetch-readable` | protected content only for exact readable bound IDs |
| `discoverable-label` | reserved and unavailable until a separate approved discovery projection exists; it can never use atom text, title, subject, participants, evidence, or embeddings |

There is no generic “search and redact the result” operation. Full-text and
vector queries are content-sensitive even when they return only an ID.

## Candidate-first search and leakage rules

The normative sequence is:

```text
Layer 3 current state + path evaluation
  -> Layer 2 text-free facts produce a bound authorized scope
  -> lexical / vector / graph work only inside that scope
  -> protected content fetch only for selected bound IDs
  -> buffered answer and citation checks
  -> Layer 3 final head recheck + audit commit
  -> immutable response bytes
```

Global retrieval followed by an ACL filter is prohibited.

### Lexical search

Hidden documents cannot supply terms, postings, document frequency, snippets,
suggestions, facets, or ranking normalization. The first implementation uses
physically policy-root-isolated lexical segments and opens only segments named
in the bound scope. If a caller may enter several equivalent segments, final
ranking is recomputed only over their authorized union.

An engine that claims pre-filtered retrieval is admissible only when its
contract and adversarial tests prove that unauthorized documents cannot affect
candidate selection, exposed scores, statistics, or diagnostics.

### Vector search

Embeddings and ANN structure are protected content. A global ANN graph with
post-filtering is prohibited because hidden vectors can influence traversal,
neighbors, scores, and timing.

The first implementation uses physically policy-root-isolated vector segments
and opens only segments named in the bound scope. A future filtered ANN engine
requires a separate proof that unauthorized vectors never enter traversal or
candidate scoring, affect observable statistics, or appear through
diagnostics, and that every child chunk validates its parent policy/content
binding.

### Cross-record projections

Every link, cluster, entity/topic node, or rank feature records:

- its complete material input closure, including every ID and
  provenance/content binding that influenced the output;
- producer, build, and projection-contract versions;
- the policy root under which it was computed; and
- an output visibility cap no higher than the least-visible required input.

Missing or incompatible input projection denies. A persisted output is usable
only when every material input is eligible in the caller scope. Whole-
organization PageRank/popularity, clusters or labels containing hidden items,
aliases learned from hidden text, corpus-trained rank features, and related-
item output influenced by hidden endpoints are prohibited until a separately
reviewed partition proves their complete input closure. An inferred edge or
model output may describe; it never grants access or binds identity.

### Structure and statistics

Counts, facets, term frequencies, normalization, suggestions, autocomplete,
highlights, explain/profile output, page bounds, cursors, caches, graph degree,
and model context are computed solely from the caller-scoped set. No hidden
item produces a placeholder or “restricted result” count.

## Projection integrity and publication

### Per-record transaction

For each canonical Layer 1 record, Layer 2 commits its content rows,
permission facts, reused provenance, per-record manifest, and cursor movement
in one derived transaction. An impossible or unknown input halts derivation;
it is never skipped or interpreted under an older version.

The per-record manifest commits all logical rows derived from that record,
including their content/fact binding digests. It is based on canonical logical
bytes, not SQLite page bytes.

This per-record transaction covers only base content, facts, and provenance.
A new record can change prior cluster/link/rank output, so cross-record
material is built as part of a complete private generation and becomes
servable only after its generation root verifies and the active-generation
pointer switches atomically. It never mutates prior served rows in place.

### Generation manifest

Every complete served generation publishes one immutable manifest containing:

```text
organization_id
projection_contract_version
retrieval_build_id
source revision
upstream record/fact contract version and B-computed upstream_input_root
record head position and hash
retrieval input cursor position and record hash
deterministic content snapshot root | null
facts root
content root
lexical root | null
vector root | null
cross-record root | null
tokenizer/analyzer identity and configuration digest | null
chunking contract and parameters | null
embedding model/weights digest and vector dimension | null
graph/linker/ranker algorithm and parameter digests | null
index format and backend version
generation_id
```

Each root is a canonical digest over ordered logical rows or segments. A
content digest or cursor position alone is not a serving proof. Executable
semantics are part of generation identity: the same source revision with a
different tokenizer, chunker, model artifact, dimension, algorithm parameter,
or backend format is a different generation. A fixed version-pinned general
model artifact is recorded separately from the complete corpus-specific input
closure of each persisted feature.

### Ready state

A generation is ready only when:

- the Layer 1 chain and required external/restore reconciliation pass;
- the B-computed upstream input root and policy contract match;
- every B root validates against the same record head, build, and contract;
- the input cursor is exactly head-aligned;
- every shard/index algorithm version matches the manifest;
- current Layer 3 Person, policy, and permission-effect state can form a
  compatible request scope; and
- audit storage is writable and verified.

Missing, stale, partial, corrupt, restored-but-unreconciled, build-mismatched,
head-mismatched, root-mismatched, or unauditable state is externally opaque and
releases no content.

Initial B does not serve a historical prefix during indexing lag. A later
pinned-historical-generation availability contract may be reviewed separately,
but it must keep current Person and permission-effect state fresh and can only
omit newly appended content, never widen access.

Record append never waits for B. Under initial strict mode, a new verified log
head makes B unavailable until a generation at that exact position/hash is
published. The prior generation is not silently reused, and ordinary callers
receive only the operation's fixed opaque unavailable response.

### Fence and publication

B requires the full Authority-owned consistency fence from invariant 5.
Every authorization-relevant Person/policy mutation, record append,
retrieval-generation publication, permission/identity effect transition, and
final response commitment participates in one defined order.

Expensive search/model work may occur against a pinned immutable generation
outside the short final section. Before release, Authority holds the fence,
rechecks every pinned mutable head and the active generation, commits the
exact-response audit, and hands off the same bytes. A changed head retries or
denies. No unchecked model output is streamed.

Every component is built in a private staging generation, and every root is
verified there. Publication atomically commits one Authority-owned durable
active-generation manifest pointer under the fence. Readers capture exactly
one immutable manifest generation for their whole request. A crash before
pointer commit leaves staging unreferenced and ignored. After pointer commit,
startup and first use revalidate every referenced root; an orphan or missing
shard makes that generation unready and denies. Repair/rebuild never mutates
the active generation. A request never observes files or roots from two
generations, and an active file is never replaced underneath it.

A manifest beside mutable files does not by itself detect rollback or valid-
prefix truncation. Restore admission still requires the independently retained
head/receipt boundary defined by the permission constitution.

## Rebuild, restore, and reconciliation

Layer 2 is disposable. Stopped-state rebuild from verified Layer 1 must
reproduce identical logical rows, manifests, and roots for a pinned build and
contract. A failed rebuild preserves the prior admitted generation and does
not modify Layer 1 or Authority state.

Startup validates the chain, upstream record/fact contract and B-computed
input root, generation manifest, all roots, cursor/head alignment, and selected
record reprojection before B is admitted. Rebuild is not itself permission to
serve.

After restore, B remains offline until reconciliation covers:

- log and B-computed upstream input heads;
- B generation and roots;
- current membership, enrollment, installations, leases, and revocations;
- permission/identity effect heads when used;
- policy/build/algorithm versions; and
- applicable externally held receipts or head evidence.

A syntactically valid old corpus is unsafe if the rest of the organization
state is newer. A perfectly consistent whole-state rollback remains bounded
by the project's external receipt/head threat model.

## Relationship to A and migration

Canonical Layer 1 records remain B's sole source of truth. During B
development, A's log-local facts are an equivalence oracle that B may compare
in shadow validation; they are not canonical inputs or a copied allow. B is
built offline or in a non-serving shadow mode and cannot alter A's live result,
latency classification, readiness, or audit.

The dependency is one-way. A never waits for B, reads B readiness, or adopts a
B generation in its served state. Unknown, malformed, legacy-unmarked, or
policy-rootless records are absent from B and externally invisible. The landed
constant `restricted = true` is never promoted into a real policy.

A's text-free derived compatibility exclusions are not B inputs. When B first
admits reviewer-v2, it reads and strictly validates the canonical envelopes
from Layer 1, independently projects their facts/content into a private
generation, and proves equivalence to A in shadow tests.

B may enter a served path only after it proves:

1. deterministic policy-fact equivalence to Layer 1/A for the admitted corpus;
2. exact content/provenance binding for every candidate;
3. complete generation and head readiness;
4. no-widening under stale, corrupt, swapped, missing, or extra rows;
5. candidate-first leakage tests for the actual search/index engine; and
6. Layer 3 final recheck and audit behavior across revocation and generation
   races.

Cutover is all-or-deny for one reviewed operation and policy partition. Do not
dual-authorize against A and B and union the results. A B hit is not an allow;
a B miss cannot trigger a broader scan or policy fallback.

One Layer 3 routing switch is the sole choice of serving substrate for that
exact operation and partition. It selects A or an admitted B generation before
candidate work begins; no request consults both and combines their answers.

After a successful cutover, decide separately whether A's simple reviewer
recent route remains log-backed or moves to the same retrieval substrate. No
migration is implied by B's existence.

## Failure rules

- No trusted scope means no protected content, search, vector, graph, rank, or
  model access.
- Candidate enumeration is never final authorization.
- Missing or invalid visibility data denies the affected path and never
  defaults to organization-readable.
- A broad store import, unbound query, mixed generation, stale scope, or
  binding mismatch is a build/test failure and runtime denial.
- Layer 2 cannot cache an allow, Person snapshot, mutable policy snapshot, or
  current reader set.
- Failure never downgrades to A, pilot, legacy, a different policy, a global
  index, or an unfiltered engine.
- Hidden content cannot affect emitted structure, statistics, diagnostics,
  cache keys, or model context.
- Initial B writes no raw query, embedding, prompt, protected snippet, hidden
  result set, or model context to application logs, traces, or audit.
- Ordinary health, readiness, progress, metrics, errors, and traces expose no
  corpus size, segment name, policy partition, stale-head distance, indexing
  progress, or candidate count. Governed operator diagnostics are a separate
  bounded/audited surface.
- Query/result caches are disabled. A later cache requires a separate contract
  binding the complete scope tuple and invalidating on every relevant Person,
  policy, permission-effect, upstream-root, and generation change.
- Initial B is local-only. Sending content, embeddings, or queries to an
  external search/embedding provider requires a separate custody review that
  pins provider/model/version, retention, provider logging, network boundary,
  deletion, restore, and audit behavior.
- B makes no constant-time or resource-side-channel claim. It prevents
  semantic/output disclosure; timing/resource resistance requires a separate
  threat model and budget before external multi-tenant use.
- Audit or final-head-check failure releases no response or streamed prefix.

## Build order

1. **Accepted operation and partition:** name the real product operation,
   initial policy partition, output/error contract, and measurable reason A is
   insufficient.
2. **Fact/content boundary:** exact upstream contract, permission facts,
   protected content plane, narrow ports, request-local scope, and source-
   boundary enforcement.
3. **Projection trust:** strict dispatch, per-record manifests, enriched
   cursor, generation manifest/roots, deterministic rebuild, startup
   admission, and restore reconciliation.
4. **Consistency:** runtime fence, staging/publication protocol, current state
   snapshot, final head recheck, exact-response audit, and failure algebra.
5. **Actual retrieval:** one policy-isolated lexical, vector, or cross-record
   implementation with candidate-first scoring and leakage tests.
6. **Acceptance and promotion:** adversarial local lifecycle, crash/rebuild/
   restore, bounded founder-live value test, then a separate release gate.

Building empty search infrastructure before step 1 is explicitly out of
scope.

## Minimum acceptance matrix

1. **Exact policy identity:** replacement membership for the same principal
   cannot enter the reviewer scope; unknown/malformed policy versions deny.
2. **Facts before content:** fact reads contain no protected content; content,
   postings, embeddings, and edges cannot be accessed without a valid Layer 3
   scope.
3. **No post-filter leakage:** adding, removing, or changing a hidden document
   changes neither allowed results nor emitted score, count, facet,
   suggestion, cursor, highlight, explanation, cache behavior, or model input.
4. **Physical isolation:** only lexical/vector segments named in the exact
   scope are opened; global FTS/ANN, vocabulary, suggestion, and neighbor APIs
   are unreachable from the served path.
5. **Vector/graph containment:** hidden vectors/endpoints never participate in
   candidate traversal; every material input to a cross-record feature is in
   scope; output never renders above the least-visible required input.
6. **Plane binding:** swapped fact, content, shard, chunk, edge, or
   provenance row with valid-looking IDs fails digest/root checks.
7. **Generation integrity:** partial build, stale cursor, head mismatch,
   wrong build/contract/algorithm, missing manifest, and root mismatch do not
   serve.
8. **Crash/rebuild:** incremental build, restart catch-up, and stopped rebuild
   produce identical logical rows and roots; failed rebuild preserves the
   admitted generation.
9. **Restore:** stale but internally consistent restored state remains offline
   until external and current-state reconciliation passes.
10. **Linearization:** membership, lease, grant, identity, policy, and
   generation changes before final commit deny or retry; changes after commit
   affect the next request.
11. **Telemetry and cache:** raw query, embedding, prompt, snippet, hidden
    result, model-context, segment identity, corpus size, lag distance, and
    indexing progress are absent from caller-visible logs, traces, metrics,
    audit, errors, and caches; no reusable positive authorization artifact is
    persisted; the initial path makes no external provider call.
12. **Opaque failure:** nonexistent, hidden, malformed, unavailable, and
    untrusted inputs expose no hidden identifiers, structure, or statistics;
    audit failure releases no content.
13. **Cutover:** shadow B cannot alter A; one Layer 3 routing switch selects
    one reviewed operation/partition and never unions or falls back across
    serving substrates.

## Invariant trace and proposed Layer 2 invariant

B is where invariants 1, 5, 6, and 7 become load-bearing for searchable
retrieval:

| Invariant | B mechanism |
| --- | --- |
| 1. Authorize before scoring/model access | Layer 3 creates the exact scope before any lexical/vector/graph/model work |
| 2. Do not stamp readers into content | facts retain frozen policy provenance, never current reader sets |
| 3. Existence and content are distinct | no global index/query; discoverability requires its own approved projection |
| 4. Deterministic witness | final Layer 3 path chooses the witness; B supplies no public explanation |
| 5. One consistency boundary | pinned generation plus full Authority fence and final head/audit recheck |
| 6. Failure cannot widen | missing/stale/mixed/corrupt state denies and never falls back to a broader corpus |
| 7. Structure inherits visibility | search statistics, ANN traversal, edges, caches, and model context are caller-scoped |
| 8. Models cannot confer access | inferred structures stay descriptive and scope-bound |
| 9. Recording creates no recipient list | B consumes reviewed policy records and cannot create readers |
| 10. Audit without second disclosure | Layer 3 commits minimized exact-response audit; B exposes no reverse diagnostics |

B proposes the broader invariant that A deliberately does not claim:

11B. **Permission-aware derived retrieval begins with text-free, rebuildable
facts.** Layer 3 forms a request-local authorized scope over closed,
provenance-bound, text-free facts derived only from verified Layer 1 input.
Protected content, search indexes, embeddings, statistics, and cross-record
projections are accessed only through that scope. Facts, content, reused
provenance, manifests, roots, and cursor transitions commit under one
versioned derived-generation contract and rebuild deterministically. Missing
facts, invalid scope, mixed generation, binding mismatch, or a broad-store
bypass denies.

The approval-consequence invariant belongs upstream in A or another policy
admission contract. B consumes that immutable proof; it does not recreate it.

## Explicitly deferred

- A public search/MCP/API contract, query language, or UI.
- Model prompts, answer composition, streaming, grounding thresholds, or model
  choice.
- Grants, attendee identity, teams, roles, collections, discoverability, and
  reverse `who`.
- Arbitrary overlapping grant-graph partitioning.
- Search vendor selection, relevance targets, embedding choice, or feedback
  telemetry.
- Multi-writer/distributed fencing, shared global corpora, and caches.
- Automatic entity resolution or model-created authority-bearing links.

These require separate designs. B is the trustworthy computation substrate,
not permission policy, a product surface, or the company's brain by itself.

## Grounded implementation footprint

At the baseline, B requires a new retrieval-projection schema and private
ports, strict version dispatch, exact membership/policy projection, manifests
and generation roots, cursor/build/contract identity, crash-safe staged
publication, startup admission, deterministic rebuild, restore reconciliation,
runtime fencing, physical policy isolation, and adversarial leakage tests.

A focused 3-5 day spike may choose one operation/engine and prove the staging,
scope, and leakage strategy on fixtures; it is not production implementation.
The trust substrate's production implementation and validation is a separate
rough 10-16 engineer-day range before the chosen lexical, vector, or cross-
record operation's own product/API/live-validation work. It excludes a
production lexical backend, ANN engine, embedding generation, corpus-scale
testing, cross-record algorithms, and any external-provider integration. No
estimate is a release promise.

## Review provenance

The predecessor combined reviewer V1 and mutable Layer 2 in one reviewed
candidate. The founder's split retains that candidate's derived-integrity and
search-safety findings here, but changes sequencing and ownership. B requires a
fresh review against the actual product operation and engine before it can
become implementation-ready.
