# Organization decision record: append and derive design (v1)

**Status:** Design approved in founder session 2026-08-07; amended 2026-08-08
after code cross-reference audit and independent efficiency review; industry
cross-reference pass 2026-08-08 (see "Industry cross-reference" section);
implementation not started
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
   permission layer against current org membership. A derive bug therefore
   cannot widen access. (This refines the direction doc's "audience …
   travel[s] with the approved record": intent markers travel; resolved access
   never does.)
4. **The log unit is what the human approved.** One approval event stores the
   resolved decision package (the `DecisionBrief` with its evidence spans) in
   RFC 8785 canonical form. Per-signal atoms are a derived, rebuildable
   projection, never log content.
5. **Rejections are logged as acts, not content.** A rejection event records
   that a package was rejected (by whom, when, optional reason, optional
   `reconsider_after`). The rejected content stays in the member machine's
   local store. A later revisit that gets approved ships as a normal approval
   linking back to the rejection.
6. **Raw-source custody stays local.** Transcripts and vendor payloads never
   travel. Only the bounded evidence spans already inside the approved brief
   cross the wire, plus pointers (meeting id, block id, timestamps) back to the
   local source. Organization ingest is a second egress path alongside the
   existing delivery pipeline (Slack, outbox); both are bounded to brief
   content, and they remain separate acts with separate idempotency keys.
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
- `record-derived.sqlite` — the derived graph. Disposable, rebuildable.

Boundary rules that keep later extraction to a standalone service mechanical:

- The wire contract stays in the shared packages exactly as if the service
  were remote; the submitter never knows the difference.
- The record module touches the authority only through its public application
  interface (the existing installation-signed-command path used by the Slack
  identity-link routes). It never opens `authority.sqlite`.
- Ingest routes mount on the existing authority HTTP listener.
- Receipts are signed with the existing authority signing key — which member
  machines already pin and verify — under a domain-separated signing context
  (`organization-record-receipt.v1`), never a new service identity.

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
  exemption is explicit in the validator, not a global raise.
- The payload schema necessarily restates the `DecisionBrief` shape that core
  validates (core imports no packages, by design). The two are pinned together
  with shared golden fixtures rather than shared code.

## Envelope contract (v1)

Two event types now; `correction` reserved but unbuilt.

**Approval event**

- `schema_version: 1`, `event_type: 'approval'`
- `idempotency_key` — the existing sha256 approval id derived from the decision
  node's processing key (already the cross-boundary identifier used with the
  authority)
- `payload` — the resolved decision node in canonical form: `DecisionBrief`
  (meeting, participants, decisions/actions/rationales with verbatim
  `EvidenceSpan`s), alternatives, links, `reviewed_at`, surface. In v1,
  `alternatives` is always empty and `links` always null (the local store
  hardcodes them); they are carried for shape stability.
- `reviewer` — the authority-verified `principal_id` and `membership_id` from
  `resolved_metadata.authorization` when present, plus the configured display
  name (`reviewed_by`) as display-only. The verified id is the identity of
  record; the display name is never load-bearing.
- `intent` — `{ restricted: boolean, reconsider_after?: string }`,
  approver-set, default `restricted: false`. The current Slack approval
  surface has no input affordance for intent (two reactions and one reply
  field), so v1 always submits the default; the affordance (third reaction or
  modal) is deferred until observed need. The contract carries the field from
  day one so its later arrival is not a schema change.
- `submitter` — installation id, `submitted_at`
- `signature` — installation signing key over the RFC 8785 canonical bytes,
  via the existing `signed-document` primitives

**Rejection event**

- `schema_version: 1`, `event_type: 'rejection'`
- `idempotency_key` — same derivation as approvals
- `payload` — meeting id, `rejected_at`, optional free-text `reason`, optional
  `reconsider_after` timestamp. No brief content.
- `reviewer`, `submitter`, `signature` — as above

Approved and rejected acts both enter the org timeline; only approved content
does.

## Ingest protocol and log storage

**Submitter (member side).** No watcher daemon and no separate state store.
Mechanism: a post-resolve hook plus a startup sweep. The pending queue is
defined by the decision node's own slot files: `resolved.json` present,
organization receipt slot absent.

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
submitter before building any envelope of either event type, effective until
a receipt exists and powerless after (see the erasure trap). An org-distributed
exclusion floor (an admin list merged into the same check, subtractive only,
distributed over the existing authority-to-member channel) is deliberately
deferred: it touches no frozen surface, so it can be added whenever a real
org needs it. An unreadable or
invalid exclusion config fails closed: the submitter ships nothing and
alerts. The `approvals` CLI projection shows affected nodes as `excluded`;
the org side has no trace. On success the receipt is filed as one more
write-once slot in the node directory (the existing `recordPublished`
create-once idiom, surface `organization-record`). Filing is atomic-create;
a receipt slot can never be overwritten. Retries reuse the same idempotency
key; there is no timer pressure. The append path for a decision is complete
when its receipt slot exists.

*Prerequisite fix:* `DecisionNodeStore.list()` currently throws on any legacy
node carrying federation metadata, which would poison the startup sweep. It
must skip such nodes with a loud operator alert before the submitter ships.

**Ingest (module side).** Three steps, in order:

1. **Verify** — in-process via the authority's application interface: current
   access lease, installation signature over the canonical bytes, schema
   validation of envelope and payload. Payload validation happens before
   append, always — an immutable log must never accept a record that derive
   cannot process.
2. **Dedupe** — a known idempotency key returns the original receipt unchanged.
3. **Append** — one record at the next monotonic position, then return a
   receipt signed by the authority key under the receipt signing context.

**Log table.** Append-only: `position` (monotonic integer primary key),
canonical envelope bytes, `record_hash = sha256(prev_record_hash || envelope_bytes)`,
`recorded_at`. The hash chain plus member-held receipts (each carrying
`position` and `record_hash`) is the tamper-evidence mechanism: deletion,
truncation, or reordering invalidates receipts already filed off-box.
Per-envelope signatures alone cannot detect removal. A verify command walks
the chain, and it runs at process start and before every backup — a chain
nobody walks is decoration (transparency-log practice:
[Sigstore Rekor](https://github.com/sigstore/rekor) /
[Google Trillian](https://github.com/google/trillian)). No update or delete
statement exists in the codepath.

**Receipt.** Signed: envelope id, idempotency key, log position, record hash,
recorded-at.

**Rejected ingest is loud.** Expired lease → submitter refreshes and retries.
Bad signature or schema → permanent rejection with reason, filed on the member
side and surfaced to the operator (the `approvals` CLI projection must learn
to show receipt/rejection state; today it shows neither).

## Derive v1 (deterministic)

A follower inside the same process. State: a single cursor (last processed log
position) in `record-derived.sqlite`.

**Wake mechanism (correctness, not optimization):** an in-process nudge after
each append commit, plus a full catch-up pass from the cursor at process
start. No standing poll timer. A crash between append and derive is healed by
the startup catch-up; staleness during an outage is visible and bounded by
process restart.

**Nodes**

- `atom` — kind `decision | action | rationale`, text, subject, status/owner/
  due (kind-specific), confidence, evidence spans, `restricted` flag, approval
  provenance (verified reviewer principal id, display name, `reviewed_at`,
  approval group, log position)
- `meeting` — meeting id, title, time
- `participant_observation` — meeting id, observed name/email exactly as
  captured. **No principal binding in derive** — observations stay
  observations; resolution against membership is query-time gatekeeper work
  (binding in derive would read authority state that is not log content and
  break rebuild determinism).
- `rejection` — derived from rejection events: meeting id, reviewer, time,
  reason, `reconsider_after`

**Edges**

- `derived-from` — atom → log record
- `from-meeting` — atom → meeting
- `attended-by` — meeting → participant observation
- `supports` — rationale atom → sibling atoms, from `supports_signal_ids`

Atoms from one approval share its approval group (approval-group provenance).

**Determinism.** Every derived row id is a pure function of log content:
atoms hash (log record hash, signal id); rejections hash the log record hash;
meetings key on meeting id; observations hash (meeting id, observed identity).
Derivation reads nothing but the log. The tested property: a full rebuild
(delete `record-derived.sqlite`, cursor to zero, replay) produces the same
**canonical content digest** — a hash over an ordered dump of all rows — as
the incremental run. (Not file-byte identity: SQLite page layout varies across
library versions.) If derive encounters an unprocessable record — which
ingest-time payload validation should make impossible — it halts with an
operator alert rather than skipping; staleness is visible, truth untouched.

## Concurrency and freshness

All three machines run in one process in v1; the separations are logical and
enforced by the data-at-rest interfaces, not by process boundaries.

- The log tail is the single serialization point: one append at a time (a
  sub-millisecond transaction), required anyway for monotonic positions and
  the hash chain. Member submissions interleave freely; verify and dedupe
  overlap.
- With DELETE journaling, writers briefly exclude readers per database; at
  pilot volume (a handful of records per day) contention is unmeasurable, and
  the log and derived stores are separate database files, so ingest appends
  and derive reads/writes touch different locks.
- Derive commits atomically per log record, so any future reader sees a
  consistent snapshot — never half an approval's atoms.
- Latency contract: the approver waits only for the receipt (append round
  trip); derivation follows within the same process tick via the nudge. No
  stage ever blocks awaiting another stage's completion downstream, and
  append never waits on derive.

## Access policy (recorded, not enforced in v1)

The future gatekeeper reads graph facts plus authority membership at query
time — including resolving participant observations to principals. Initial
policy, changeable without touching the log: unflagged atoms resolve
org-wide; `restricted` atoms resolve to source-meeting participants;
rejection events (minimal payload) are org-visible as acts. The authority's
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
  human maintains these lists per record. Our envelope reconstructs them from
  facts already captured: decision-maker = verified approver principal;
  consulted = participant observations on the source meeting; informed =
  delivery receipts. A future derived view answers "who decided, who was in
  the room, who was told" per decision with zero form-filling.
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

## Testing

- Protocol package: canonical serialization and signature round-trip; golden
  envelope fixtures for both event types; shared golden fixtures pinning the
  payload schema to core's `DecisionBrief` validator.
- Module: ingest integration (dedupe and replay, chain verification, lease and
  signature rejection paths, oversize payload rejection at the 256 KiB cap).
- Derive: determinism property (incremental run and full rebuild produce the
  same canonical content digest); crash-resume via startup catch-up.
- Submitter: post-resolve hook fires; startup sweep finds resolved-without-
  receipt nodes; receipt slot is create-once; legacy-metadata nodes are
  skipped with an alert, not fatal; an excluded source produces no envelope
  of either event type.
- End-to-end: approve on a member machine → receipt slot filed → atoms
  queryable in the derived store; repeat from the second pilot machine; zero
  duplicates.

## Success criteria (pilot)

1. Every approval and rejection from both pilot machines lands exactly once in
   one org log with a verifiable hash chain.
2. The derived graph answers: which decisions came from which meeting, who was
   observed attending, who approved (verified principal), what supports what.
3. `intent` travels end to end (default values in v1; the field, not the
   affordance).
4. A full rebuild reproduces the derived store's canonical content digest
   exactly.

## Out of scope (deliberate)

- Retrieval, the permission gatekeeper, observation-to-principal resolution,
  and any query surface.
- Interpretive derivation: entity resolution, model-proposed
  supersedes/relates edges, atom ranking.
- Approval-surface affordance for `restricted` / `reconsider_after` (contract
  field ships; input UI deferred until observed need).
- `correction` events (shape reserved in `event_type` only).
- Resurfacing of `reconsider_after` rejections (the fact is logged; the
  reminder behavior is a future derived-side feature).
- Post-ingest erasure/redaction — payload tombstoning via a
  `correction`-family event is the named future mechanism (see Industry
  cross-reference: recorded traps).
- Standalone-service extraction of `organization-record` (boundary rules above
  keep it mechanical if scale demands it).
- Hardware-backed installation keys: current signer is exportable software
  keys only (`--allow-exportable-software-key`); raising the key floor is an
  existing, separate concern.
- Any UI beyond existing operator surfaces (with the noted exception: the
  `approvals` CLI must learn to show receipt/rejection state, which is in
  scope for the submitter).
