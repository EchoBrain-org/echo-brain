# Server-core migration plan v3

**Status:** direction-setting plan, third version, written 2026-08-17 against
`main` at `4665c3a`. Supersedes v2 (`4045154`) after a second review that
made two premises explicit, found a second silent supersession, and
re-scored the option set. v2 stays in the tree unchanged so the two versions
can be read side by side; the history reads v1 (`79cc444`) → v2
(`4045154`) → v3. The plan proposes; it does not ratify. Phase 0 produces
`ADR-0001`; no phase-1 code lands before that ADR is accepted.

**Objective (the one sentence).** Move the canonical organization record and
all processing from N machine peers to one organization-operated server —
deleting ~17,000 lines of machine code — without the record ever having two
canonical writers, and without ECHO ever holding a credential, key, or shell.

**What accepting *this document* does, and does not, authorize.** Accepting
this plan authorizes **only Phase 0**: writing `ADR-0001`. It does **not**
adopt option B, and it does **not** authorize any Phase 1+ work. Option B
(below) is this plan's *recommendation*; the actual choice among options A–D
is made when `ADR-0001` reaches status `accepted`. "Ratification," used
throughout, means exactly that event — `ADR-0001` accepted — and nothing
else. The approver is the founder, as organization owner, under the
[decisions lifecycle](../decisions/README.md).

**Builds on:**
[2026-08-16-server-core-migration-plan-v2.md](2026-08-16-server-core-migration-plan-v2.md)
(narrative, corrected baseline, and the phase skeleton this version hardens),
[2026-08-16-machine-boundary-audit.md](2026-08-16-machine-boundary-audit.md)
(the per-component ledger every LOC figure below is drawn from),
[2026-08-07-org-decision-record-append-derive-design.md](2026-08-07-org-decision-record-append-derive-design.md),
[2026-08-09-organization-permission-architecture.md](2026-08-09-organization-permission-architecture.md),
[2026-08-11-trusted-permission-aware-searchable-layer-2-design.md](2026-08-11-trusted-permission-aware-searchable-layer-2-design.md),
[2026-08-11-architecture-invariant-registry.md](2026-08-11-architecture-invariant-registry.md),
[org-brain-direction.md](org-brain-direction.md), and
[../architecture/organization-workspace-boundaries.md](../architecture/organization-workspace-boundaries.md).

**Numbers:** LOC figures are the audit's, measured at `4665c3a`, non-test,
±10%. Command counts are exact. Every threshold in a success criterion that
is not measured today is marked **(proposed default)**; the reasoning sits
next to it and the appendix collects them all in one ledger with the phase
that re-evaluates each.

## What changed from v2

1. **Two premises are now stated, and every option is scored against
   them.** v2 weighed the options as if extraction could run anywhere and as
   if the buyer were undecided. Neither is true: extraction requires a hosted
   model provider for the foreseeable future, and the buyer is an executive
   purchasing for an organization. Both premises move the recommendation
   toward option B and away from D; v3 says so and shows the arithmetic.
2. **`AD-05` is named as the second supersession.** v2 claimed "exactly one
   supersession." The registry's `AD-05` reads "the rejected package stays
   local"; under option B the candidate lives in the server's pre-record
   store from pull time, so rejection withholds an atom rather than
   withholding content. Two registry rows change, not one.
3. **`AD-06`'s baseline status is corrected.** The registry marks it
   "Implemented at baseline." That is true only under the shipped
   `structured-text` processor. Any configuration that selects the LLM
   processor with a hosted provider already sends the canonical meeting off
   the machine. The supersession therefore corrects a status that was
   already conditional, rather than trading away a property that held.
4. **The member valve is described by both of its landed properties.**
   Member control and no-org-trace. Option B preserves the first and cannot
   preserve the second; v3 says which and what compensates.
5. **Granola is demoted from a phase-0 blocker to a bridge source.** Its
   workspace credential reaches only shared notes; its personal credential
   would let the organization read what the vendor's own admins cannot.
   Under an executive sale the primary ingestion path is org-tenant
   platforms (Zoom, Teams, Google), so the Granola question stops deciding
   the architecture and becomes a scoped bridge decision in phase 0.
6. **The deletion figure is split into its two tranches.** About 6,000
   lines come off by moving identity and operations server-side while
   compute stays local (option D's share); the remaining ~11,000 require
   moving compute. B's marginal advantage over D is the second number, and
   ADR-0001 must weigh that number, not the gross 17,000.
7. **Option C has a named trigger instead of an indefinite deferral.** The
   executive sale walks toward ECHO-hosted operation. v3 states the trigger
   and what C must supersede, so the decision is taken deliberately rather
   than under deal pressure.
8. **Every phase now has entry, exit, and kill criteria**, each testable,
   and every hold point measures the regime it protects rather than the
   regime that precedes it (v2's phase-3 hold measured 14 pilot days at n=1
   before daily load arrived).
9. **Reviewer capacity is promoted from a phase-5 gate to the plan's central
   product risk**: the instrument is built in phase 1, accrues real human
   data from phase 3, and is reported at every hold from phase 3 on.
10. **Deployment maturity is priced in.** An executive buyer's security
    review is the named trigger for the HA/backup/DR work v2 deferred behind
    "measured limits."
11. **The re-enrollment rollback grant has a bound.** Lifetime, use count,
    and channel are stated; a live bearer grant for the length of a drain is
    otherwise the same threat RFC-0001 lists first.

## Premises

Each premise is a fact the plan depends on. If one falls, the section named
under it is what changes.

**P1 — Extraction runs on a hosted model provider.** No on-device model is
viable for the near term. Consequence: under every option except A-with-
`structured-text`, the canonical meeting leaves the employee's machine and
reaches a third party. The only custody question left is whether the
organization's own server also sees it. If P1 falls (a viable local model
lands): option D's custody advantage returns and the tranche arithmetic in
"Four fates" is re-run.

**P2 — The buyer is an executive purchasing for the organization.** The
employee installs because the organization adopted the product, not because
the employee chose it. Consequence: fleet install is a procurement cost, not
a feature; the employee-from-employer boundary is a compliance requirement
to satisfy, not a selling point to lead with; sources trend org-tenant. If
P2 falls (bottom-up, employee-chosen adoption): the member valve returns to
being a product feature, the Granola bridge stops being a bridge, and D is
re-scored.

**P3 — Org-tenant platforms are the primary ingestion path.** Zoom
server-to-server, Teams, and Google domain-wide delegation carry credentials
that cannot live on laptops. Consequence: phase 5 is not a widening; it is
where most of the corpus comes from, and Granola is a bridge for early
accounts. If P3 falls (customers arrive with personal-account notetakers
and no tenant platform): the Granola per-scope problem in "Custody ledger"
becomes load-bearing again.

**P4 — Customer-hosted operation is the wedge.** The recorded
product-control boundary (organization owns operations, database, backups,
ingress, logs; ECHO holds no credential, key, shell, or audit visibility) is
the claim that wins a security review against multi-tenant notetakers.
Consequence: option B preserves it intact and v3 leads with it; option C
spends it. If P4 falls (buyers demand SaaS and will not run a container):
the option-C trigger in "What ratification decides" has fired.

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

Under P1 the third verb is honest only for sources that never reach a
provider or a tenant — the machine-side capture feeder for agent transcripts
and unpushed git, which is out of scope here and named under its own
constraints. For meeting sources the machine has nothing to feed that the
server cannot pull.

## What ratification actually decides

Two decisions, kept separate as v2 established: **where processing runs**
(the deletion) and **who operates and holds custody** (the recorded
product-control boundary). Under P1 a third property that v2 treated as
free — where the raw meeting rests — is no longer a differentiator between
B and D, because in both the meeting reaches a hosted provider. That is the
single largest change to the scoring.

`ADR-0001` (phase 0's artifact) weighs four options against P1–P4. The
option choice is **genuinely open until `ADR-0001` is accepted** — this plan
recommends B but does not decide it. Everything from "Phases" onward describes
the B path; if `ADR-0001` selects another option, those phases are void and
rewritten.

| Option | Processing | Custody operator | Raw meeting reaches | Deletes | Preserves product-control boundary |
| --- | --- | --- | --- | --- | --- |
| **A. Status quo plus** | machine | organization | provider (if LLM processor) | ~0 | yes |
| **B. Organization-operated server-core (recommended)** | organization server | organization | organization server + provider | ~17,000 machine + authority pass | yes |
| **C. ECHO-hosted service** | ECHO | ECHO | ECHO + provider | ~17,000 + org ops burden | **no** — superseded clause by clause |
| **D. Local processing, server-held identity** | machine | organization | provider (if LLM processor) | ~6,000 (tranche 1) | yes |

**Why A is rejected.** Option A (status quo plus) deletes ~0 lines and leaves
N durable, identity-bearing machine peers — the exact fleet burden and custody
fragmentation this migration exists to remove. It is the do-nothing baseline,
kept in the table only as the null comparison.

**Why B over D under the premises.** D's custody advantage was that the raw
meeting stays on the machine. Under P1 it does not; it goes to the provider
from the machine instead of from the server, and the machine holds an
org-paid provider key to do so — N laptops each holding a credential the
refusals table forbids, with no central rate limit, spend control, or
pinned model version, and an extra hop that adds latency and an availability
dependency while buying nothing. Under P2 the fleet install D keeps is a
procurement cost. D's remaining advantages — offline capture and blast-radius
containment — are real and are listed under "What gets harder" as B's
accepted costs. ADR-0001 must show that D was scored against the marginal
number (~11,000) and lost on P1 and P2, not on the gross figure.

**Why not C now, and when.** C spends P4. The trigger for opening the C ADR
is any one of: a qualified buyer refuses to operate a container as a
condition of purchase; a second organization is onboarded and the founder is
operating both boxes; or the deployment-maturity gate below is failed twice
in a row for the same cause. When it opens, C's ADR must supersede
[the product-control boundary](../architecture/organization-workspace-boundaries.md)
clause by clause, in writing, and must state which of P4's claims survive
under a single-tenant-per-instance hosted model, if any.

**What ADR-0001 must contain, minimum.** P1–P4 as inputs; the option table
above with the marginal deletion figure; the two supersessions (`AD-05`,
`AD-06`) with `AD-06`'s conditional baseline noted; the valve successor's two
properties and which survives; the Granola bridge decision; the C trigger;
the disposition of `feat/onboard-slice-1`; and the pre-record plane's
governance from phase 0.4.

## Where the boundary sits today

Unchanged from v2 and restated only as far as the criteria below depend on
it. One deployable service — `organization-authority` — composes
`organization-record`, `organization-retrieval`, and
`organization-control-plane` as in-process libraries against SQLite files in
one state directory, one container behind Caddy with a Cloudflare tunnel, on
an organization-operated box, singleton runtime lock per state directory.
The machine installable is 33,407 non-test LOC; the boundary is the record
write. The CLI has 28 leaf commands: 21 delete, 2 become web flows, 5
survive.

## Target shape

Unchanged from v2 except where noted:

- **One deployable service, plus modules.** Processing lands inside the
  authority process behind a `check:boundary`-enforced seam. Separate
  processes are cut only on a named criterion, and any split first replaces
  the in-process eligibility-capability fence with an authenticated,
  replay-bound equivalent.
- **SQLite stays**, single writer, existing trigger-enforced integrity.
  Postgres and service extraction are deferred behind the triggers named in
  v2 **plus one v3 adds: an executive buyer's security review requiring
  multi-replica availability.** Under P2 that trigger is likely to fire
  for the first external organization, which may arrive before phase 5;
  the deployment-maturity gate below is where it is evaluated.
- **A thin machine client**, session-authenticated, sized from the phase-2
  implementation.
- **Caller identity is a person session, not an installation.**
- **Credentials live in the organization server's secret store** — the v2
  inventory unchanged, with one classification added: **credential
  ownership is a property of the source scope, not the adapter.** A tenant
  credential (Slack app, Zoom S2S, Teams app, Google delegation, Granola
  workspace key) is `organization`. A personal credential (Granola `grn_`)
  is `employee` and is not held server-side; see "Custody ledger."
- **Slack stays pull.** Unchanged.
- **The processing module runs as a named service principal** with declared
  read scope over the pre-record store; phase 0.4 governs it before phase 1
  creates it.

## Four fates, and the two tranches

| Fate | ~LOC | Meaning |
| --- | --- | --- |
| Retired (machine) | 17,000 | Ceases to exist. Ledger: [2026-08-16-machine-boundary-audit.md](2026-08-16-machine-boundary-audit.md). |
| Relocated (machine) | 14,600 | Same product, new address: core, decision-node, processors, Granola source, Slack surfaces, authorization stack, envelope building. |
| Retired (authority) | sized in phase 2 | Enrollment, access leases, internal-live rollout: 29 of 42 repository-port methods, 6 of 14 tables. Phase 4b. |
| Stays (machine) | sized in phase 2 | Act-and-read client plus session handling. |

The retired-machine 17,000 splits by what it costs to remove:

| Tranche | ~LOC | Composition | Removable by | Custody cost |
| --- | --- | --- | --- | --- |
| 1 — identity and operations | ~6,000 | audit rows: enrollment + machine PKI (2,624; the audit's item lines sum to 2,599), secret hardening (675), backup/restore (1,474). Judgment, not audit rows: the receipt-binding and signing share of the submission protocol (~500 of its 1,056), and the identity/ops commands' share of `cli.ts` — `backup`, `restore`, `organization enroll/status/refresh/rebind` (~900 of the ~2,600 the audit assigns to the 21 deleted commands) | moving trust and operations server-side; compute stays local (option D) | none |
| 2 — compute location | ~11,000 | everything else in the retired set: self-supervision and lifecycle (2,199), the self-update fleet (2,561 — option D keeps its updater, as v2 states), filesystem transactions (862), decision-node slot store (1,032), machine cycle storage (404), local config/diagnostics/founder fence (~850), `jsonl-outbox` (~680), the remaining submission transport (~550), and the remaining commands' share of `cli.ts` (~1,700) | moving processing server-side (option B) | `AD-05`, `AD-06`, valve observability, offline capture, blast radius |

Tranche 1 sums to about 6,200 and tranche 2 to about 10,800 — rounded to the
plan's ±10% that is the **~6,000 and ~11,000** used everywhere else in this
document. Both are judgment at the same ±10% as the audit, and the two
judgment items in tranche 1 are labelled as such because no audit row
measures them. The point is the shape, not the decimals: B's marginal
deletion over D is tranche 2, and tranche 2 is what carries the custody cost.

## Identity and signing

Unchanged from v2: the organization's authority signs the record; per-actor
provenance comes from re-proved authorization evidence; idempotency re-keys
to organization scope with existing rows untouched; concentration is
compensated by off-host signed head checkpoints published before the last
machine retires its receipts; rung-1 wording and the caller model are
amended through the constitution's own process in phase 2. v3 adds one
criterion: the checkpoint cadence is **every 60 minutes or every 100
appended records, whichever comes first (proposed default)** — frequent
enough that a rollback loses at most one hour of a low-volume organization's
record, cheap enough to run on the pilot box.

## Custody ledger

What crosses which boundary, under option B, stated once so every phase's
criteria can point at it.

| Material | Today (machine, `structured-text`) | Today (machine, LLM processor) | Option B |
| --- | --- | --- | --- |
| Raw transcript / vendor payload | machine only | machine + provider | organization server + provider |
| Rejected candidate package | machine only | machine + provider | organization server (pre-record store) + provider |
| Approved `DecisionBrief` | organization record | organization record | organization record |
| Rejection act + ≤2 KiB reason | organization record | organization record | organization record |
| Member never-ingest list | machine; org has no trace | machine; org has no trace | organization server; **no application surface shows it, but the database operator can observe that an exclusion exists** |
| Provider credentials | machine (Slack, Granola, LLM) | machine | organization server secret store |
| Installation signing key | machine | machine | deleted; authority signs |

**Supersessions this ledger names:**

- `AD-06` — raw transcripts and vendor payloads reach the organization
  server, never ECHO. The registry's "Implemented at baseline" was true only
  in the `structured-text` column; the LLM-processor column already
  violated it. Bounded egress is restated as: transcripts reach only the
  organization-operated server and the organization's chosen model provider
  under the organization's own terms.
- `AD-05` — the rejected package no longer stays local; it stays in the
  organization's pre-record store under phase 0.4's retention and deletion
  rule, and is never projected, indexed, or searchable. Rejection withholds
  the atom; it does not withhold the bytes from the operator.

**The valve successor.** The landed valve has two properties: the member
controls it, and the organization has no trace of it. Option B keeps the
first (member-scoped, member-writable, consulted at pull time before content
exists in the pre-record store, editable from the thin client or web) and
cannot keep the second, because the exclusion is a row in a database the
organization operates. v3 compensates rather than pretends: **no application
route exposes the exclusion table to an administrator — no UI, report,
export, or query; the only application readers are the processing module's
service principal at pull time and the owning member. Two break-glass paths
remain: an explicit break-glass command, which **emits an `INV-10` audit
row**; and direct database access by whoever operates the box, for which
application-layer auditing cannot be guaranteed — whether it can be enforced
at the database layer is Open Question 6, not a settled control.** What the
operator can still see without break-glass is that the table exists and how
many rows it has; what was excluded is not shown anywhere. Under P2 the valve is also
reframed for the buyer:
it is the mechanism that keeps HR one-on-ones, interviews, works-council and
accommodation conversations, and privileged calls out of the record — a
compliance feature the security review will ask for, not a concession.

**Granola, per scope.** Notes are private by default and the vendor's own
admins cannot read them. A workspace API key reaches shared notes and spaces
granted API access; that credential is `organization` and may be held
server-side. A personal `grn_` key reaches the member's private notes; that
credential is `employee`, is **not** collected into the server store, and
the refusals table gains a row for it. Under P3 the practical effect is that
Granola contributes shared notes centrally and nothing else, which is
acceptable for a bridge source. If a customer's corpus lives predominantly
in private personal-notetaker accounts, P3 has fallen for that customer and
the ADR is re-opened for that segment, not silently worked around.

## Phases

**All phases below assume `ADR-0001` accepts option B.** If it selects
another option, phases 1–5 are void and rewritten; every phase is contingent
on that acceptance, and Phase 0 is the only phase this plan's acceptance
authorizes.

Ordering rule, unchanged: at no point may create-once semantics be absent,
and at no point are there two canonical writers to one organization's
record. Each phase states **entry** (what must be true to start), **work**,
**exit** (testable criteria, all of which must hold), **kill** (the
condition under which the phase stops and what state it returns to), and,
where one exists, a **hold** before the next phase. Numbers marked
**(proposed default)** are the author's proposals, not decided values; each
governs until the phase named in the appendix re-evaluates it.

### Phase 0 — decide (artifact: `ADR-0001`)

**Entry.** This plan is accepted as the basis for the ADR. v2 and the audit
remain in the tree.

**Work.**

Item numbers keep v2's positions where the audit cross-references them
(0.4 governance, 0.6 local-only mode).

1. Write `ADR-0001` with the minimum contents named above and P1–P4 as its
   inputs, each with its "if this falls" clause; status `proposed`; review
   under the decisions lifecycle.
2. Decide the Granola bridge: workspace key held server-side, personal key
   refused, per the custody ledger; rotate the exposed credential as the
   standing item.
3. Decide the member valve successor with both properties addressed as in
   the custody ledger, or record why the previously rejected
   org-administered model is now acceptable.
4. Draft the pre-record plane's governance: the processing module's service
   principal and its declared read scope; who else may read the pre-record
   transcript store (proposed: no human principal by default; break-glass
   is an audited administrator act); retention **30 days after a candidate
   reaches a terminal state — approved, rejected, or withdrawn (proposed
   default)**, then hard deletion; fixture-corpus disposal **within 7 days
   of phase-1 exit (proposed default)**. Draft the visibility floor:
   ingested content with no human visibility intent is `invisible`.
5. Disposition `feat/onboard-slice-1` (7 unpushed commits): push to preserve
   RFC-0001 and the record of why (this is a preservation push of existing
   commits, not new phase-1 code, so it does not cross the ADR-0001 gate);
   build no further slices.
6. Decide local-only mode (`jsonl-outbox`, ~680 LOC; dies with it).
7. Record the model-provider egress: which provider, under which enterprise
   terms, with training opt-out and retention stated. **Phase 3 entry
   requires those terms in writing (proposed default).**
8. Name the option-C trigger in the ADR as stated above.

**Exit.** All of:

- `ADR-0001` is `accepted` under the decisions lifecycle.
- The ADR names both supersessions and `AD-06`'s conditional baseline.
- The valve successor's two properties are each dispositioned.
- Pre-record governance is drafted with a retention number and a named
  service principal.
- The Granola bridge and the provider-egress terms are recorded.
- `feat/onboard-slice-1` is pushed or explicitly abandoned in writing.

**Kill.** If the ADR is `rejected`, or if review finds a premise false
before acceptance, **all of Phase 1+ is paused entirely** — not partially —
until `ADR-0001` is re-scored and re-accepted; no phase-1 work starts in the
meantime. Nothing has moved; there is nothing to roll back.

### Phase 1 — processing module, validated by replay

**Entry.** Phase 0 exit. Pre-record governance exists as a written policy
even though no store exists yet.

**Work.** Move `core/`, decision processors, the Granola adapter, and the
Slack surfaces into an authority-hosted module behind a `check:boundary`
seam. Decision-node slots become SQLite tables with create-once as unique
constraints. The pre-record store is created under phase 0.4's governance
from its first row. Validation is fixture replay with a synthetic resolver;
no second live Granola puller. The gate is instrumented from day one.

**Exit.** All of:

- Fixture corpus of **at least 30 real meeting batches spanning at least 3
  distinct meeting types (proposed default)** captured, with disposal date
  recorded.
- Replay parity: **100% identical `meetingProcessingKey` → `approval_id` →
  envelope `idempotency_key` chains (no exceptions), and at least 95%
  identical decision sets by canonical digest (proposed default)** against
  the machine pipeline on the same corpus. Each non-identical decision set
  is triaged; a divergence may be accepted only if it is attributed to
  model non-determinism and the two sets carry the same evidence spans. A
  divergence in the key chain, or a decision-set divergence with different
  evidence, is a defect, not an acceptable miss.
- The same job run twice concurrently yields exactly one card, over
  **100 trials (proposed default)**.
- A replayed reaction observation yields exactly one resolution.
- A deliberately stale projection returns a withdrawn item as invisible.
- The pre-record store enforces the retention rule in a test: a terminal
  candidate older than the retention window is gone; a non-terminal one is
  not.
- `check:boundary` refuses any import from the processing module into
  serving, facts, or authorization code, and vice versa.
- Gate instrumentation records accept / edit / reject with source and
  decision type for **100% of resolver decisions**, and the instrument is
  wired into the live approval path so that from phase 3 it records real
  human decisions, not only replayed synthetic ones. (Phase 1's synthetic
  resolver produces no human-capacity signal; the reviewer-capacity metric
  begins accruing only once real reviewers act, at phase 3.)

**Kill.** If the key chain diverges at all, if decision-set parity below 95%
cannot be attributed to model non-determinism after triage, if **any**
decision-set divergence carries different evidence spans (regardless of
overall parity %), or if create-once cannot be proved under concurrency,
stop. The machine pipeline remains the only writer; the module is not wired
to a live source. State returned to: phase 0 exit.

**Hold.** Phase 2 may begin its design work in parallel once the module's
contracts are stable, since it touches identity rather than processing; but
phase 2 does not *exit* until phase 1 has exited, because its exit criteria
reference the live module. "Phase 1 exit" is therefore always a defined
state before any phase-2 kill can return to it.

### Phase 2 — person sessions

**Entry.** Phase 1's module contracts are stable enough that the caller
model can be designed against them.

**Work.** Choose the sign-in mechanism (self-hosted email/passkey vs
external IdP) as an ADR-level choice. Build a durable session store with
issuance, expiry, refresh, revocation. Session→principal resolution feeds
the authorizer; caller-binding preimage v2 with a stated meaning-migration
for already-written audit rows. The Slack identity link becomes a web flow.
The member valve ships. Thin client v0 ships. Draft the rung-1 and
service-principal constitution amendments. Size phase 4b.

**Exit.** All of:

- Sign-in mechanism decided in a recorded ADR.
- Session lifetime **12 hours absolute, refresh not beyond 7 days without
  re-authentication (proposed default)**; revocation takes effect on the
  next request, proved by test.
- Person state is re-resolved on every read; **every read path has a
  negative test proving self-only (caller ≠ subject denies)** — 100%, no
  exceptions.
- The session store is the only credential-shaped state on the machine, its
  location and mode are stated, and the phase-4 CI carve-out names it
  exactly.
- The member valve is live: a member can add and remove an exclusion from
  the thin client or web; an excluded source produces no pre-record row; no
  application route (admin UI, report, export, or query) returns exclusion
  contents, proved by a test that exercises each admin surface and asserts
  absence; and a break-glass read emits an `INV-10` audit row, proved by
  test.
- The Slack identity link completes end to end as a web flow with no local
  Slack credential.
- Thin client LOC measured and recorded; "stays" fate re-estimated from it.
- Constitution amendments drafted and submitted to the constitution's
  review process.
- Phase 4b sized: table-by-table replacement named.

**Kill.** If no sign-in mechanism satisfies P2's security-review shape
(SSO-capable, revocable, auditable), stop before the machine identity is
touched. Machines keep their installation keys; nothing is deleted. State
returned to: phase 1 exit.

### Phase 3 — cutover as a gated drain

**Entry.** All of: phase 1 exit; phase 2 exit; provider enterprise terms
from phase 0.7 in writing; off-host checkpoint publishing **live and
verified for at least 7 consecutive days (proposed default)**; the
trust-store step rehearsed (`rebind` exercised against the pilot host).

**Work.** Per machine, two steps with a gate between. (1) The daemon keeps
polling with its original credential until an operator command reports zero
pending cards and `record-flush` reports zero unsubmitted records. Before
starting, an admin pre-issues a re-enrollment grant for the machine — the
rollback path — **single-use, delivered over the same independent channel
as the original pin, valid for 14 days from drain start (proposed
default)**, and nothing is revoked until the machine is confirmed retired.
The grant deliberately outlives the drain: its purpose is to re-admit the
machine if a problem surfaces *after* step 2 retires the keys, so its window
covers the drain plus a post-retirement rollback window, not the drain
alone. (2) Only after step 1 reports zero/zero: stop, uninstall, retire
keys; the machine's Slack and Granola credentials move into the server
store, rotated after drain, never before.

Hosting during the pilot is named: the existing organization-operated box,
one container, Caddy, tunnel, founder as org admin, best-effort uptime,
founder on call. After this phase the founder's daily loop depends on that
box; that is accepted here.

**Exit.** All of:

- Every enrolled machine has drained (zero pending, zero unsubmitted) and
  retired, or is explicitly held back with a reason and a date; **at most
  one machine may be held back at phase-3 exit (proposed default)**, and a
  held-back machine still polls with its original credential and is not
  counted as retired.
- No retired machine holds a Slack, Granola, or LLM credential. The proof
  is direct: on each retired machine the credential files are gone from
  disk (the paths `secure-local-files.ts` used no longer exist) and the
  server secret store now holds those credentials. `credentials.ts` itself
  is not deleted until phase 4; phase 3 proves absence of the files, not
  absence of the code.
- Every re-enrollment grant is accounted for: consumed by a rollback, or
  live with a recorded expiry date. (A 14-day grant issued at the last
  machine's drain may still be live at phase-3 exit; "none live" is a
  phase-4 entry condition, below, not a phase-3 exit condition.)
- The server writer is the sole canonical writer; the record head has
  advanced only through it since the last drain.
- Every active member's daily loop — capture, approve, read — runs through
  the server for **at least 3 consecutive days on which that member was
  active (proposed default)** before the hold clock starts. "Active day"
  means the member performed at least one act or read; this avoids
  depending on an undefined organization-wide "working day."

**Kill.** During any single machine's drain: if pending cards cannot reach
zero within **7 days of drain start (proposed default)** — comfortably
inside the grant's 14-day window — the grant is consumed to re-enroll, the
machine resumes as before, and the drain for that machine is re-planned.
Across the fleet: if two machines in a row cannot drain for the same cause,
the phase stops. State returned to: phase 2 exit, all machines enrolled.

**Hold — before phase 4.** The window measures the regime it protects: the
clock starts only after the last machine has retired and every member's
loop is on the server. Then **14 consecutive days (proposed default)** with
all of: zero unavailability incidents longer than **15 minutes during the
organization's configured working-hours window (proposed default)**; **at least 50
candidates processed through the server pipeline (proposed default)**, so
the hold has seen real load and not an idle box; approval-queue p95 age
**≤ 72 hours (proposed default)** — the first reviewer-capacity checkpoint,
reported even though phase 5 is far off. Any unavailability incident longer
than 15 minutes in working hours resets the clock; three resets for the
same cause is a phase-3 kill.

### Phase 4 — deletion and enforcement

**Entry.** Phase 3 hold satisfied, and no re-enrollment grant is live (all
consumed or expired). Code deletion proceeds regardless of any held-back
machine: a held-back machine keeps running the old binary it already has
installed and is simply not upgraded until it retires — the source deletion
here removes the code from the repository, not from that running instance.

**Work.** 4a: delete the machine-side retired set (~17,000 LOC, 21
commands), porting the submission failure taxonomy onto the in-process
processing→record path **before** deleting the transport that taught it.
4b: delete enrollment, access-lease, and internal-live subsystems after the
`enrollment_id → principal/session` re-keying. CI: the thin client becomes a
real workspace package; signing/lock/SQLite bans are manifest edits; the
`fs` read-vs-write distinction is a small `check:boundary` enhancement.
Registry re-baseline. Remove `federation-protocol` if the protocol split
allows.

**Exit.** All of:

- Failure taxonomy ported and covered by tests on the in-process path
  before the transport is deleted (proved by the commit order).
- Machine-side retired set removed; the packed artifact contains no
  lifecycle, update, backup, enrollment, PKI, secret-hardening, filesystem-
  transaction, or submission-transport module (`check:boundary` allowlist
  is the proof).
- `check:boundary` refuses signing, lock, and SQLite imports in the thin
  client, with the phase-2 session store as the sole named carve-out.
- 4b complete: no table binds `enrollment ≡ installation`; every replaced
  table's meaning-migration is recorded.
- Registry re-baselined: `AD-05` and `AD-06` marked superseded by
  `ADR-0001`; every `QUAL-*`/`EVID-*` row that proved retired behavior is
  marked as historical.
- Machine `doctor`'s twelve checks each dispositioned: survives as a service
  health check, or retired with the reason.

**Kill.** If any deletion leaves the suite red (`npm run check` fails) and
the same change does not restore it green, revert that deletion; the plan
does not carry a half-deleted module across a hold. State returned to: the
last green commit of phase 4.

### Phase 5 — central-auth ingestion (three gates)

**Entry.** Phase 4 exit **and** all three gates:

1. **Visibility floor landed:** ingested-but-unreleased content is
   `invisible` by default, proved by a test that a released item is
   readable and an unreleased one is neither discoverable nor readable.
2. **Pre-record governance landed** as code: service principal, declared
   read scope, retention enforcement, and break-glass audit.
3. **Measured reviewer capacity** from real human decisions since phase 3
   (the synthetic resolver of phase 1 contributes none): over the trailing
   **30 days (proposed default)**, approval-queue p95 age **≤ 48 hours
   (proposed default)** and edit-plus-reject rate **≥ 15% of resolved
   candidates (proposed default)** — the floor below which the gate is
   presumed to be rubber-stamping. This gate cannot be evaluated until at
   least 30 days of real reviewer activity exist; widening ingestion before
   then, or while either bound is violated, is refused.

**Work.** Order: Zoom server-to-server → Teams → Google. A human release
remains simultaneously the record write and the visibility grant. Manual
entry stays first-class. Each source is a typed capability under the
core-and-adapters extension rule with its own adapter-matrix run.

**Exit.** Per source: the adapter matrix passes; the source's tenant
credential is `organization` in the secret store; its per-scope reach is
documented in the custody ledger; reviewer-capacity bounds still hold after
**30 days at the widened volume (proposed default)**.

**Kill.** If either reviewer-capacity bound is breached for **7 consecutive
days (proposed default)** after a source is added, that source's ingestion
is paused (not deleted) until the bound recovers or the gate is
re-designed. State returned to: the previous source set.

### Deployment-maturity gate — before the first external organization

Not a numbered phase; a gate that P2 makes real. It has the same
entry/exit/kill shape as the phases so it can be tracked like one.

**Entry.** A prospective organization that is not the founder's own is about
to operate the authority (a signed intent, not merely a conversation).

**Exit.** All of:

- Backup **RPO ≤ 24 hours, RTO ≤ 4 hours (proposed default)**, with one full
  restore rehearsed against the reviewed image **within the prior 90 days
  (proposed default)**.
- Off-host checkpoint verified against the live head **at least once every
  24 hours (proposed default)**, with the last verification timestamp
  visible to the operator.
- A written upgrade procedure exists and its rollback has been exercised at
  least once against the reviewed image.
- Multi-replica availability is either delivered, or explicitly declined in
  the buyer's contract. If the buyer requires it, this gate does not pass on
  that clause alone: the Postgres/extraction trigger has fired and its scope
  is opened as its own phase, which must complete first.

**Kill.** If the gate cannot pass for the same cause on two separate
attempts, stop onboarding that organization on option B and open the
option-C ADR (this is one of C's named triggers). State returned to: the
founder's own organization operating alone.

## Invariants that must survive, keyed to the registry

`INV-01` through `INV-10` and `AD-01`–`AD-08` remain binding through the
migration, with **two supersessions**, both by `ADR-0001`:

- **`AD-06`** — raw custody member→organization server; ECHO never; member
  valve compensates; bounded egress restated to include the organization's
  chosen provider under its own terms; baseline status corrected as
  conditional on processor choice.
- **`AD-05`** — the rejected package stays in the organization's pre-record
  store under retention and never becomes an atom, projection, or search
  candidate.

Every other `AD-*` retains its status. `INV-01`–`INV-10` are unchanged and
apply to every new read path this plan creates, including the pre-record
plane and the exclusion table.

Migration-specific invariants, carried from v2 with one added:

1. Create-once, never reinterpret.
2. One serial append stream per organization.
3. Idempotency by content, not by attempt.
4. Fail closed on projection lag (`INV-06`).
5. Self-only reads, enforced server-side per request.
6. Human release creates the policy fact from which visibility is derived
   at query time — never a reader list (`INV-02`, `INV-09`).
7. Recovery depends on no provider's uptime; restore reconciliation uses
   off-host checkpoints.
8. The machine is never durable and never a principal; the one carve-out is
   the phase-2 session store.
9. **Credential ownership follows source scope, not adapter.** A credential
   is held server-side only if the account it authenticates is the
   organization's; a personal-account credential is never collected
   centrally, even when the same vendor also issues tenant credentials.

## What gets harder — accepted, not hidden

- **The permission brain grows.** One org credential reaches everything;
  authorization must scope reads and publication targets, not just actions.
- **The organization's server becomes load-bearing for daily use.** Outages
  stop everyone; offline is surrendered at phase 3, on purpose. Under P2
  the buyer's security review will price this, which is why the
  deployment-maturity gate exists.
- **Reviewer load is the wedge's own failure mode**, and under P2 it is the
  central product risk: org-tenant ingestion multiplies candidates against
  a fixed human gate. The instrument is built in phase 1, accrues real
  human data from phase 3, is reported at every hold from phase 3 on, and
  gates phase 5 quantitatively.
- **Signing concentrates.** Compensated by re-proved evidence and off-host
  checkpoints.
- **The valve is observable.** The organization can see that an exclusion
  exists even though it cannot see what was excluded; compensated by
  audit and by keeping the table off every administrator surface.
- **The provider becomes a custody party** for every option except
  A-with-`structured-text`. This was already true for any LLM-processor
  configuration; v3 makes it a stated premise with contractual terms as a
  phase-3 entry condition.
- **The pressure after B points toward C, not back toward D.** Executive
  buyers want SaaS. The trigger is named so the decision is deliberate.

## How the 17,000 lines grow back, and the refusals

| Pressure | Refusal |
| --- | --- |
| "It should work offline" | No local queue, ever. The durable source is the queue. |
| "Cache it locally for speed" | Only if delete-and-refetch is always correct and nothing reads it when the server is down. |
| "This user needs their own key" | Server holds tenant credentials; short-lived scoped tokens only. |
| "Just collect the personal Granola keys server-side" | No. A personal-account credential is `employee` scope and is never held centrally; the vendor's own admins cannot read those notes and ECHO does not build that path. |
| "We can't send transcripts to your cloud" | Already answered by option B: they reach the organization's own server and its chosen provider under its terms; ECHO holds nothing. C is a separate ADR with a named trigger. |
| "Prove it came from a managed device" | Device attestation is the installation signer reborn. If ever accepted, budgeted as a feature. |
| "Approvals should be instant — add a webhook" | Pull until a measured latency need; push lands only with signature verification and replay protection. |
| "Let admins see what employees excluded" | No. The exclusion table is off every administrator surface; a break-glass read is an audited act, and its existence is a security-review answer, not a reporting feature. |
| Anything resident on the machine | Event-driven and short-lived, or crash-only. |

## Out of scope for v3

- Postgres and service extraction (deferred behind v2's triggers plus the
  security-review trigger above).
- ECHO-hosted operation (option C — its own ADR, trigger named here).
- Push delivery for Slack events.
- The machine-side capture feeder for agent transcripts and unpushed git.
- On-prem packaging beyond option B's shape, device attestation, offline
  mode, local caches, any federation revival.
- An on-device model. If one becomes viable, P1 falls and the tranche
  arithmetic is re-run; nothing in phases 0–5 anticipates it.

## Open questions

1. Sign-in mechanism for person sessions — phase 2's first decision.
2. Provider enterprise terms: which provider, and whether zero-retention is
   contractually available at the pilot's scale (phase 0.7).
3. Whether the Granola workspace key's "spaces granted API access" can be
   set by an Enterprise admin without member action — a vendor question that
   decides how much of a bridge Granola is.
4. The exact constitution amendments for rung-1 wording and the service
   principal — phase 2.
5. Which of the twelve machine `doctor` checks survive as service health
   checks — phase 4.
6. Whether the exclusion table's audit-on-admin-read can be enforced at
   the database layer (trigger) or only at the application layer.

## Appendix — proposed defaults ledger

Every number introduced by this version, where it is used, why it was
chosen, and the phase that re-evaluates it. Change a number here and in the
phase text together.

| Default | Used in | Reasoning | Re-evaluated in |
| --- | --- | --- | --- |
| Checkpoint every 60 min or 100 records | Identity and signing | bounds rollback loss to one hour at pilot volume; trivial cost | Phase 3 entry |
| Pre-record retention 30 days after terminal | Phase 0.4, Phase 1 exit | long enough for reconsideration and dispute; short enough that the store is not an archive | Phase 5 gate 2 |
| Fixture-corpus disposal ≤ 7 days after phase-1 exit | Phase 0.4 | the corpus is real meetings held for testing; it has no purpose after parity | Phase 1 exit |
| Fixture corpus ≥ 30 batches, ≥ 3 meeting types | Phase 1 exit | enough variety to catch processor drift; small enough to triage by hand | Phase 1 |
| Replay parity: 100% key chain, ≥ 95% decision sets | Phase 1 exit | key chain must be exact for idempotency; decision sets tolerate model non-determinism | Phase 1 |
| Concurrency trials: 100 | Phase 1 exit | cheap; catches races that a handful of runs would miss | Phase 1 |
| Provider enterprise terms in writing | Phase 0.7, Phase 3 entry | egress to a third party should not be discovered mid-cutover | Phase 3 entry |
| Session 12 h absolute, ≤ 7 days refresh | Phase 2 exit | one working day; a week before re-authentication matches common enterprise SSO defaults | Phase 2 ADR |
| Checkpoint live ≥ 7 days before phase 3 | Phase 3 entry | proves the publisher, not just the code, before receipts are retired | Phase 3 |
| Re-enrollment grant 14 days, single-use, independent channel | Phase 3 work | must outlive the drain and a post-retirement rollback window, not just the drain | Phase 3 |
| Drain timeout 7 days (kill) | Phase 3 kill | comfortably inside the 14-day grant; beyond it the machine is re-planned, not left mid-drain | Phase 3 |
| At most 1 machine held back at phase-3 exit | Phase 3 exit | one straggler should not block the fleet, but a second means the drain design is wrong | Phase 3 |
| Per-member 3 active days on server before hold clock | Phase 3 exit | the hold must measure the post-cutover regime, not the pilot | Phase 3 |
| Hold: 14 days, zero incidents > 15 min in the configured working-hours window, ≥ 50 candidates | Phase 3 hold | v2's 14 days kept, but started after full cutover and made to require real load | Phase 3 |
| Queue p95 ≤ 72 h at phase-3 hold | Phase 3 hold | first reviewer-capacity checkpoint; deliberately looser than phase 5's | Phase 5 gate 3 |
| Reviewer gate: trailing 30 days of real reviewer activity, p95 ≤ 48 h, edit+reject ≥ 15% | Phase 5 entry | a two-day p95 keeps decisions fresh; a 15% intervention floor is the lowest rate at which the gate is plausibly still reading; 30 days because the signal only accrues from phase 3 | Phase 5, per source |
| Post-widening observation 30 days | Phase 5 exit | one reviewer cycle at the new volume | Phase 5, per source |
| Source pause after 7 days of breach | Phase 5 kill | long enough to be a trend, short enough that the backlog is recoverable | Phase 5 |
| RPO ≤ 24 h, RTO ≤ 4 h, restore rehearsed within 90 days | Deployment-maturity gate exit | daily tarball backup is what exists; four hours is a founder-operable target | First external organization |
| Off-host checkpoint verified ≤ every 24 h | Deployment-maturity gate exit | a checkpoint no one verifies is not a recovery artifact | First external organization |

Structural thresholds that are rules rather than tunable numbers — "two
machines in a row" (phase-3 kill), "three resets for the same cause"
(phase-3 hold), "two attempts for the same cause" (deployment gate / option-C
trigger) — are stated in the phase text and deliberately not in this ledger,
because changing them changes the rule, not a measurement.
