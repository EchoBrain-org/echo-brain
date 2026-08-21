# Server-core migration plan v2

**Status:** direction-setting plan, second version, written 2026-08-16 against
`main` at `4665c3a`. Supersedes v1 (`79cc444`) after a four-lens
adversarial review the same day invalidated two of v1's infrastructure
premises and surfaced three supersessions v1 made silently. The plan
proposes; it does not ratify. Phase 0 now defines exactly what ratification
means and produces `ADR-0001` as its artifact; no phase-1 code lands before
that ADR is accepted.

**Builds on:**
[2026-08-07-org-decision-record-append-derive-design.md](2026-08-07-org-decision-record-append-derive-design.md),
[2026-08-09-organization-permission-architecture.md](2026-08-09-organization-permission-architecture.md),
[2026-08-11-trusted-permission-aware-searchable-layer-2-design.md](2026-08-11-trusted-permission-aware-searchable-layer-2-design.md),
[2026-08-11-architecture-invariant-registry.md](2026-08-11-architecture-invariant-registry.md),
[org-brain-direction.md](org-brain-direction.md), and
[../architecture/organization-workspace-boundaries.md](../architecture/organization-workspace-boundaries.md).
The per-component machine ledger backing the fates table is
[2026-08-16-machine-boundary-audit.md](2026-08-16-machine-boundary-audit.md).

**Numbers:** LOC figures are measured at `4665c3a` (service rows scoped to
each service's `src/`, excluding tests). Fate assignments are judgment; treat
totals as ±10%. Command counts are exact.

## What changed from v1

1. **The infrastructure premises are corrected.** v1 assumed Postgres and
   four running services. In fact all four server workspaces persist with
   SQLite (`better-sqlite3`, synchronous transaction contracts baked into the
   application ports), and only `organization-authority` is a deployable
   service — record, retrieval, and control-plane are libraries it composes
   in-process, with all databases in one state directory. v2 therefore
   targets **one process and SQLite**, and treats Postgres and service
   extraction as deferred decisions with named triggers, not defaults.
2. **Custody is now explicit, and split from architecture.** The repo's
   product-control boundary (organization owns operations, database, backups,
   ingress, logs; ECHO holds no credential, key, or shell) is preserved, not
   silently reversed: v2's default is an **organization-operated** server.
   What does change is member-to-organization custody of raw transcripts —
   invariant `AD-06` — and v2 says so in the open, with a member-controlled
   valve as the compensating control. ECHO-hosted operation is a separate,
   later decision.
3. **A signing section exists** (v1 never said what signs the record after
   machine keys are deleted — and envelope admission fails permanently
   without an answer).
4. **Shadow mode is redesigned** as fixture replay with a synthetic resolver;
   the v1 design re-posted the same meetings forever and double-pulled
   Granola.
5. **Cutover is a gated drain**, because resolution is polling (there is no
   Slack webhook anywhere in the repo) and posted cards are frozen to the
   machine's credential ref — v1's cutover bullet orphaned every pending
   card.
6. **Phase 2 is scoped as real work** (the only session code today is an
   in-memory admin-console map behind one shared credential).
7. **A fourth fate is added:** the authority's own machine-lifecycle core
   (29 of 42 repository-port methods, 6 of 14 tables) shrinks when machines
   stop being principals; v1 said "the four existing services keep their
   roles."
8. v1's phase 0.3 (content-derived IDs) is **removed — the dedupe chain is
   already content-derived end to end**; the real identity question is the
   record log's `UNIQUE (installation_id, idempotency_key)` scope. v1's
   phase 0.4 is **answered**: decision-node and the record log are different
   layers (candidate lifecycle vs post-record truth); no shrink.
9. Counts corrected (28 leaf commands, not 26), invariants keyed to the
   registry, secret inventory completed, reviewer-load added to "what gets
   harder," per-phase kill criteria added, and the boundary audit committed
   alongside this plan.

## The physics change, in one paragraph

Today every machine is a complete instance of the product: it captures,
extracts, publishes, resolves, records, and searches, and the organization
record is an emergent property of N enrolled machines agreeing with each
other. The target inverts that: there is one record, held by the
organization's server, and machines are terminals onto it. A machine
**acts** (a human confirms a decision), **reads** (permission-scoped), and
**feeds only what nothing else can see**. It stops being a durable,
identity-bearing peer. The governing test for every machine-side design:

> If this machine were destroyed right now, is anything lost or
> unrecoverable? The answer must always be no.

## What ratification actually decides

v1 framed the decision as "software vs service." The review showed it is a
**custody** question, and that it splits into two decisions that v1 fused:

- **Where processing runs.** Moving the pipeline off laptops into the
  organization's server. This is what deletes the ~17,000 lines.
- **Who operates and holds custody.** Today the organization operates the
  authority and ECHO holds nothing (the recorded product-control boundary).
  That boundary can be preserved while processing moves.

`ADR-0001` (phase 0's artifact) must weigh four options:

- **A. Status quo plus:** keep machine processing; fix pain points
  incrementally. Null option; keeps all 17,000 lines and the fleet burden.
- **B. Organization-operated server-core (recommended default):** the
  pipeline moves into the organization-run authority process. Custody of raw
  transcripts moves member→organization (supersedes `AD-06`, stated below);
  ECHO still holds no credential, key, database, or shell — the
  product-control boundary survives intact. One container, SQLite, one
  operator: the org's admin (today, the founder, on the existing box).
- **C. ECHO-hosted service:** full custody transfer; ECHO operates
  multi-tenant infrastructure. Deferred to its own ADR when go-to-market
  demands it; nothing in phases 0-5 requires it, including phase 5 (an
  org-operated server can hold org-granted platform keys).
- **D. Local processing with server-held identity:** processing stays on
  machines; enrollment/PKI, secret custody, and backup move server-side via
  person sessions and short-lived scoped tokens. Deletes a large share of
  the 17,000 (enrollment, machine PKI, secret hardening, backup, the signing
  half of submission) while keeping `AD-06` fully intact. Honest costs:
  self-update stays, per-machine processing and its offline complexity stay.

The rest of this plan details option B. If D wins the ADR, phases 1 and 3
are replaced and the deletion list shrinks accordingly; if C is ever chosen,
it must additionally supersede the product-control boundary clause by
clause, in writing.

## Where the boundary sits today (corrected)

One deployable service — `organization-authority` — composes
`organization-record`, `organization-retrieval`, and
`organization-control-plane` as in-process libraries against SQLite files in
a single state directory, deployed as one app container behind Caddy (with a
Cloudflare tunnel) on an organization-operated box. A singleton runtime lock
refuses a second instance per state directory by design. The machine
installable is 33,407 non-test LOC; the boundary between them is the record
write: everything after it (append-only log, projections, policy facts,
permission-scoped search) is already server-side.

| Component | Non-test LOC |
| --- | --- |
| `src/` — the machine installable | 33,407 |
| `services/organization-authority` (only deployable) | 30,950 |
| `services/organization-control-plane` (library) | 7,226 |
| `services/organization-record` (library) | 7,192 |
| `services/organization-retrieval` (library) | 3,401 |
| `packages/` (protocol + api; includes `federation-protocol`, 667, still a declared dependency) | 11,239 |

The machine CLI has 28 leaf commands (27 advertised; `service-run` hidden):
21 are deleted with the daemon and lifecycle, 2 (`slack-link-begin/complete`)
become a web flow, and 5 survive as the act-and-read surface (`status`,
`approvals`, `organization readable-search`, `organization
recent-decisions`, `organization reviewer-recent-decisions`).

## Target shape

- **One deployable service, plus modules.** Processing (core cycle, decision
  processors, meeting sources, Slack surfaces, approval authorization) lands
  **inside the authority process** as a module behind a
  `check:boundary`-enforced seam. Separate processes are cut only when a
  named criterion demands it — independent scaling, blast radius, or
  credential scope — and any split must first replace the in-process
  eligibility-capability fence (a deliberately non-serializable object;
  crossing processes makes it forgeable data) with an authenticated,
  replay-bound equivalent.
- **SQLite stays.** Single process, single writer, existing trigger-enforced
  integrity model, existing tarball backup script. A Postgres migration is a
  deliberate future phase with its own scope (async port contracts across
  ~400 call sites, re-deriving ~119 triggers, redesigning retrieval's
  file-as-artifact model, and the position-assignment race) triggered only
  by a measured limit: sustained write contention, database size, or a real
  multi-replica need.
- **A thin machine client.** Login plus the five surviving commands, built
  on the `readable-search` request shape. Its size is **re-estimated after
  phase 2**, not asserted: v1's "~1,400 LOC" was anchored to
  `readable-search-reader.ts`'s 107 lines, which are thin precisely because
  the installation signer and ~2,900 LOC of retiring identity machinery do
  the authentication. Expect the session client to be small, but derive the
  number from the phase-2 implementation.
- **Caller identity is a person session, not an installation.** Sign-in
  resolves to principal + membership at evaluation time; self-only
  (caller = subject) is enforced and tested on every read path.
- **Credentials live in the organization server's secret store.** Complete
  inventory, not just the three v1 named: Slack bot token, meeting-platform
  keys, LLM provider keys, the authority's record-signing key, the admin
  console credential, the trusted-proxy token, the Cloudflare tunnel token.
  (A Slack signing secret joins this list only if push delivery is ever
  chosen — see below.) The Granola key is personal-account-scoped
  (`grn_…`); phase 0 either obtains an org-scoped credential from the vendor
  or records a explicit exception to the "short-lived scoped tokens only"
  refusal.
- **Slack stays pull.** Today resolution is polling (`reactions.get` per
  pending card each cycle) and its authenticity is free — the server pulls
  from Slack over TLS. v2 keeps that model server-side. Push (Events API)
  is out of scope until a measured latency need exists, and lands only as a
  unit with request-signature verification, timestamp windows, and replay
  protection; without those, a forged `reaction_added` resolves a card into
  the immutable record.

## Four fates

| Fate | ~LOC | Meaning |
| --- | --- | --- |
| Retired (machine) | 17,000 | Ceases to exist anywhere: lifecycle, self-update, backup/restore, enrollment + machine PKI, local secret hardening, filesystem transactions, the submission transport, 21 commands. Ledger: [2026-08-16-machine-boundary-audit.md](2026-08-16-machine-boundary-audit.md). |
| Relocated (machine) | 14,600 | Still the product, new address: core contracts + cycle, decision-node model, LLM processors, Granola source, Slack surfaces, the authorization stack, envelope building. Decision-node is a genuinely distinct layer from the record log (candidate lifecycle vs post-record truth) — it relocates, it does not dissolve. |
| Retired (authority) | not yet sized | The second deletion pass v1 missed: enrollment, access leases, and internal-live self-update rollout — 29 of 42 repository-port methods, 6 of 14 tables, with `enrollment ≡ installation` baked into the schema. Executed as phase 4b after the `enrollment_id → principal/session` re-keying, and sized during phase 2. |
| Stays (machine) | small; re-estimated in phase 2 | The act-and-read client plus session handling. |

## Identity and signing

What breaks without an answer: envelope admission authenticates each record
against the submitting enrollment's installation key and fails **permanently**
(`record_signature_invalid`) on mismatch; receipts bind to the same key; the
constitution's trust-ladder rung 1 is defined as installation-signed.

The v2 answer, under option B:

- **The organization's authority signs the record.** Its record-signing key
  already exists and already makes receipts meaningful. The processing
  module runs inside the same trust domain and submits through an in-process
  path; `assertEnrolledSubmitter`'s five bindings are restated for a
  submitter that is the organization itself.
- **Per-actor provenance comes from authorization evidence, not the
  transport key.** The reviewer/member evidence embedded in each envelope is
  already re-proved server-side against the immutable audit row — that
  mechanism survives unchanged and becomes the per-actor truth.
- **Idempotency re-keys deliberately.** The log's uniqueness is
  `UNIQUE (installation_id, idempotency_key)`. New rows write under
  organization scope (the single writer serializes; the content-derived
  `idempotency_key` already makes one candidate one row); existing rows keep
  their historical `installation_id` untouched — the log is append-only and
  is not migrated.
- **Concentration is compensated off-host.** Collapsing N machine signers
  into one custodian removes the only external rollback-detection artifact
  (client-held receipts; the chain itself cannot detect tail truncation).
  Before the last machine retires its receipts, the authority publishes a
  periodic signed head checkpoint (position + record hash) to a store
  outside its own custody, and the restore runbook's reconciliation step
  switches from client receipts to checkpoints.
- The trust-ladder rung-1 wording and the constitution's caller model
  (installations and persons; now also a service principal) are amended
  through the constitution's own review process, as design work in phase 2,
  not silently.

## Phases

Ordering rule, unchanged: at no point may create-once semantics be absent,
and at no point are there two canonical writers to one organization's
record. Each phase now ends with a hold point; the next phase starts on its
criterion, not on momentum.

### Phase 0 — decide (artifact: `ADR-0001`)

1. Write and accept `ADR-0001` weighing options A-D above. It must name the
   `AD-06` supersession (raw transcripts move member→organization server;
   bounded egress becomes "transcripts reach only the organization-operated
   server, never ECHO") and confirm the product-control boundary is
   preserved. No phase-1 code before acceptance.
2. Rotate the exposed Granola credential (independent standing item), and
   resolve the org-credential question (personal `grn_` key vs the refusal
   table).
3. Decide the **member valve successor**: the landed pre-ingest exclusion is
   member-controlled by explicit design (custody is member-side, so the
   member owns the valve). Under option B the successor is a member-scoped,
   member-writable exclusion held on the server and consulted **at pull
   time** — before content exists in the pre-record store — editable from
   the thin client/web. If instead the valve is being dropped, the ADR says
   so and why the previously rejected org-administered model is now
   acceptable.
4. Draft the visibility floor (ingested content with no human visibility
   intent defaults to `invisible`) **and** the pre-record plane's
   governance: the processing module's service principal, who may read the
   pre-record transcript store, its retention and deletion rule, and
   fixture-corpus disposal. The landed permission plane governs records;
   phase 1 creates a transcript store months before phase 5, and it must
   not be born ungoverned.
5. Disposition `feat/onboard-slice-1` (7 unpushed commits): push to
   preserve RFC-0001 and the record of why; build no further slices.
6. Decide local-only mode (`jsonl-outbox`, ~680 LOC, dies with it).

### Phase 1 — processing module, validated by replay

- Move `core/`, decision processors, the Granola adapter, and the Slack
  surfaces into an authority-hosted module behind a `check:boundary` seam.
  Decision-node slots become SQLite tables preserving create-once as unique
  constraints (a conflicting insert is a refusal, never an overwrite) and
  keeping the frozen presentation contract: a posted card is never
  reinterpreted; changed content creates a new node.
- **Validation is fixture replay, not a live shadow.** Capture a corpus of
  real meeting batches; run the module against it with a synthetic resolver
  supplying approvals/rejections; compare outputs to the machine pipeline's
  for the same corpus. No second live Granola puller (the cycle's cursor
  only advances when nothing is pending — a live shadow with no human
  re-pulls and re-posts the same window forever, and doubles provider load
  with no way to honor `Retry-After`).
- Exit tests: the same job run twice concurrently yields one card; a
  replayed reaction observation yields one resolution; a deliberately stale
  projection returns a withdrawn item as invisible; fixture-replay parity
  with the machine pipeline.
- Instrument the gate from day one: accept / edit / reject per candidate,
  tagged by source and decision type. Phase 5 is gated on this data.

### Phase 2 — person sessions (named work items, not a refactor)

- Identity: choose the sign-in mechanism (self-hosted email/passkey vs
  external IdP) — an ADR-level choice, made explicitly.
- A durable session store (the only session code today is an in-memory
  admin-console map behind one shared credential; it is not a starting
  point), with issuance, expiry, refresh, and revocation defined.
- Session→principal resolution feeding the authorizer; caller-binding
  preimage v2 (today it embeds `enrollment_id` + `installation_id` and is
  audited for stability across a query), with a stated meaning-migration
  for already-written audit rows.
- The Slack identity link becomes a web flow. The member valve ships. The
  thin client v0 ships, and "stays" is re-estimated from it.
- The client's session is credential-shaped and v2 says so: stored with
  stated location/mode, bounded lifetime, revocation on the server, Person
  state re-checked per request (a session never substitutes for fresh
  Person state). The phase-4 CI rule carves out exactly this one store.

### Phase 3 — cutover as a gated drain

Per machine, two steps with a gate between:

1. The daemon keeps running and polling **with its original credential**
   (posted cards are frozen to that credential ref and fail closed on
   rotation) until an operator command reports zero pending cards and
   `record-flush` reports zero unsubmitted records. Before starting, an
   admin pre-issues a re-enrollment grant for the machine — the rollback
   path — and nothing is revoked until the machine is confirmed retired.
2. Only then: stop, uninstall, retire keys. The machine's Slack/Granola
   credentials move into the server store (rotation happens here, after
   drain, never before).

Cutover also names its trust-store step explicitly (the previous server
move broke every enrolled Mac via the stored authority CA; `rebind` exists
for exactly this), and the off-host checkpoint from the signing section is
live **before** the first machine retires.

Hosting during the pilot is named: the existing organization-operated box
(single container + Caddy + tunnel), operated by the founder as the org
admin, best-effort uptime, founder on call. After this phase the founder's
daily loop depends on that box; that is accepted, in writing, here.

**Hold point:** phase 4 deletion does not begin until the server writer has
run 14 days with zero unavailability incidents and the founder's daily loop
intact.

### Phase 4 — deletion and enforcement

- 4a: delete the machine-side retired set (~17,000 LOC, 21 commands),
  porting the submission failure taxonomy onto the in-process
  processing→record path **before** deleting the transport that taught it.
- 4b: the authority pass — delete enrollment, access-lease, and
  internal-live subsystems after the `enrollment_id → principal/session`
  re-keying (a schema migration of the largest service's core, sized in
  phase 2).
- CI: the thin client becomes a real workspace package (today no machine
  package exists for `check:boundary` to bind); signing/lock/SQLite bans
  are manifest edits, and the `fs` read-vs-write distinction is a small
  check-boundary enhancement (builtins are currently matched at module
  granularity).
- Registry re-baseline: key the surviving invariants, record `AD-06`'s
  supersession, and mark superseded qualification/evidence claims —
  `QUAL-*`/`EVID-*` rows prove behavior of an architecture phase 4 deletes,
  and must not read as current afterward.
- Remove the `federation-protocol` dependency if the protocol split allows.

### Phase 5 — central-auth ingestion (three gates)

Gates: (1) the visibility floor is **landed**, with ingested-but-unreleased
content invisible by default; (2) the pre-record governance from phase 0.4
is landed; (3) **measured reviewer capacity** from phases 1-4 data — a
stated maximum approval-queue age and a minimum edit-rate below which
widening ingestion is refused. The wedge is one human's confirmation;
organization-wide ingestion against a saturated gate produces either
rubber-stamping (which hollows out the trust ladder) or a backlog (which
reads as broken). n=1 already produced a ten-meeting backlog once.

Order: Zoom server-to-server → Teams (policy step + metering budgeted) →
Google (domain-wide delegation is real work). A human release remains
simultaneously the record write and the visibility grant. Manual entry
stays first-class. None of this requires ECHO hosting (option C).

## Invariants that must survive, keyed to the registry

Registry invariants `INV-01` through `INV-10` and `AD-01`-`AD-08` remain
binding through the migration, with exactly one supersession:

- **`AD-06` — superseded by `ADR-0001`** (raw custody member→organization
  server; ECHO never; member valve compensates; bounded egress restated).
  Every other `AD-*` retains its status.
- `INV-01`-`INV-10` (authorization before scoring, no stamped reader
  identities, existence≠content, witnesses, one consistency boundary,
  failure cannot widen access, inherited visibility, models cannot widen,
  no recipient lists, auditable decisions) are unchanged and apply to every
  new read path this plan creates, including the pre-record plane.

Migration-specific invariants added by this plan:

1. **Create-once, never reinterpret** — filesystem slots become unique
   constraints; the guarantee is rebuilt before the files are deleted.
2. **One serial append stream per organization** — under SQLite today this
   is the writer lock plus triggers; any future Postgres phase must
   re-establish it explicitly (the current `MAX(position)+1` pattern is
   only safe under a database-wide writer lock).
3. **Idempotency by content, not by attempt** — already true end to end
   (`meetingProcessingKey` → `approval_id` → envelope key); preserved, with
   insert-before-post for every external surface.
4. **Fail closed on projection lag** — staleness never resolves toward
   permitted (registry `INV-06`).
5. **Self-only reads** — caller and subject resolve to the same active
   principal (constitution; now enforced server-side per request).
6. **Human release creates the policy fact from which visibility is derived
   at query time** — never a reader list (phrased to respect `INV-02` and
   `INV-09`).
7. **Recovery depends on no provider's uptime** — carried to deploy and
   rollback; restore reconciliation switches from client receipts to
   off-host checkpoints.
8. **The machine is never durable and never a principal** — crash-only;
   feeds re-read durable sources; watermarks live server-side; the one
   carve-out is the phase-2 session store.

## What gets harder — accepted, not hidden

- **The permission brain grows**: one org credential reaches everything, so
  authorization must scope reads and publication targets, not just actions.
- **The organization's server becomes load-bearing for daily use.** Under
  option B this is the org admin's obligation (today: the founder and one
  box), not ECHO multi-tenant ops — but outages now stop everyone; offline
  is surrendered at phase 3, on purpose.
- **Reviewer load is the wedge's own failure mode.** Every widening of
  ingestion multiplies candidates against the same human gate; phase 5's
  quantitative gate exists because of this.
- **Signing concentrates.** One custodian signs where N machines did;
  compensated by re-proved evidence and off-host checkpoints, and said out
  loud.

## How the 17,000 lines grow back, and the refusals

| Pressure | Refusal |
| --- | --- |
| "It should work offline" | No local queue, ever. The durable source is the queue. |
| "Cache it locally for speed" | Only if delete-and-refetch is always correct and nothing reads it when the server is down. A fallback cache is state. |
| "This user needs their own key" | Server holds every credential; short-lived scoped tokens only. The Granola exception, if kept, is recorded in `ADR-0001`, not assumed. |
| "We can't send transcripts to your cloud" | Already answered by option B: they don't — the organization's own server holds them. ECHO hosting is a separate ADR. |
| "Prove it came from a managed device" | Device attestation is the installation signer reborn. If ever accepted, it is budgeted consciously as a feature. |
| "Approvals should be instant — add a webhook" | Pull until a measured latency need; push lands only as a unit with signature verification and replay protection. |
| Anything resident on the machine | Event-driven and short-lived, or crash-only. A shutdown handler that flushes something is the tell. |

## Out of scope for v2

- Postgres and service extraction (deferred behind named triggers, above).
- ECHO-hosted operation (option C — its own ADR).
- Push delivery for Slack events.
- The machine-side capture feeder for agent transcripts and unpushed git
  (echo-context territory); its constraints bind later work: stateless,
  never buffering, server-side watermarks, content-addressed identity.
- On-prem packaging beyond option B's own shape, device attestation,
  offline mode, local caches, any federation revival.

## Open questions

1. Sign-in mechanism for person sessions (self-hosted passkey/email vs
   external IdP) — phase 2's first decision.
2. Whether Granola offers an org-scoped credential, or the personal-key
   exception stands.
3. The pre-record store's retention number and deletion mechanics
   (phase 0.4 sets the policy; the number needs choosing).
4. The exact constitution amendments for rung-1 wording and the service
   principal — drafted in phase 2, reviewed under the constitution's own
   process.
5. Which of the twelve machine `doctor` checks survive as service health
   checks.
