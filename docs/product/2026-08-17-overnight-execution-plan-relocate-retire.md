# Overnight execution plan — relocate then retire

**Status:** execution runbook for an autonomous agent (Claude Code in a
terminal), written 2026-08-17 against `main` at `4665c3a`. It operationalizes
the first mechanical half of
[2026-08-17-server-core-migration-plan-v3.md](2026-08-17-server-core-migration-plan-v3.md):
v3 Phase 1 (relocate) and the reversible part of v3 Phase 4a (retire),
executed on an isolated branch as a reviewable spike. It deliberately stops
before v3 Phase 2 (person sessions) and all of v3 Phase 3 (cutover, drain,
credential moves, key retirement).

**What this run is, and is not.** It is a branch-isolated, test-gated code
motion: move the "relocated" set into an authority-hosted module, then delete
the "retired" set only where deletion keeps the suite green. It is **not** a
cutover and **not** a ratification. Nothing live, external, or credentialed
is touched. Merging to `main` stays gated on `ADR-0001` and the operator's
morning verification. The value of a partial run is real: whatever lands is
green and reversible.

**Operator handoff.** The operator (Zhen) reviews in the morning, does the
live runs this plan is forbidden from doing, and accepts or rolls back each
stage. Section "Morning handoff" is written for them.

**Autonomy setting for this run:** best-effort on mechanical code and test
fixes, with every judgment call logged. This setting **does not** relax the
hard-stop rules below — those override best-effort in all cases.

---

## Objective and shape

Three stages, each ending at a git tag that is a verified rollback point:

```text
Stage 0  safety foundation      -> tag pre-migration/4665c3a
Stage A  relocate to server     -> tag checkpoint/relocated
Stage B  retire dead + moved     -> tag checkpoint/retired
```

The tag between A and B is the point of the exercise: in the morning the
operator can roll back to `checkpoint/relocated` and run the old machine
pipeline and the new server-hosted module side by side, then keep the retire
only if satisfied.

Progress is measured in **small, independently green commits**, not in
reaching Stage B. A night that lands half of Stage A, all green and all
reversible, is a good night.

---

## Hard-stop rules (override best-effort; never violate)

1. **Never touch `main`.** All work happens on the migration branch created
   in preconditions off `4665c3a`. Do not push. Do not merge. Do not rebase
   or fast-forward `main`.
2. **Never make a live, external, or credentialed call.** No Slack, Granola,
   LLM provider, or Authority network request; no reading or moving any real
   credential; no `service`/daemon start; no cutover, drain, or key
   retirement. All provider and Authority interaction in tests uses the
   existing fakes/fixtures only. If a task cannot proceed without a live
   call, that task **stops** and is logged for the morning.
3. **Never commit a red tree — no exceptions, no subset-green commits.**
   Every commit on the migration branch must leave the **full** `npm run
   check` green. There is no "documented subset" escape. If a unit cannot be
   made fully green by mechanical means, revert that unit (see the exact
   revert commands in each stage), log it, and move to the next independent
   unit. Never commit red to "save progress" — use a `wip/*` branch for that
   (rule 7).
4. **Deletion is test-driven, never speculative.** A file is deleted only if
   the suite stays green without it (see Stage B algorithm). If removing it
   turns the tree red, revert the removal and log "cannot retire yet:
   depended on by X."
5. **Preserve the record's safety invariants** (listed under Stage A). If a
   move would break create-once, the frozen-presentation contract, or
   content-derived idempotency, stop and log rather than work around it.
6. **Tag before you delete.** `checkpoint/relocated` must exist and be a
   verified green rollback point before Stage B removes anything.
7. **When in doubt, checkpoint and continue elsewhere.** Create a branch
   `wip/<unit-name>` off the current `HEAD`, commit the incomplete work there,
   then `git switch` back to `migration/server-core-relocate-retire`. WIP
   commits on `wip/*` branches are the **one** exception to the green-commit
   rule (rule 3). Write the blocker to `.migration/STATUS.md` and pick up the
   next independent unit. Halt entirely only if no independent unit remains.

---

## Environment and preconditions

Run in a full local checkout with network, Node, and git — Claude Code in a
terminal. The device-bridge/cloud environment cannot run `npm ci` and is not
a valid host for this run.

Establish the baseline before any change. **This is the first gate; if it
fails, do nothing else and wait for the morning.**

```sh
cd <repo-root>
git fetch origin
git status --porcelain     # MUST be empty; if not, stop
git rev-parse 4665c3a      # MUST resolve; this exact commit is THE baseline
node -v                    # MUST be v22.22.x; a mismatch is a STOP, not a note
npm ci
git switch -c migration/server-core-relocate-retire 4665c3a   # branch from the pinned baseline
npm run check              # baseline MUST be green
```

**The baseline is exactly `4665c3a`** — the commit the boundary audit's LOC
counts were measured against. Branch from that sha, never from `main`; if
`main` has advanced, ignore it. This run never executes `git pull`, `git
merge`, or `git push`, and never modifies `main` (rule 1).

If `npm run check` is not green at `4665c3a`, the whole test-gating model is
void: write the failure to `.migration/STATUS.md`, make no changes, stop.
Record the baseline in `STATUS.md`: the sha `4665c3a`, node version, and the
wall time `npm run check` took (you will run it many times).

---

## Rollback and checkpoint design

- **Isolation:** a dedicated branch off the baseline commit `4665c3a`; `main`
  is never modified, so the ultimate rollback is "delete the branch."
- **Checkpoints:** an annotated tag at the end of each stage. Tags are the
  named rollback points and are listed in `ROLLBACK.md` (write it in Stage 0).
- **Restore commands** (record these verbatim in `ROLLBACK.md`):

```sh
# discard everything, keep the branch history for review:
git reset --hard checkpoint/relocated     # back to relocated-but-not-retired
git reset --hard pre-migration/4665c3a # back to the untouched start
# abandon the whole run entirely:
git switch main && git branch -D migration/server-core-relocate-retire
```

- **Verify rollback actually works** in Stage 0 (below), before trusting it.
- Every stage tag must be a commit at which `npm run check` was observed
  green; note the observation in the tag's annotation message.

---

## Stage 0 — safety foundation

The migration branch already exists (created in preconditions). Exact
sequence:

```sh
git tag -a pre-migration/4665c3a -m "Untouched baseline; npm run check green at 4665c3a"

# Prove the rollback point restores a green tree:
echo "// rollback probe" >> README.md
git add -A && git commit -m "probe: temporary change to test rollback"
git reset --hard pre-migration/4665c3a
git status --porcelain      # MUST be empty
npm run check               # MUST be green again
```

Then create a **git-ignored** `.migration/` directory at the repo root and
add the line `.migration/` to `.gitignore` (commit only that one-line
`.gitignore` change). These tracking files are **never committed**, so they
never reach `check:docs` and may safely contain absolute paths and free-form
logs — which is why they must not be tracked:

- `.migration/STATUS.md` — living log (format below).
- `.migration/ROLLBACK.md` — the tags and the restore commands above.
- `.migration/DECISIONS.md` — every best-effort judgment call, one per line,
  with the commit sha it lands in.

Stage 0 exit: the branch exists off `4665c3a`; `pre-migration/4665c3a` exists;
rollback was exercised and returned a green tree; `.gitignore` ignores
`.migration/`; the three tracking files exist (untracked). Commit only the
`.gitignore` change. `pre-migration/4665c3a` is Stage 0's checkpoint; do
**not** tag Stage 0 separately.

---

## Stage A — relocate to the server core

**Goal.** Move the "relocated" set (~14,600 LOC per the boundary audit) into
a module hosted by the `organization-authority` workspace, behind a
`check:boundary`-enforced seam, keeping every commit green. This is code
motion plus import/manifest rewrites — **not** behavioral rewiring. Live
credential wiring, person-session identity, the pre-record store, the
submission failure-taxonomy port (see Stage B), and fixture-replay behavioral
parity are explicitly **out of scope tonight** (they are v3 Phase 2 and the
operator's morning work).

**Source of truth for what moves.** The RELOCATED section of
[2026-08-16-machine-boundary-audit.md](2026-08-16-machine-boundary-audit.md).
The move set, in dependency order (lowest risk first):

1. `src/core/**` — contracts and the four-stage cycle. Already
   tool-agnostic (the boundary rule `core-is-tool-agnostic` allows only
   `src/core/**` imports), so this should move with the fewest import edits.
2. `src/adapters/decision-processors/**` — LLM processor, the four provider
   clients, `structured-text` fallback.
3. `src/adapters/meeting-sources/granola/**` — the HTTPS client; moves as
   code, is not invoked live tonight.
4. `src/adapters/shared/slack/**` and the Slack surfaces
   (`approval-surfaces/slack-reactions`, `delivery-surfaces/slack`) —
   **highest risk.** The frozen-presentation contract must be preserved; do
   not change card rendering or resolution semantics while moving.
5. `src/product/approval/decision-node.ts` and the envelope builder
   (`record/adapters/protocol-record-envelope-builder.ts`) — the
   decision-chain substrate. Relocates; does not dissolve.
6. The authorization stack (`approval-action-authorizer.ts`, evidence
   modules, `reviewer-publication-preflight.ts`, `runtime-access-controller.ts`).

**Where to host it — decided here, not at 2am.** One target structure: a new
`processing/` subtree inside the authority workspace, at
`services/organization-authority/src/processing/`. Register a new per-workspace
sub-boundary for it in `tools/workspace-source-boundaries.v1.json` (the same
file that registers the existing `services/*/src` manifests). Do **not**
create a separate top-level workspace, and do **not** compose it from outside
the authority. If this structure proves impossible for a given unit, stop and
log that unit — do not invent an alternative layout mid-run.

The two manifests in play:

- Root `product/source-boundary.v1.json` governs `src/` (where code moves
  *from*).
- `tools/workspace-source-boundaries.v1.json` registers the per-workspace
  manifests governing `services/*/src` (where code moves *to*).

Add layer rules **scoped to the new `processing/` module**; do not loosen
existing rules. **The one-line test for an allowed vs forbidden manifest
edit:** adding a rule or path scoped to `processing/` is allowed; adding any
entry that lets `processing/` import serving, facts, or authorization-read
code — or lets those import `processing/` — is a forbidden widening: stop and
log. `check:boundary` is the proof; if it cannot express the seam without a
forbidden widening, stop and log rather than force the import.

**Invariants to preserve while moving** (from v3 and the audit):

- **Create-once, never reinterpret.** Decision-node slots keep their
  write-exactly-once guarantee; a conflicting write is a refusal, never an
  overwrite.
- **Frozen presentation contract.** A posted card is never reinterpreted;
  changed content creates a new node. Do not alter rendering during the move.
- **Content-derived idempotency.** Preserve = **do not modify** the
  key-derivation code (`meetingProcessingKey → approval_id = sha256(key) →
  envelope idempotency_key`) while moving it; behavioral verification of the
  chain is the operator's morning job, not an overnight obligation.
- **Core imports no vendor types.** Core remains in the checked
  `provider_neutral_paths`; it must still compile and test with any single
  adapter removed.

**Working method (per unit in the ordered list):**

```text
for each unit (start from a green HEAD):
  move files; rewrite imports; update the boundary manifest(s)
  npm run check:boundary        # seam holds
  npm run typecheck             # compiles
  <any test:* target>           # fast iteration only; e.g. test:core / test:adapters / test:authority
  npm run check                 # full gate — authoritative
  if green: git commit -m "relocate: <unit>"   (tests move WITH their code)
  if red and mechanically fixable: fix, re-run npm run check, commit when green
  if red and not mechanically fixable:
     git reset --hard HEAD       # if the unit is uncommitted; discards the move + manifest edits
     (or: git reset --hard HEAD~1 if a bad unit was already committed)
     log to .migration/STATUS.md + DECISIONS.md, go to next unit
```

Notes on granularity and gates: a single unit (e.g. `src/core/**`) may be
split into several green commits — progress is counted in **units landed**,
not LOC, and "half of Stage A" means half the six units. Any `test:*` target
is fine for fast iteration; the full `npm run check` is the only
commit-authoritative gate. Move each unit's tests alongside it (`tests/…`
mirrors ownership); a unit is not "green" until its own tests run in the new
location.

**Stage A exit / tag.** As many units green as the night allows. Tag the last
green commit:

```sh
git tag -a checkpoint/relocated -m "Relocated set moved behind boundary seam; npm run check green; retire not yet started"
```

Record in `STATUS.md`: which of the six units landed, which were reverted and
why, and the exact `npm run check` result at the tag.

---

## Stage B — retire the dead and moved code

Enter only if `checkpoint/relocated` exists and is green. **After tagging
`checkpoint/relocated`, proceed directly into Stage B without waiting — this
run self-drives A→B.** The operator's accept/rollback decision happens in the
morning (see Morning handoff), not as an overnight pause. **Deletion is
test-driven.**

**Source of truth for what may die.** The RETIRED section of the boundary
audit (~17,000 LOC): lifecycle/self-supervision, self-update fleet,
backup/restore, enrollment + machine PKI, secret hardening, filesystem
transactions, the submission transport, and the 21 deleted commands — plus
any module left with no importer by Stage A.

**The submission transport is NOT retirable tonight (settled, not a
judgment).** v3 Phase 4a requires that the transport's ten-mode failure
taxonomy (`record/record-submitter.ts`, `record/ports.ts`,
`client/http-organization-record-client.ts`) be ported onto the in-process
processing→record path, with tests, **before** the transport is deleted.
That port is behavioral work and is explicitly out of scope for this
overnight run. Therefore: **do not delete the submission transport tonight.**
List it in `STATUS.md` as "held: taxonomy port is a follow-up task, not an
overnight deletion." This is the expected outcome, not a failure.

**Algorithm:**

```text
build the candidate list from the audit's RETIRED section
  (exclude the submission transport — see above)
order it leaf-first (delete importers' dependencies last)
for each candidate (start from a green HEAD):
  git rm the file(s); update the boundary manifest to drop the path
  npm run check
  if green: git commit -m "retire: <candidate>"
  if red:
     git reset --hard HEAD   # undo THIS candidate's rm AND its manifest edit; HEAD is the last green commit
     record in .migration/STATUS.md: "cannot retire <candidate> yet: <first failing test/import>"
     continue
```

Each candidate is attempted from a green `HEAD`, so `git reset --hard HEAD`
restores exactly that candidate's `git rm` and manifest edit and nothing
else — that is why it is the correct "undo this attempt" command here.

This is self-limiting by design: whatever the machine product still needs to
build and pass tests will refuse to be deleted, and that is the correct
answer — the rest of the retired set comes off only after cutover (v3 Phase
3/4), which is not tonight.

Two known-clean removals to attempt early if their triggers hold:

- `jsonl-outbox` (`delivery-surfaces/jsonl-outbox`, ~680 LOC) — only if
  local-only mode is being dropped; if unsure, skip and log (it is a v3
  Phase 0.6 decision, not an autonomous one).
- Anything under an already-`removed_internal_roots` path that still has
  residue.

Do **not** delete `credentials.ts` / `secure-local-files.ts` unless the suite
stays green — on the machine product they are still referenced; they retire at
cutover, not tonight.

**Stage B exit / tag.**

```sh
git tag -a checkpoint/retired -m "Retired set trimmed to what deletion keeps green; npm run check green"
```

Record in `STATUS.md`: every candidate, and for each, retired or "held
(reason)."

---

## Gate reference

| Gate | Command | Green means |
| --- | --- | --- |
| Master | `npm run check` | boundary + docs + typecheck + lint + all tests pass |
| Seam | `npm run check:boundary` | every import obeys the manifests; no orphan/allowlist gap |
| Compiles | `npm run typecheck` | workspaces + root typecheck clean |
| Fast unit | `npm run test:core` / `test:adapters` / `test:machine` / `test:authority` | that slice passes; use to iterate before the full gate |
| Docs | `npm run check:docs` | only relevant if a tracked doc changed; `.migration/` is git-ignored so `check:docs` never sees it |

A commit is legal only after `npm run check` is green (hard-stop rule 3). The
granular targets are for speed between commits, not a substitute for the
master gate at commit time.

---

## STATUS protocol

Keep `.migration/STATUS.md` current — it is the morning's first read. Append
one block per meaningful step:

```text
## <timestamp> — <stage> — <unit>
action:   <what changed, file-level>
gate:     npm run check = GREEN | RED(<summary>)
commit:   <sha or "reverted">
decision: <if best-effort judgment was used, what and why> (also in DECISIONS.md)
blocker:  <if stopped, exactly what and what a human must decide>
rollback: <the tag this step can be undone to>
```

At the end of the run, write a `HANDOFF` section at the top of `STATUS.md`:
current branch, the tags that exist, how far each stage got, the count of
units relocated / retired / held, and the single most important thing to
check first.

---

## Morning handoff — operator checklist

For the operator (Zhen). The overnight run is forbidden from live runs; these
are yours.

1. **Read `.migration/STATUS.md` HANDOFF first**, then `DECISIONS.md` to see
   every judgment the agent made under best-effort.
2. **Confirm the safety net:** `git tag --list 'pre-migration/*'
   'checkpoint/*'` and `git log --oneline main..HEAD`. Confirm `main` is
   untouched: `git rev-parse main` equals `4665c3a` (or your intended base).
3. **Re-run the gate yourself:** `npm run check` at `HEAD`, at
   `checkpoint/relocated`, and at `pre-migration/4665c3a`. All three
   should be green.
4. **Side-by-side live runs** (the part the agent could not do):
   - At `pre-migration/4665c3a`: run the current machine pipeline against
     a real (or your sanctioned test) Granola/Slack setup and capture the
     approved briefs and receipts.
   - At `checkpoint/relocated`: exercise the relocated module against the
     same inputs (fixture replay first; then, if you choose, a live run) and
     compare `meetingProcessingKey → approval_id → envelope idempotency_key`
     chains and decision sets. Divergence in the key chain is a defect;
     decision-set divergence is acceptable only if attributable to model
     non-determinism with identical evidence spans (v3 Phase 1 exit rule).
5. **Accept or roll back, per stage:**
   - Keep relocate, drop retire: `git reset --hard checkpoint/relocated`.
   - Keep both: stay at `checkpoint/retired`.
   - Abandon: `git switch main && git branch -D migration/server-core-relocate-retire`.
6. **Do not merge to `main` yet.** Merge is gated on `ADR-0001` (v3 Phase 0)
   plus your live-run sign-off.

---

## Out of scope tonight — do not touch

- Any live/external/credentialed call; any cutover, drain, credential move,
  or key retirement (v3 Phase 3).
- Person sessions, sign-in, the session store, the web identity-link flow
  (v3 Phase 2).
- The pre-record transcript store and its governance, the member valve, the
  visibility floor (v3 Phase 0.4 / Phase 5).
- The authority's own retirement pass — enrollment/lease/internal-live table
  deletion and `enrollment_id → principal/session` re-keying (v3 Phase 4b).
- `federation-protocol` removal (v3 Phase 4, only if the protocol split
  allows — not a mechanical overnight call).
- Postgres, service extraction, any deployment or infra change.
- `main`, remotes, pushes, merges.

---

## Definition of done (partial completion is success)

The run is a success if all of the following hold, regardless of how far into
Stage A/B it reached:

- `main` is untouched and the work is on an isolated branch.
- `pre-migration/4665c3a` exists and restores a green tree.
- Every commit on the migration branch is green under `npm run check` (WIP
  commits, if any, live only on `wip/*` branches and are the sole exception).
- If any relocate landed, `checkpoint/relocated` exists and is green.
- If any retire landed, `checkpoint/retired` exists and is green, and every
  deletion was test-proven, not speculative.
- `.migration/STATUS.md`, `ROLLBACK.md`, and `DECISIONS.md` are complete and
  current, and the HANDOFF section names the first thing to check.
- Nothing live, external, credentialed, or irreversible was done.
