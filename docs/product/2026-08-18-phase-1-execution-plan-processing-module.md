# Phase 1 execution plan — processing module, validated by replay

**Status:** execution runbook for an autonomous agent (Claude Code in a
terminal), written 2026-08-17 for the work that follows
[ADR-0001](../decisions/ADR-0001-organization-operated-server-core.md)
(accepted) and implements Phase 1 of
[server-core migration plan v3](2026-08-17-server-core-migration-plan-v3.md).
It continues on the same branch the overnight spike produced, building on the
accepted ADR commit rather than re-deriving the relocate.

**Baseline for this run:** branch `migration/server-core-relocate-retire` at
its current HEAD (the ADR-0001 acceptance commit). The spike already relocated
seven units and retired two; this run finishes the four held relocate units,
stands the pipeline up as a runnable module inside the authority process, and
proves it by fixture replay. It does **not** start Phase 2 (person sessions),
Phase 3 (cutover), or any deletion beyond what the spike already did.

**What ADR-0001 fixed that this run depends on.** Read these as settled
inputs, not open questions:

- Phase 1 parity runs the **deterministic `structured-text` processor only**
  (ADR decision 6). No transcript reaches a model provider in this run. The
  LLM processor relocates as code but is not exercised for parity.
- The **pre-record store** is governed from its first row (ADR decision 5):
  one named service principal as sole application reader, 30-day retention
  after terminal state, fixture-corpus disposal within 7 days of exit.
- Granola is a **bridge source** and only the organization-owned key is ever
  held server-side (ADR decision 4). No live Granola pull happens in this
  run regardless; replay uses fixtures.

**Autonomy for this run:** best-effort on mechanical code and test fixes,
every judgment call logged to `.migration/DECISIONS.md`. The hard-stop rules
below override best-effort in all cases.

---

## Objective and shape

Turn the relocated code from a pile of moved files into a **runnable
processing module inside the authority process, proven equivalent to the
machine pipeline on a fixed corpus** — without ever pointing it at a live
source and without a second canonical writer to the record.

Two work bands, each a sequence of small independently-green commits:

```text
Band A  finish the four held relocate units          -> tag phase1/relocate-complete
Band B  stand up + fixture-replay the pipeline        -> tag phase1/replay-green
```

Progress is counted in **units and criteria met, not in reaching Band B.** A
run that finishes Band A cleanly and lands the replay harness is a good run
even if full parity needs a second pass.

---

## Hard-stop rules (override best-effort; never violate)

1. **Never touch `main`.** All work on `migration/server-core-relocate-retire`.
   No push, no merge to main, no rebase of main.
2. **No live, external, or credentialed call.** No Slack, Granola, LLM
   provider, or Authority network request; no real credential read or move;
   no `service`/daemon start. Replay uses fixtures and fakes only. A task that
   cannot proceed without a live call **stops** and is logged.
3. **No second canonical writer, ever.** The machine pipeline remains the only
   thing that can write a real record until cutover (Phase 3, not this run).
   The processing module runs only against the fixture corpus and a synthetic
   resolver. It is never wired to the live record-append path.
4. **The deterministic processor only for parity.** Do not invoke the LLM
   processor against any real or fixture transcript for a parity comparison
   (ADR decision 6). If a unit's tests require a model call, that is a live
   call — stop and log.
5. **Never commit a red tree — no subset-green.** Every commit on the
   migration branch leaves the full `npm run check` green. WIP goes on a
   `wip/<topic>` branch (rule 8), never as a red commit.
6. **Preserve the record's safety invariants.** Create-once slot semantics,
   the frozen-presentation contract, and the content-derived idempotency
   chain (`meetingProcessingKey -> approval_id = sha256(key) -> envelope
   idempotency_key`) are do-not-break. A change that would alter any of them
   stops and logs rather than working around it.
6b. **The pre-record store is born governed.** The first commit that creates
   any pre-record transcript/candidate storage must land its governance in the
   same commit: a single named service-principal reader, no human-readable
   application route, and the retention field on every row. A store that
   exists before its governance is a hard-stop violation, not a TODO.
7. **Tag before you build on.** `phase1/relocate-complete` must exist and be
   green before Band B changes pipeline wiring.
8. **When in doubt, checkpoint and continue elsewhere.** Create `wip/<topic>`
   off HEAD, commit there, `git switch` back. WIP branches are the sole
   exception to rule 5. Log the blocker; pick up the next independent unit.
   Halt entirely only if no independent unit remains.

---

## Environment and preconditions

Full local checkout, network, Node, git — Claude Code in a terminal, the same
host as the overnight run. The device-bridge/cloud environment cannot run
`npm ci` and is not valid here.

```sh
cd <repo-root>
git switch migration/server-core-relocate-retire
git log -1 --format='%H %s'   # MUST show the ADR-0001 acceptance commit as HEAD
git status --porcelain        # MUST be empty
node -v                       # MUST be v22.22.1 (npm on PATH: ~/.nvm/versions/node/v22.22.1/bin)
npm ci
npm run check                 # MUST be green before any change
```

If HEAD is not the ADR acceptance commit, or `npm run check` is not green,
stop and log — do not start on an unverified base. This is the operator's
outstanding item from the overnight handoff: **if you have not personally
re-run `npm run check` at `pre-migration/4665c3a`, `checkpoint/relocated`, and
`checkpoint/retired` since the spike, do that first** (overnight runbook,
Morning handoff step 3). Phase 1 builds on the spike's green claims; verify
them once before trusting them.

Continue the same `.migration/` tracking files (git-ignored): `STATUS.md`,
`DECISIONS.md`, `ROLLBACK.md`. Append; do not overwrite the overnight history.

---

## Rollback and checkpoints

- Branch isolation unchanged; `main` never moves; ultimate rollback is
  deleting the branch.
- New checkpoints this run, each a verified-green annotated tag:
  `phase1/relocate-complete`, `phase1/replay-green`.
- Restore commands (record in `ROLLBACK.md`):

```sh
git reset --hard phase1/relocate-complete   # undo Band B, keep the finished relocate
git reset --hard checkpoint/retired         # back to the overnight end state
git reset --hard checkpoint/relocated       # back to relocated-but-not-retired
```

Every stage tag is a commit at which the full `npm run check` was observed
green from a clean rebuild (`npm run clean && npm run clean:workspaces` then
`npm run check`) — the spike proved `git mv` preserves mtimes and lets
incremental `tsc` report stale-dist false greens, so a clean rebuild before
each tag observation is mandatory.

---

## Band A — finish the four held relocate units

The overnight run held four units with named living-importer proofs
(DECISIONS.md, units 5–6). All four are non-leaf: they stayed because
something that survives still imports them. Finishing them is what makes the
processing module self-contained enough to run. Attempt in this order
(least-entangled first):

1. **`protocol-record-envelope-builder.ts`** — held because it imports
   `record/ports.ts`, the submission-transport contract. It relocates only
   together with the envelope-building half of that contract. Move the
   envelope-builder and the *type/shape* it needs into
   `services/organization-authority/src/processing/`, leaving the
   submission-transport *transport* (`record-submitter.ts`,
   `http-organization-record-client.ts`) untouched on the machine — the
   transport is not retirable until Phase 4a and must not fork the
   idempotency-chain type identity (overnight unit-5 ruling). If the only way
   to move the builder is to fork `record/ports.ts` and split that type
   identity, **stop and log** — that is the invariant risk the spike refused.
2. **`store-backed-approval-gate.ts`** — held because `decision-node-store.ts`
   stays (it is in the retired-at-cutover set, not this run). The gate is the
   `ApprovalGate` the core cycle takes as a dependency
   (`CoreCycleDependencies.approvalGate`). Relocate the gate behind the
   processing seam; the store it binds to may stay where it is and be injected,
   since create-once slot semantics (rule 6) live in the store and must not
   move casually.
3. **`approval-action-authorizer.ts`** — held on three staying deps
   (installation-signer, authority-client, org state). These are identity and
   transport that Phase 2 relocates. Move only what imports processing-core
   types; if the authorizer cannot compile without reaching machine identity
   code, it is a Phase-2 unit — **stop, log, and leave it held.** Do not drag
   identity code across tonight.
4. **`runtime-access-controller.ts`** — held on org composition. Same rule as
   3: relocate only if it detaches from machine composition cleanly; otherwise
   confirm it as a Phase-2 unit and leave held.

Units 3 and 4 are expected to be **partially or wholly Phase-2 work** — they
touch the identity boundary Phase 2 owns. Finishing 1 and 2 is the real Band A
goal; 3 and 4 landing is a bonus, and leaving them held with a refreshed proof
is a valid, logged outcome, not a failure.

**Per-unit method** (identical discipline to the overnight relocate):

```text
for each unit (from a green HEAD):
  move files; rewrite imports; update the boundary manifest (processing/-scoped rules only)
  npm run check:boundary            # seam holds; no forbidden widening
  npm run clean:workspaces && npm run build:workspaces   # no stale-dist false green
  npm run typecheck
  npm run check                     # full gate — authoritative
  if green: git commit -m "relocate: <unit> (phase 1 band A)"   (tests move WITH code)
  if red + mechanically fixable: fix, re-run npm run check, commit when green
  if red + not mechanical, or it needs identity/transport code: git reset --hard HEAD;
     log "held: <unit> is Phase-2 (reaches <machine dep>)"; next unit
```

**Boundary rule reminder** (from the spike): the checker rejects overlapping
`source_root`s, so use processing/-scoped **layer rules** in the authority
manifest, not a nested sub-manifest. Adding a rule scoped to `processing/` is
allowed; any entry that lets `processing/` import machine identity/transport
code, or lets machine code import `processing/`, is a forbidden widening —
stop and log.

**Band A exit / tag.** Units 1 and 2 landed green (or explicitly held with a
refreshed living-importer proof and a stated Phase-2 reason); units 3 and 4
landed or held-with-proof. Clean-rebuild `npm run check` green. Tag:

```sh
git tag -a phase1/relocate-complete -m "Held relocate units resolved or confirmed Phase-2; npm run check green (clean rebuild)"
```

Record in `STATUS.md` which units landed and which are confirmed Phase-2, each
with its proof.

---

## Band B — stand up and fixture-replay the pipeline

Enter only with `phase1/relocate-complete` green. This band adds a **new
authority-hosted entry point** that runs `runCoreCycle` against fixtures with
a synthetic resolver, and a harness that compares its output to the machine
pipeline on the same corpus. No production wiring changes; the machine
pipeline stays the only real writer (rule 3).

### B1 — capture the fixture corpus

- Build a corpus of **at least 30 real meeting batches spanning at least 3
  distinct meeting types (proposed default)** as static fixtures — canonical
  `MeetingDocument` JSON, not a live pull. If real meeting data is not
  available without a live Granola call (rule 2), synthesize representative
  fixtures from the existing test corpus and **log that the corpus is
  synthetic** — a synthetic corpus still proves pipeline equivalence, it just
  does not prove real-provider canonicalization (that is Phase 3).
- Record the corpus location and its **disposal date: within 7 days of Band B
  exit (ADR decision 5).** The corpus is real-shaped meeting content; it is
  governed pre-record data, not a permanent test asset.

### B2 — the synthetic resolver and the run harness

- Implement a **synthetic `ApprovalGate`** that supplies a deterministic
  approve/reject per candidate from a fixture manifest — replacing the human
  Slack step, not the decision processor. It never calls Slack (rule 2).
- Implement a **`CoreStateStore` for the harness**: either the existing SQLite
  store pointed at a scratch DB, or an in-memory implementation of the port
  (`getSourceCursor/hasProcessed/saveMeeting/getDecisionSet/saveApproval/
  markProcessed/...`). Scratch state only; it is disposable with the corpus.
- Wire an authority-hosted entry point that runs `runCoreCycle` with:
  meeting source = a fixture reader; decision processor = **`structured-text`
  only** (rule 4); delivery surface = an in-memory capture; approvalGate =
  the synthetic resolver; state = the harness store.
- **If this entry point creates any durable pre-record storage, rule 6b
  applies:** governance lands in the same commit.

### B3 — the parity comparison

Run the same corpus through the machine pipeline and the processing module,
compare, and assert:

- **Key chain: 100% identical, no exceptions** —
  `meetingProcessingKey -> approval_id = sha256(key) -> envelope
  idempotency_key` byte-for-byte across the corpus.
- **Decision sets: ≥95% identical by canonical digest (proposed default).**
  With the deterministic processor a divergence is *not* attributable to model
  non-determinism, so under ADR decision 6 the honest target here is **100%
  identical decision sets** — the deterministic processor should produce
  identical output given identical input. Any divergence is a defect to fix or
  a fixture bug to correct, not an accepted miss. (The 95%/model-nondeterminism
  allowance in v3 exists for the future LLM parity run, not this deterministic
  one.)
- **Create-once under concurrency:** the same job run twice concurrently
  yields exactly one card, over **100 trials (proposed default)**.
- **Replayed resolution:** a replayed reaction/approval observation yields
  exactly one resolution.
- **Frozen presentation:** a re-run with changed content creates a new node;
  it never reinterprets a posted card.

### B4 — instrument the gate (build only; no live data yet)

Add the accept/edit/reject instrument to the approval path so it is ready to
record **real** human decisions from Phase 3. In this run it records only
synthetic-resolver decisions and therefore produces **no reviewer-capacity
signal** (ADR/v3: the metric accrues from Phase 3). Build it, test it against
the synthetic corpus, and state in `STATUS.md` that its Phase-1 output is not
a capacity measurement.

**Band B exit / tag.**

```sh
git tag -a phase1/replay-green -m "Processing module fixture-replay parity green (deterministic processor); npm run check green (clean rebuild)"
```

Record the parity result verbatim in `STATUS.md`: corpus size and whether it
is real or synthetic, key-chain result, decision-set result, concurrency and
resolution results, and the disposal date set for the corpus.

---

## Kill and hold

- **Band A kill:** if unit 1 can only move by forking the idempotency-chain
  type identity, or a unit needs machine identity/transport code, stop that
  unit, revert it (`git reset --hard HEAD`), log it as Phase-2, continue with
  the next. Halting the whole band happens only if no unit can proceed.
- **Band B kill:** if key-chain parity is not 100%, or create-once cannot be
  proved under concurrency, stop and log — do not tag `phase1/replay-green`.
  The machine pipeline remains the only writer; nothing is wired live. State
  returned to: `phase1/relocate-complete`.
- **No hold into Phase 2/3 from here.** Phase 1 exit is a stopping point for
  operator review; person sessions, cutover, and deletion are separate
  authorized work.

---

## Definition of done (partial completion is success)

The run is a success if all hold, regardless of how far Band B reached:

- `main` untouched; work on the isolated branch; nothing pushed; nothing
  live/external/credentialed touched; no second canonical writer created.
- Every commit green under the full `npm run check` (WIP only on `wip/*`).
- Band A: units 1–2 landed or explicitly held-with-proof as Phase-2; units
  3–4 landed or held-with-proof; `phase1/relocate-complete` tagged green.
- Any pre-record storage created is governed in the same commit (rule 6b).
- If Band B ran: a replay harness exists, the corpus disposal date is
  recorded, and the parity result is in `STATUS.md`; if parity is green,
  `phase1/replay-green` is tagged.
- `.migration/STATUS.md`, `DECISIONS.md`, `ROLLBACK.md` current, with a
  HANDOFF section naming the single most important thing for the operator to
  check first — expected to be either the parity result or, if Band A held
  units 3–4, the confirmed scope of Phase-2 identity work.

---

## Explicitly out of scope (Phase 2+ — do not start)

- Person sessions, sign-in, session store, web identity-link flow, the member
  valve UI (Phase 2).
- Relocating machine identity/transport code: installation-signer,
  authority-client, enrollment, org state (Phase 2; units 3–4 leave these on
  the machine).
- Any cutover, drain, credential move, key retirement (Phase 3).
- Deleting the submission transport or any Phase-4 retirement.
- The LLM processor parity path and any model-provider call (deferred to
  Phase 3 entry by ADR decision 6).
- Removing the machine -> authority package dependency the spike introduced
  (that resolves in Phase 2 when the machine stops consuming processing).
