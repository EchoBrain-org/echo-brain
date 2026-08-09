# Organization decision record: append and derive design (v1)

**Status:** Design approved in founder session 2026-08-07; amended 2026-08-08
after code cross-reference audit, independent efficiency review, industry
cross-reference, and a minimum-v1 correctness review; minimum v1 implemented
2026-08-08 across the protocol/API packages, `services/organization-record`,
the authority host, and the member submitter
**Builds on:** [org-brain-direction.md](org-brain-direction.md) (direction),
`src/product/approval/` (local decision chain), `services/organization-authority`
(membership, keys, leases), `packages/federation-protocol` (portable trust
primitives)

## Goal

Give one organization a single trusted, append-only record of its human-approved
decisions, fed by enrolled member machines, with a deterministic derived graph
on top. This is the append and derive half of the organization brain. Retrieval
is deliberately out of scope.

## Design principles (settled)

1. **Append, derive, and retrieve are three separate logical machines.** They
   never call each other; they communicate only through data at rest (the log,
   then the derived store). Append runs on human acts, derive follows the log
   with a cursor, retrieve answers questions. V1 builds append and derive only.
2. **The log records facts; interpretation is derived.** Litmus test: if
   deleting it loses truth, it is a log event (human acts: approval, rejection).
   If it can be recomputed from the log, it is derived (atoms, edges, indexes).
3. **Stone/gatekeeper split for access.** Log records and derived nodes carry
   provenance facts (source meeting, participant observations, approver) and
   approver intent (`restricted` flag). They never carry resolved reader lists
   and never bind observations to principals. Effective access — including
   observation-to-principal resolution — is computed at query time by a future
   permission layer against current org membership. This prevents stale frozen
   ACLs, but it does not make derivation a trusted authorization boundary:
   authorization-relevant intent and participant facts remain scoped to the
   exact approval snapshot, and a future gatekeeper must fail closed if that
   projection is missing or inconsistent. (This refines the direction doc's
   "audience … travel[s] with the approved record": intent markers travel;
   resolved access never does.) Precedent: Glean keeps permissions in a dedicated layer the
   knowledge graph connects to — "a sophisticated permission database that
   records access control information for all organizational resources" —
   with enforcement at query time against live identity data, rather than
   ACLs frozen onto content
   ([Glean — permissions-aware AI](https://www.glean.com/perspectives/security-permissions-aware-ai),
   [Glean — permissions structure](https://www.glean.com/blog/secure-generative-ai-for-the-enterprise-requires-the-right-permissions-structure)).
4. **The log unit is what the human approved.** One approval event stores the
   resolved decision package (the `DecisionBrief` with its evidence spans) in
   RFC 8785 canonical form. Per-signal atoms are a derived, rebuildable
   projection, never log content.
5. **Rejections are logged as acts, not candidate content.** A rejection event
   records that a package was rejected (by whom, when, an optional reason of at
   most 2 KiB UTF-8, optional `reconsider_after`). The reason is explicitly
   organization-visible content; the rejected package stays in the member
   machine's local store. Revisit linkage is deferred with the rest of the
   local revisit feature; v1 resolves one terminal act per local decision node.
6. **Raw-source custody stays local.** Transcripts and vendor payloads never
   travel. The bounded approved `DecisionBrief` does cross the wire: meeting
   metadata and participants, decision/action/rationale text, its evidence
   spans, and pointers back to the local source. Organization ingest is a
   second egress path alongside the existing delivery pipeline (Slack, outbox);
   both are bounded to approved brief content plus the explicitly
   organization-visible rejection reason, and they remain separate acts with
   separate idempotency keys.
7. **Derive v1 is deterministic only.** Atomization and provenance edges over
   log content alone; no entity resolution, no principal binding, no
   model-proposed links, no model calls, no reads of live authority state.
   Interpretive linking is a later, separately designed pass.
8. **One canonicalization.** All wire signing and hashing uses the RFC 8785
   implementation in `packages/federation-protocol` (`canonical-json.ts`,
   `signed-document.ts`). No new canonical-JSON implementation may be added,
   and core's divergent digest (`src/core/delivery/envelope.ts`) is never used
   for organization-record artifacts. "Exact as approved" means RFC
   8785-canonical over the parsed value (local slot files are pretty-printed;
   disk bytes are not the wire form).

## Shape and placement

`services/organization-record` is a **control-plane-shaped workspace hosted in
the organization-authority process** — the same idiom as
`services/organization-control-plane`, whose database the authority process
already opens behind its authenticated singleton guard. It is not a separately
deployed service. Charters are enforced at the database level: the authority's
"does not store decisions" remains true of `authority.sqlite`.

- `record-log.sqlite` — the immutable log. Truth.
- `record-derived.sqlite` — the derived graph. Rebuildable from the log by the
  backup-first, stopped-state `rebuild-derived` maintenance command. Serve and
  installation still fail closed on a missing derived file; the rebuild is the
  one narrow exception, and only when the existing log, installation marker,
  and Authority anchor are complete and valid.

Boundary rules that keep later extraction to a standalone service mechanical:

- The wire contract stays in the shared packages exactly as if the service
  were remote; the submitter never knows the difference.
- The record module touches the authority only through its public application
  interface (the existing installation-signed-command path used by the Slack
  identity-link routes). It never opens `authority.sqlite`.
- Ingest routes mount on the existing authority HTTP listener.
- Receipts are signed with the existing authority signing key — which member
  machines already pin and verify — over an exact receipt payload carrying its
  own `kind` and schema version, never a new service identity.

Both databases follow the existing service convention: `journal_mode = DELETE`
(documented rationale: a stopped database is inspectable read-only without
WAL/SHM sidecars, and `state-backup` refuses WAL sidecars), plus the shared
pragma set (`trusted_schema = OFF`, `temp_store = MEMORY`), contiguous
`NNNN_name.sql` migrations applied under `BEGIN IMMEDIATE` with
`PRAGMA user_version` as the counter.

Member side adds one product module: the **submitter** (`src/product/organization/`).

## Contract placement and size cap

- Durable signed shapes — the two envelope types, the receipt, and the payload
  schema — live in `packages/organization-protocol`, following its existing
  `SignedIntegrity`/schemas/fixtures conventions. Its README already reserves
  this slot ("ingest batches, and batch receipts … remain deferred").
- Route path, request/response DTOs, and the error shape live in
  `packages/organization-api`, per the established protocol/API split.
- The approval envelope validator uses a dedicated size cap (256 KiB canonical
  bytes) instead of the package default `MAX_ORGANIZATION_PROTOCOL_DOCUMENT_BYTES`
  (16 KiB), which a brief with verbatim evidence spans routinely exceeds. The
  exemption is explicit in the validator, not a global raise. The ingest route
  accepts, and its client enforces, a request-body limit of that canonical cap
  plus the exact 20-byte `{"record_envelope":}` DTO wrapper. Receipts stay
  under the shared 16 KiB response limit, which remains unchanged for every
  other route.
- The payload schema necessarily restates the `DecisionBrief` shape that core
  validates (core imports no packages, by design). The two are pinned together
  with shared golden fixtures rather than shared code.

## Envelope contract (v1)

Two event types now; `correction` is a reserved name but is rejected by the v1
validator until separately designed.

**Approval event**

- `schema_version: 1`, `event_type: 'approval'`
- `envelope_id` — a random stable id generated once and frozen with the exact
  signed envelope before its first send
- `idempotency_key` — the existing sha256 approval id derived from the decision
  node's processing key (already the cross-boundary identifier used with the
  authority). Its uniqueness scope is `(submitter.installation_id,
  idempotency_key)`, not the whole organization: the log unit is one member's
  human-approved act, while cross-member semantic deduplication is later
  interpretation.
- `payload` — the resolved decision node in canonical form: `DecisionBrief`
  (meeting, participants, decisions/actions/rationales with verbatim
  `EvidenceSpan`s), a typed source locator (`adapter_id`, `instance_id`,
  `external_id`), alternatives, links, `reviewed_at`, surface. In v1,
  `alternatives` is always empty and `links` always null (the local store
  hardcodes them); they are carried for shape stability.
- `reviewer` — the authority-verified `principal_id` and `membership_id` plus
  the complete existing `resolved_metadata.authorization` evidence and the
  configured display name (`reviewed_by`) as display-only. Authorization
  evidence is required for organization ingest, must be an allowed evaluation
  for this installation, approval id, and `approve` action, and is checked by
  the authority application against its existing integration audit before
  append. The verified id is the identity of record; the display name is never
  load-bearing. A pre-enrollment or otherwise locally resolved node without
  this evidence is skipped with an operator alert, never silently downgraded.
- `intent` — `{ restricted: boolean, reconsider_after: string | null }`,
  carried as record intent. The current Slack approval
  surface has no input affordance for intent (two reactions and one reply
  field), so v1 uses the conservative installation default
  `{ restricted: true, reconsider_after: null }`; this is not described as an
  approver-set value until an affordance exists. The affordance (third reaction
  or modal) is deferred until observed need. The contract carries the fields
  from day one so their later population is not a schema change.
- `submitter` — installation id, `submitted_at`
- `integrity` — the existing `signed-document` integrity block produced from
  the installation signature over the RFC 8785 canonical payload bytes

**Rejection event**

- `schema_version: 1`, `event_type: 'rejection'`
- `envelope_id` — generated and frozen as above
- `idempotency_key` — same derivation as approvals
- `payload` — typed source locator, meeting id, `rejected_at`, optional
  organization-visible free-text `reason` bounded to 2 KiB UTF-8, optional
  `reconsider_after` timestamp. No brief content.
- `reviewer`, `submitter`, `integrity` — as above, with authorization evidence
  required for the `reject` action

Approved and rejected acts both enter the org timeline; only approved content
does.

## Ingest protocol and log storage

**Submitter (member side).** No watcher daemon and no separate state store.
Mechanism: a best-effort post-resolve hook plus one bounded sweep started
alongside local work in every existing product service cycle. There is no
duplicate startup sweep. A sweep has one 10-second total deadline, reports its
result with the cycle, and cannot change the local cycle verdict. The decision
node's own write-once slot files are the state machine:

- `resolved.json` present, neither outbound nor terminal slot present: evaluate
  exclusion and eligibility, then create the exact signed
  `organization-record-envelope.json` slot once;
- outbound envelope present, neither terminal slot present: resend those exact
  bytes until a terminal response arrives;
- `published-organization-record.json` present: accepted receipt, complete;
- `organization-record-rejected.json` present: permanent schema/signature/
  evidence rejection, terminal and operator-visible.

Transient transport or lease-refresh failures create no terminal slot and are
retried by the next existing cycle. This adds no queue database and no polling
daemon.

*Source exclusion.* The submitter honors a member-side never-ingest list:
an excluded source produces no org events at all — not even rejection acts.
This is the pre-ingest escape hatch that an immutable log demands; precedent
is Microsoft's semantic index, which lets admins exclude whole sites and
advises it "for sensitive data, such as payroll, HR, or financial
information," alongside the rule that "indexing data doesn't change access
permissions to content"
([Microsoft Learn — semantic indexing for Copilot](https://learn.microsoft.com/en-us/microsoftsearch/semantic-index-for-copilot)).

Setup: an optional `organization_ingest.exclude` section in the member's
existing product config file (alongside `meeting_sources`), with exact-match
entries at two granularities — a whole source (`adapter_id` + `instance_id`)
or a single meeting (`source` + `external_id`). No pattern matching. The list
is member-controlled (deliberate divergence from Microsoft's admin-controlled
model: custody is member-side, so the member owns the valve), checked by the
submitter before first building and before sending any envelope of either event
type, effective until remote append and powerless after (see the erasure
trap). Receipt absence after a timeout does not prove that remote append did
not occur. An org-distributed
exclusion floor (an admin list merged into the same check, subtractive only,
distributed over the existing authority-to-member channel) is deliberately
deferred: it touches no frozen surface, so it can be added whenever a real
org needs it. An unreadable or invalid exclusion config fails closed at
startup, before a submitter can be composed or anything can ship. The
`approvals` CLI projection shows affected nodes as `excluded`;
the org side has no trace. On success the verified receipt is filed through
the existing `recordPublished` create-once idiom, surface
`organization-record`. Filing is atomic-create; a receipt slot can never be
overwritten. Retries reuse the frozen envelope and the same idempotency key.
The append path for a decision is complete only when a verified receipt or a
permanent-rejection slot exists.

The exclusion lookup is not reconstructed from an opaque identifier. New
`requested.json` slots persist a validated source locator from the approval
request's meeting provenance. For already-stored v1 processing keys, one
versioned parser may recover the same tuple; an unparseable legacy node fails
closed and alerts.

*Legacy enumeration.* `DecisionNodeStore.list()` remains fail-closed on a legacy
node carrying federation metadata. The submitter instead uses
`listForSubmission()`, which returns valid nodes plus structured skipped-legacy
diagnostics so one old node cannot poison the sweep.

**Ingest (module side).** Three stages, with the first applying only to a retry:

1. **Recover an exact accepted resend** — look up the installation-scoped
   idempotency key and compare the complete canonical envelope and its digest.
   An exact match returns or materializes the stored receipt without requiring
   current access, so later lease expiry or revocation cannot strand an act the
   log already accepted. An absent or divergent row continues to full
   verification.
2. **Verify a new or divergent submission** — in-process via the authority's
   application interface: current access lease, installation signature over the
   canonical bytes, schema validation of envelope and payload, and an exact
   lookup of the required allowed authorization evidence in the authority's
   existing integration audit. The evidence must bind this organization,
   installation, approval id, action, reviewer principal, and membership.
   Payload validation happens before every new append — an immutable log must
   never accept a record that derive cannot process. V1 explicitly trusts the
   enrolled installation to preserve the local immutable mapping from approval
   id to approved brief bytes; cryptographic binding of the brief digest into
   the Slack approval marker is a later hardening step, not an unstated v1
   guarantee.
3. **Dedupe and append** — under one serialized `BEGIN IMMEDIATE` append
   transaction, enforce `UNIQUE(installation_id, idempotency_key)`. Compute
   `envelope_sha256` over the exact canonical signed envelope bytes. A matching
   duplicate that races past the recovery lookup returns the stored original
   receipt unchanged; after verification, a known key with a different
   envelope digest is a permanent `idempotency_conflict`. A new key receives
   the next monotonic position and record hash. The transaction stores the
   deterministic receipt payload with the log row. Its signed receipt is
   materialized and stored before the first successful response; after a crash
   in that narrow post-commit window, a retry materializes it without another
   append.

**Log table.** Append-only: `position` (monotonic integer primary key), exact
canonical signed-envelope bytes, `envelope_sha256`, deterministic receipt
payload, optional materialized signed-receipt bytes, `recorded_at`, and
`record_hash`. The versioned record frame is RFC 8785 canonical JSON:

```json
{
  "schema_version": 1,
  "kind": "echo-organization-record-frame",
  "organization_id": "...",
  "position": 1,
  "previous_record_hash": null,
  "recorded_at": "...",
  "envelope_sha256": "sha256:..."
}
```

`record_hash = sha256(canonical_record_frame_bytes)`. Position 1 has a null
predecessor; later positions carry the prior canonical digest. Golden fixtures
freeze the exact genesis and two-record chain. Database triggers reject update,
delete, and non-contiguous insertion through ordinary code paths.

The hash chain plus member-held receipts (each carrying `position`,
`envelope_sha256`, and `record_hash`) is the tamper-evidence mechanism.
Walking the surviving chain detects internal mutation, deletion, or reordering;
a valid-prefix tail truncation or database rollback requires comparison with an
external checkpoint. Receipt comparison, witnessed checkpoints, and automatic
reconciliation are explicitly deferred. Per-envelope signatures alone cannot
detect removal. The host walks the internal chain at process start and at a
clean stop. The supported backup runbook requires that stop before copying
state; arbitrary live file copies are unsupported and cannot be prevented. A
chain nobody walks is decoration (transparency-log practice:
[Sigstore Rekor](https://github.com/sigstore/rekor) /
[Google Trillian](https://github.com/google/trillian)). No update or delete
statement exists in the codepath.

**Receipt.** A durable signed document whose signed payload includes exact
`kind: 'echo-organization-record-receipt'` and `schema_version: 1` fields plus
authority id, organization id, envelope id, envelope sha256, installation id,
idempotency key, log position, record hash, and recorded-at. Those signed type
fields provide domain separation with the existing `signed-document`
primitive; no nonexistent extra signing-context argument is assumed.

**Rejected ingest is loud.** Expired lease → submission remains retryable
while the member access lifecycle renews access, then a later sweep retries the
same frozen envelope. Bad signature or schema → permanent rejection with
reason, filed on the member side and surfaced through the `approvals` CLI's
organization-record state.

## Derive v1 (deterministic)

A follower inside the same process. State: a single cursor (last processed log
position) in `record-derived.sqlite`.

**Wake mechanism (correctness, not optimization):** an in-process nudge after
each append commit, plus a full catch-up pass from the cursor at process
start. Nudges feed one serialized drain loop; concurrent nudges coalesce. No
standing poll timer. A crash between append and derive is healed by the
startup catch-up. A deterministic derive failure is process-fatal after the
operator alert so the existing supervisor restart exercises that same recovery
path rather than leaving a healthy-looking process stale indefinitely.

**Nodes**

- `atom` — kind `decision | action | rationale`, text, subject, status/owner/
  due (kind-specific), confidence, evidence spans, `restricted` flag, approval
  provenance (verified reviewer principal id, display name, `reviewed_at`,
  approval group, log position)
- `meeting_snapshot` — one approval-scoped snapshot carrying source locator,
  meeting id, meeting revision, title, and time. V1 deliberately does not merge
  snapshots across records.
- `participant_observation` — scoped to one meeting snapshot and carrying the
  participant id, display name, typed identities, roles, response status, and
  attendance exactly as approved. **No principal binding in derive** —
  observations stay observations; resolution against membership is query-time
  gatekeeper work (binding in derive would read authority state that is not log
  content and break rebuild determinism).
- `rejection` — derived from rejection events: meeting id, reviewer, time,
  reason, `reconsider_after`

**Edges**

- `derived-from` — atom → log record
- `from-meeting` — atom → meeting snapshot
- `listed-participant` — meeting snapshot → participant observation
- `attended-by` — meeting snapshot → participant observation only when the
  approved participant facts explicitly say `attendance: 'attended'`
- `supports` — rationale atom → sibling atoms, from `supports_signal_ids`

Atoms from one approval share its approval group (approval-group provenance).

**Determinism.** Every derived row id is a pure function of log content:
atoms hash (log record hash, signal id); rejections hash the log record hash;
meeting snapshots hash (log record hash, meeting id, meeting revision);
observations hash (meeting snapshot id, RFC 8785-canonical participant value).
Derivation reads nothing but the log. All rows and edges for one record plus
the cursor advance commit in one `record-derived.sqlite` transaction; a crash
leaves either all of them or none of them. The tested property: replaying the
log into a fresh derived store at cursor zero produces the same **canonical
content digest** — a hash over an ordered dump of all rows — as the incremental
run. That module property is what the operator-facing `rebuild-derived`
maintenance command rests on. (It is not
file-byte identity: SQLite page layout varies across library versions.) If
derive encounters an unprocessable record — which
ingest-time payload validation should make impossible — it halts with an
operator alert rather than skipping; staleness is visible, truth untouched.

## Concurrency and freshness

Both implemented machines, append and derive, run in one process in v1; their
separation is logical and enforced by the data-at-rest interfaces, not by a
process boundary.

- The log tail is the single serialization point: one short local transaction
  per append, required anyway for monotonic positions and the hash chain.
  Member submissions interleave freely; verify and dedupe overlap.
- With DELETE journaling, writers briefly exclude readers per database; at
  pilot volume (a handful of records per day) contention is expected to be
  negligible, and the log and derived stores are separate database files, so
  ingest appends and derive reads/writes touch different locks.
- Derive commits all rows, edges, and its cursor atomically per log record, so
  any future reader sees a consistent snapshot — never half an approval's
  atoms and never a cursor ahead of its rows.
- Latency contract: the approver waits only for the receipt (append round
  trip); the nudge schedules derivation asynchronously after append, with no
  promise that it finishes before the response. Append never waits on derive.

## Access policy (recorded, not enforced in v1)

The future gatekeeper reads graph facts plus authority membership at query
time — including resolving participant observations to principals. Initial
policy, changeable without touching the log: unflagged atoms resolve
org-wide; `restricted` atoms resolve from the exact approval-scoped meeting
snapshot under a separately designed fail-closed participant-eligibility rule;
the approver is never accidentally excluded by that future rule. Rejection
events (minimal payload, including any submitted reason) are org-visible as
acts. The authority's
`POST /v1/permission-checks` exists but is Slack-event-shaped and
integrations-gated today; the gatekeeper will need its own request shape.
Enforcement design is out of scope here.

## Industry cross-reference (2026-08-08)

Cross-checked against the precedent atlas ("Decision-Graph Precedents —
Industry Atlas") with the load-bearing claims re-verified in primary sources.
Outcomes: validations of the design as-is, changes adopted (cited inline in
their sections), traps recorded with a chosen v1 stance, and deferred
adoptions for the interpretive/retrieve passes.

### Validated as-is

- Log-unit immutability and supersession-by-new-record are the industry rule,
  verbatim. AWS: "When the team accepts an ADR, it becomes immutable. If new
  insights require a different decision, the team proposes a new ADR. When
  the team accepts the new ADR, it supersedes the previous ADR"
  ([AWS ADR process](https://docs.aws.amazon.com/prescriptive-guidance/latest/architectural-decision-records/adr-process.html)).
  Azure: "The ADR serves as an append-only log. Don't go back and edit
  accepted records. If a decision changes, write a new record that supersedes
  the original and link the two together"
  ([Azure WAF](https://learn.microsoft.com/en-us/azure/well-architected/architect-role/architecture-decision-record)).
- Rejection events with reasons: AWS treats ADRs as "immutable documents
  after the team accepts **or rejects** them" and records the rejection
  reason "to prevent future discussions on the same topic" (same source) —
  our rejection events are exactly that rule made org-wide.
- Approval as promotion of staged content is Iceberg's Write-Audit-Publish
  (write to an audit branch invisible to consumers, validate, promote)
  ([Iceberg branching](https://iceberg.apache.org/docs/latest/branching/)).
- Retaining verbatim evidence in the log follows Confluent's event-sourcing
  warning that once event-level fidelity is lost it cannot be recovered
  ([Confluent](https://developer.confluent.io/courses/event-sourcing/event-sourcing-vs-event-streaming/)).
- Append-only truth plus disposable projections is the KurrentDB/EventStoreDB
  event-sourcing shape ([Kurrent](https://www.kurrent.io/event-sourcing));
  supersession-as-new-assertion (never edit) is Datomic's accumulate-only
  model ([Datomic](https://docs.datomic.com/whatis/data-model.html)).
- Record lifecycle language matches PEP practice: "Once resolution is
  reached, a PEP is considered a historical document rather than a living
  specification" ([PEP 1](https://peps.python.org/pep-0001/)).
- The `reconsider_after` intent field has certification-lifecycle precedent:
  Guru verifies cards "with expiration dates or mark them as 'Does not
  expire'" ([Guru](https://help.getguru.com/docs/what-is-verifcation)), and
  Azure recommends recording low decision confidence as "useful for future
  reconsideration decisions" (Azure WAF, above).

### Recorded traps and v1 stances

- **Erasure vs immutability.** Enterprise meeting tools ship redaction and
  zero-day retention as compliance table stakes (atlas: Fellow's enterprise
  controls), and a legal erasure demand (e.g. GDPR) cannot be satisfied by an
  append-only log after the fact. V1 stance: erasure pressure is handled
  *before* ingest — the human gate plus the submitter's source-exclusion
  list. Post-ingest erasure is deferred with a named future mechanism:
  payload tombstoning via a `correction`-family event that instructs
  projections to suppress a payload while the log act remains. If a regulated
  deployment ever requires regulator-recognized WORM, the assessed tier is S3
  Object Lock compliance mode — "a protected object version can't be
  overwritten or deleted by any user, including the root user," assessed by
  Cohasset Associates against SEC 17a-4, CFTC, and FINRA
  ([AWS docs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html)).
- **Replay cost at scale.** Full-log replay eventually gets slow; the named
  remedy is Delta Lake's checkpoint pattern — periodic files that "save the
  entire state of the table at a point in time" so readers "avoid
  reprocessing what could be thousands of tiny, inefficient JSON files"
  ([Databricks](https://www.databricks.com/blog/2019/08/21/diving-into-delta-lake-unpacking-the-transaction-log.html)).
  Not v1; recorded so slow rebuilds have a known answer.
- **Stale links kill decision logs.** Confluence's decision blueprint has no
  supersedes edges and wiki decision logs rot; ADR practice's documented
  failure mode is humans forgetting link maintenance. This is the standing
  argument for the interpretive linker pass remaining first in line after v1.
- **Edge existence leaks.** A supersedes/related edge from a visible decision
  to a `restricted` one reveals that a hidden decision exists (and roughly
  what it concerns) even when its body is filtered — the atlas's Glean-derived
  warning that access must be graph-native, covering "nodes AND the edges the
  linker creates," never a body-only filter. Binding requirement on the
  future gatekeeper: edges are filtered as rigorously as nodes, and an edge
  is visible only when both its endpoints are. Derive v1 is safe by
  construction (its only cross-atom edge, `supports`, never crosses an
  approval group, and audience is uniform within one approval), but every
  interpretive edge type added later must pass this rule before shipping.

### Deferred adoptions (interpretive/retrieve passes)

- PEP typed links: `Requires` as a third link type beyond parent/supersedes,
  and a `Resolution`-style pointer to the exact approval act
  ([PEP 1](https://peps.python.org/pep-0001/)).
- Bi-temporal edges for the linker: Graphiti/Zep's temporal edge invalidation
  over episodes ([Graphiti](https://help.getzep.com/graphiti/getting-started/overview),
  [arXiv:2501.13956](https://arxiv.org/abs/2501.13956)) and XTDB's
  valid-time/system-time split ([XTDB](https://github.com/xtdb/xtdb)) — so a
  supersession discovered late can be backdated without touching approval
  records.
- Status vocabulary on derived atoms: Databricks' governed
  `certified`/`deprecated` tag and Atlan's DRAFT/VERIFIED/DEPRECATED —
  "superseded" must be a real state, not the absence of one
  ([Databricks](https://learn.microsoft.com/en-us/azure/databricks/data-governance/unity-catalog/certify-deprecate-data),
  [Atlan](https://developer.atlan.com/snippets/common-examples/certificates/)).
- Alation's negative-flag rule — a deprecation requires a reason and a
  pointer to the replacement — as the future supersedes-edge shape
  ([Alation](https://docs.alation.com/en/latest/welcome/BestPractices/UseTrustFlagstoProceedwithConfidence.html)).
- W3C PROV-O as the edge-name vocabulary (wasRevisionOf, wasQuotedFrom,
  wasGeneratedBy) before inventing our own
  ([PROV-O](https://www.w3.org/TR/prov-o/)).
- UK Government ADR scope levels (team → programme → department) and Azure's
  confidence level as future intent fields when orgs grow
  ([UK framework](https://www.gov.uk/government/publications/architectural-decision-record-framework/architectural-decision-record-framework)).
- lakeFS-style validation hooks gating linker edges before they become
  visible ([lakeFS](https://en.wikipedia.org/wiki/LakeFS)).
- Power BI's Promoted/Certified two-tier endorsement for multi-team orgs
  ([Power BI](https://learn.microsoft.com/en-us/power-bi/collaborate-share/service-endorsement-overview)).

### Relationship to ADR practice (deep-dive 2026-08-08)

We adopt ADR's lifecycle rules (immutable after resolution,
supersession-by-new-record, rejections kept with reasons, append-only central
log — citations above), not its template: classic ADR templates the *human's
input*; we template the *record* and take conversation as input, so no one
fills a form. Beyond the rules, four findings from the primary practice
literature:

- **The ADR people model falls out of our data for free.** MADR v4
  distinguishes decision-makers from "consulted" ("everyone whose opinions
  are sought … and with whom there is a two-way communication") and
  "informed" ("everyone who is kept up-to-date on progress; and with whom
  there is a one-way communication")
  ([MADR](https://adr.github.io/madr/)); Confluence's DACI likewise makes the
  Approver a named role distinct from Contributors. In classic practice a
  human maintains these lists per record. The v1 envelope supplies two of
  these facts: decision-maker = verified approver principal; consulted =
  participant observations on the source meeting. It carries no delivery
  receipts, so a future view needs a separate join with delivery evidence
  before it can answer "who was told."
- **Conformance checking is a named future capability.** MADR's Confirmation
  field — "Describe how the implementation of/compliance with the ADR
  can/will be confirmed" — and AWS's practice of validating code changes
  against ADRs in review (and raising tech-debt tasks for non-compliant
  legacy) translate directly: a retrieve-pass capability that checks a piece
  of work (a PR, a plan, a draft) against the approved decisions it touches
  ([AWS best practices](https://docs.aws.amazon.com/prescriptive-guidance/latest/architectural-decision-records/best-practices.html)).
  Deferred; recorded so the retrieve design inherits it.
- **Atom size is validated by the founding text.** Nygard: "The whole
  document should be one or two pages long … Large documents are never kept
  up to date. Nobody ever reads large documents, either"
  ([Nygard 2011](https://www.cognitect.com/blog/2011/11/15/documenting-architecture-decisions)).
  Our unit is smaller still — signal-level atoms — and his requirement that
  context be captured in "value-neutral" language is met by verbatim quotes
  rather than paraphrase.
- **Open submission, gated promotion.** AWS: empowering every member to own
  records "helps the team adopt those decisions faster instead of treating
  them as decisions that were imposed from higher levels" (best practices,
  above). Ours matches structurally: any enrolled installation submits; the
  gate is approval, not authorship.

**One official practice we explicitly decline:** the UK framework advises
teams to "Regularly review and update the ADR to reflect any changes in the
context or consequences of the decision"
([UK framework](https://www.gov.uk/government/publications/architectural-decision-record-framework/architectural-decision-record-framework))
— an in-place update. We side with AWS, Azure, and Nygard: records are never
updated; changed context produces a new linked record. Review-for-staleness
is kept — that is `reconsider_after` — but its outcome is a new act, never an
edit.

### Knowledge-graph permission precedents (deep-dive 2026-08-08)

Three credible source families, each contributing one binding requirement to
the future gatekeeper. Recorded now because the append/derive design already
guarantees the data they need.

- **Permissions-as-graph (Google Zanzibar, OpenFGA).** Zanzibar stores
  "trillions of access control lists" as relationship tuples and serves
  "millions of authorization requests per second" at Google
  ([Google Research](https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/));
  OpenFGA (CNCF incubating) is the open implementation, where permissions
  derive through relationship chains — e.g. "a user can view a document if
  they are an owner, viewer or editor of the document or if they are a viewer
  or owner of the folder/drive that is the parent of the document"
  ([OpenFGA modeling](https://openfga.dev/docs/modeling/getting-started)).
  *Requirement inherited:* the gatekeeper's policy is expressed as
  relationship derivation over facts the graph already holds —
  `may-read(decision)` derives from `attended(source-meeting)` (restricted)
  or `member(org)` (unflagged) — never as per-record grants.
- **Permissions-in-graph (Neo4j).** The only mainstream graph database with
  shipped edge-level security splits visibility into TRAVERSE (may find) and
  READ (may see properties), grantable/deniable per node label *and per
  relationship type*: "Users can only read properties on entities that they
  are enabled to find in the first place," and a denied entity "will not be
  found by a Cypher MATCH statement"
  ([Neo4j operations manual](https://neo4j.com/docs/operations-manual/current/authentication-authorization/privileges-reads/)).
  *Requirement inherited:* adopt the two-right vocabulary — existence
  (traverse) and content (read) are separate rights. Our edge rule ("an edge
  is visible only when both endpoints are") is the traverse right; default
  remains no-traverse → invisible entirely. The split keeps a softer future
  policy ("org may know a restricted decision exists, participants may read
  it") expressible as a choice rather than an accident.
- **Consistency (Zanzibar's "new enemy problem").** Stale permission checks
  leak: applying "old ACLs to new content" or missing a revocation's ordering
  lets a removed reader keep de facto access; Zanzibar prevents this with
  zookie freshness tokens guaranteeing checks are "at least as fresh" as the
  content presented ([AuthZed](https://authzed.com/blog/new-enemies)).
  *Recorded stance:* our single-process, single-database gatekeeper computes
  every check against live membership at query time — immune by construction,
  with no caches or replicas to go stale. The trap binds the moment
  permission caching or replication is ever introduced; zookie-style
  freshness tokens are the named remedy.
- **Permission-preserving ingestion (Atlassian Teamwork Graph).** The
  150-billion-connection graph's public principle — "Data enters the graph
  with its access controls intact, so AI respects who can see what," with
  connectors GA "with permissions intact" and admin control over "what
  third-party data Rovo can ingest"
  ([Atlassian](https://www.atlassian.com/blog/company-news/teamwork-graph-team-26),
  [SiliconANGLE](https://siliconangle.com/2026/05/06/atlassian-opens-teamwork-graph-pushes-rovo-agentic-execution-team-26/))
  — validates our envelope carrying provenance and intent from the moment of
  ingest. Atlassian's public material is architecture-thin (verified
  principle, undisclosed mechanics); the operable detail in this design comes
  from Glean, Neo4j, and Zanzibar instead.

### Build vs adopt (open-source survey 2026-08-08)

Surveyed credible open-source substitutes for every component against the
repo's dependency posture (entire external runtime surface: `ajv` +
`better-sqlite3`; HTTP and crypto are node built-ins). **Verdict: v1 adds
zero new runtime dependencies.** Per component:

- **Event-sourcing frameworks** (Emmett/@event-driven-io — the credible TS
  candidate): its SQLite package peer-depends on `sqlite3`, a second native
  driver beside better-sqlite3; licensing is unresolved (open RFC to
  dual-license AGPLv3/SSPL); and it covers streams/projections while missing
  what this log actually is — hash chain, signed receipts, canonical bytes,
  verified ingest. BUILD: one table, one INSERT path, ~10 lines of chaining.
- **Merkle/transparency-log libraries**: the real ones (Trillian, Rekor,
  transparency-dev) are Go servers; the JS ones are static-proof trees for
  airdrops. A Merkle tree earns its cost only for third-party inclusion
  proofs, which member-held receipts already cover at this scale. BUILD.
- **RFC 8785**: keep the in-tree frozen implementation (principle 8 forbids a
  second). One free adoption: import the RFC co-author's test vectors
  ([erdtman/canonicalize](https://github.com/erdtman/canonicalize)) as
  additional golden fixtures — data, not code.
- **ReBAC engines (future gatekeeper)**: nothing in the Zanzibar family
  (OpenFGA, SpiceDB, Permify, Keto) embeds in a Node process over SQLite —
  they are Go servers; casbin embeds but doesn't traverse our graph. The
  ~100-line SQL derivation check stays the plan, phrased in OpenFGA
  vocabulary so OpenFGA-as-sidecar is the documented migration if policy
  count ever outgrows hand-written SQL.
- **Embedded graph engines (future KG)**: Kùzu is dead (archived 2025-10-10,
  team acquired by Apple) — treat any Kùzu reference as stale; LadybugDB is
  the active fork to re-verify if graph traversals ever outgrow SQLite
  recursive CTEs. At our node/edge counts, SQLite edge tables are the
  correct architecture, not a compromise. BUILD.
- **Entity resolution (future interpretive pass)**: the credible ER science
  (splink, dedupe) is Python; no credible JS framework exists. BUILD
  deterministic matching (exact email, normalized name) per the determinism
  discipline; if fuzziness is ever observed to be needed, adopt a single
  distance function (e.g. talisman module), never a framework.

## Testing

- Protocol package: canonical serialization and signature round-trip; golden
  envelope fixtures for both event types and the receipt; shared positive and
  negative golden fixtures pinning the payload schema to core's
  `DecisionBrief` validator; exact 256 KiB canonical boundary and exact raw
  route boundary including the fixed 20-byte DTO wrapper.
- Module: ingest integration (exact-retry dedupe and replay,
  same-key/different-envelope conflict, response loss after append, exact
  authorization-evidence audit lookup, golden two-record chain verification,
  lease and signature rejection paths, oversize rejection before append).
- Derive: determinism property (incremental run and full rebuild produce the
  same canonical content digest); approval-scoped participant snapshots;
  an injected mid-projection failure proves rows, edges, and cursor roll back
  together; startup catch-up and coalesced concurrent nudges.
- Submitter: post-resolve hook fires; the existing service-cycle sweep finds
  resolved-without-receipt nodes and retries a transient failure without
  blocking local source work; frozen outbound envelope and
  receipt/permanent-rejection slots are
  create-once; missing authorization and legacy-metadata nodes are skipped with
  an alert, not fatal; an excluded source produces no envelope of either event
  type; invalid exclusion config fails closed.
- End-to-end: one enrolled member submits over the real Authority listener →
  receipt slot filed → atoms queryable in the derived store; lost-response
  retry returns the receipt and adds zero duplicate rows.

## Success criteria (pilot)

1. Every eligible approval and rejection from both pilot machines lands once
   per `(installation_id, idempotency_key)` in one org log with a verifiable
   hash chain; at-least-once retry returns the original receipt and divergent
   key reuse is rejected.
2. The derived graph answers: which decisions came from which exact approved
   meeting snapshot, who was listed and with what captured attendance facts,
   who approved (verified principal), what supports what.
3. `intent` travels end to end (conservative installation defaults in v1; the
   field, not an approver affordance).
4. A full rebuild reproduces the derived store's canonical content digest
   exactly.
5. Exact source and meeting exclusions prevent construction or transmission of
   either event type, and a transient submit failure is retried without a new
   envelope or duplicate append.

## Out of scope (deliberate)

- Retrieval, the permission gatekeeper, observation-to-principal resolution,
  and any query surface.
- Interpretive derivation: entity resolution, model-proposed
  supersedes/relates edges, atom ranking.
- Approval-surface affordance for `restricted` / `reconsider_after` (contract
  field ships; input UI deferred until observed need).
- `correction` events (shape reserved in `event_type` only).
- Revisit/branch creation and rejection-to-later-approval linkage.
- Resurfacing of `reconsider_after` rejections (the fact is logged; the
  reminder behavior is a future derived-side feature).
- Post-ingest erasure/redaction — payload tombstoning via a
  `correction`-family event is the named future mechanism (see Industry
  cross-reference: recorded traps).
- Receipt comparison, witnessed checkpoints, Merkle inclusion proofs, and
  automatic reconciliation of member-held receipts.
- Generic recovery beyond the stopped-state `rebuild-derived` command: log
  rebuild or restore, automatic repair of a partial installation, backup and
  restore commands, and any live (non-stopped) rebuild. A missing or mismatched
  log, record marker, or Authority anchor must still be restored from a backup.
- Standalone-service extraction of `organization-record` (boundary rules above
  keep it mechanical if scale demands it).
- Hardware-backed installation keys: current signer is exportable software
  keys only (`--allow-exportable-software-key`); raising the key floor is an
  existing, separate concern.
- Any interaction UI beyond existing operator surfaces. The `approvals` CLI
  reports receipt/rejection state but adds no new action affordance.

Doc updates landed with the implementation:
`organization-workspace-boundaries.md` (services list gained
`organization-record/`, persistence section gained the two record databases and
the ingest route) and `organization-control-plane.md` (ownership table gained
the organization-record row and the note that record ingest reads the existing
integration audit read-only and adds no control-plane table).

Process start verifies the chain before the listener binds. There is no backup
*command* in tree — the supported Authority runbook stops the process and then
copies its state directory. The record runtime's close drains derive, walks the
chain while both handles are still open, and fails an unsafe stop. A successful
stop therefore verifies the supported backup path; the process cannot prevent
an operator from making an unsupported live file copy.

## Minimum-v1 corrections (2026-08-08)

An independent review of the first implementation pass found release blockers.
Each is fixed, and each fix is recorded here because it changed a rule this
document states rather than only its code:

1. **A new append requires an unexpired lease.** `recordIngestInstallationContext`
   proved the access state was never revoked but not that it was still valid at
   the evaluation instant, so a lapsed member machine could still write its
   first record. The check is record-scoped and strict (`valid_until` must be
   later than the Authority's `checked_at`); recovering a receipt for an act the
   log already accepted takes the replay path and is deliberately unaffected, so
   a lease that expires mid-flight never strands a durable record.
2. **The reviewer is not the installation owner.** Ingest required the envelope's
   reviewer to equal the enrolled principal, which is wrong for a shared
   approval channel: any authorized member may approve a decision a colleague's
   machine submits. Submitter, evidence authority, organization, enrollment, and
   installation bind the machine; the reviewer binds itself, through the
   protocol's reviewer-to-evidence pin and the exact allowed audit row.
3. **Record-route validation is terminal.** A DTO or envelope-schema failure on
   the ingest route mapped to the shared `invalid_request`, which the member
   treats as retryable — so frozen, permanently invalid bytes would be resent
   forever. It now maps to `record_envelope_invalid`.
4. **The two size caps are aligned, not equal.** The route's raw cap is the
   256 KiB canonical-envelope contract *plus* the exact 20-byte
   `{"record_envelope": ... }` wrapper. Setting them equal made the largest
   envelope this document describes unsendable.
5. **The record store has a durable installation anchor.** `install-integrations`
   recreated a deleted immutable log. `authority.sqlite` now carries a record
   installation anchor beside the integrations one, and the state directory
   carries the matching marker. Serve refuses an unanchored record store, so an
   unanchored state provably holds no history and may be bootstrapped. An
   anchored state whose log or marker is missing fails closed and is never
   recreated. A missing derived file also fails serve and installation, but the
   stopped-state `rebuild-derived` command may recreate it after validating the
   existing log, marker, and anchor.
6. **A derive halt after start is fatal too.** The design already made a halted
   startup catch-up fatal. A halt under a live listener now closes the listener,
   refuses further ingest, and sets a failing exit code, because a process that
   keeps accepting records nothing will ever derive is exactly the silent
   staleness this design forbids.
7. **Submitter alerts reach the cycle.** The sweep reports a skipped or
   permanently rejected node by resolving with `ok: false`, not by throwing; the
   composition seam only watched for a rejected promise. Its counts and a
   bounded alert summary now land in `cycle.organization_record`, while the
   local cycle verdict stays independent.
8. **Intent has one default, and it states both fields.** The protocol-owned
   default is `{ restricted: true, reconsider_after: null }`; the member builder
   injects it directly instead of maintaining a second local restatement.
9. **A receipt is verified before it is frozen.** The signed receipt is checked
   against the authority public key and exact key id before the create-once
   write, and the record module additionally proves the document carries the
   exact committed payload.
