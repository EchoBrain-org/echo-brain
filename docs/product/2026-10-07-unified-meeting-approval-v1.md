# Unified meeting approval v1

Status: design approved in conversation on 2026-10-07 (sections 1 to 4), and
shipped with its companion spec in #294 (b4ca880). The founder waived the
written-spec review. Decisions made while writing are listed at the end under
"Rulings made while writing", and those made while building both specs under
"Rulings made while building". Decision record: [ADR-0031](../decisions/ADR-0031-unified-meeting-approval-core.md).
Companion spec: [runs store and impact card](2026-10-07-runs-store-and-impact-card-v1.md).

Implementation note, 2026-10-08: the current Authority baseline is V13, which
adds the shared open items and sweep runs of
[open items and Home v1](2026-10-08-open-items-and-home-v1.md) (section 2) and
replaces V12; it is fresh state only, like V12. Text below that names V12
describes this design as written.

Surface retirement, 2026-11-01: the synthetic staging provider remains internal
to release qualification and no longer appears in the public tools catalog,
superseding ruling R8's permission to list it. Paste a meeting is retired;
retained and queued hand-ins remain governed by their original custody.
Native reviews use provider-independent `person reviews` requests.

## Goal

A meeting is approved once, in one place in the code, whichever screen the
person clicks on. Every meeting enters through a person. ECHO extracts it once
and makes one proposal. The proposal shows on the desktop, and in a Slack DM
if the reviewer has linked Slack. The first decision wins, wherever it was
made. One publisher writes one approved record. A named hook right after that
write lets later work (the impact check, spec 2) start from it.

## What changes for people

- The person who brings a meeting in reviews it. There is no organization
  meeting feed any more.
- The desktop card can share an approved meeting with **Only me** or with
  **one or more projects** (up to 20). The projects the person picked when they
  imported or watched the meeting are already ticked.
- Each action with an owner proposed by extraction gets an owner field,
  pre-filled with that proposal. The approver keeps, edits or clears it. Only
  confirmed owners are recorded.
- If the person linked Slack, the same proposal also arrives as a Slack DM with
  the same choices. Approving in either place closes it in both. The other
  surface shows who decided and where once it next draws.
- Sharing the transcript stays off unless the person ticks it.
- Approving the same meeting twice, from two screens, can never write two
  records.

## Product rules this design follows

- Build for everyone: no per-vendor paths. Slack is one optional surface.
- Owners need the approver (ADR-0021). Extraction proposes; code keeps only
  grounded proposals; the approved snapshot never carries an owner.
- Audience equals association for project policy (ADR-0017). Only me is the
  restricted-reviewer policy.
- Approved records stay the only thing search reads.
- The repository is public: fixtures stay fictional.

## The shape

```
person-owned sources ──► extract once ──► one proposal per meeting
   (Granola; staging                         │
    synthetic source)                        ├─► desktop card (always)
                                             └─► Slack DM copy (if linked)
                                                       │
                       decide() ◄──────────────────────┘
                          │  (decision table: one row per proposal, first wins)
                          ▼
                     one publisher ──► record log ──► after-record hook
                                                      (spec 2: impact run)
                          │
                          └─► search reconcile; surfaces redraw
```

Nothing below the proposal knows which surface a click came from, except the
`surface` label kept for the record and the redraw.

## 1. Where meetings come from

**Personal sources only.** The organization source lane (source key `'1'`,
used today only by the staging canary, the synthetic-demo fixtures and the
authority-core evaluation harness) is removed.

**One source per person per tool account.** Today a person who imports one
note into two projects gets two sources, two paid extractions and two
proposals, because the project is part of the source key, the source instance
id and the processor instance id. From now on:

- Source key: `pms_<sha256({person, identity})>`. The project leaves the key,
  the instance id (no project suffix) and the processor instance id
  (`personal-<sha256(person)>`).
- The review lineage is therefore (person, tool account, provider meeting id):
  one proposal per meeting per reviewer.
- "Save to" on import and on folder watch stays in the app, but now records a
  **suggestion**, not a source. Import suggestions are kept per meeting; the
  watched folder keeps its project as the suggestion for its meetings.
- A meeting's suggested projects are frozen onto its proposal when it is
  staged. The card ticks the suggested projects the reviewer can still read.

**Staging synthetic source.** A synthetic personal source replaces the
organization lane on staging only (the existing staging-origin guard):

- Provider id `synthetic`, source adapter id `staging-synthetic-meeting`,
  its own cursor policy. It is never mistaken for Granola.
- It serves the fixed release-canary meeting, plus the fixture meetings from
  `--staging-synthetic-meetings-dir` when the onboarding configured one.
- The release canary keeps its control socket, command and receipt shape
  (`kind`, `approval_outcome`, `approval_id`), so the deploy scripts do not
  change. It now ensures the synthetic source for the single active owner,
  queues the canary meeting, runs one processing pass and reports the staged
  proposal. The founder approves it on the desktop, or in Slack if linked.
- Setup finalize queues the fixture meetings into the owner's synthetic
  source instead of admitting an organization source. Setup status reads its
  canary evidence from the synthetic source's proposals and records.

## 2. The proposal

A proposal is the existing frozen candidate plus its outbox row, keyed per
meeting (lineage above). No second candidate store.

- **Freeze.** The approval core stages a candidate by freezing its snapshot:
  the outbox moves `queued → staged` in one step, with the approved snapshot,
  its hash and the suggested projects. There is no "posting" or presentation
  id on the outbox any more; delivery to Slack is tracked separately (section
  5).
- **Snapshot.** Built once by the core for every surface (`surface:
  'echo-approval-core'`). The brief's proposed owners are cleared before
  freezing (ADR-0021), so the bytes are the same whether or not owners were
  proposed.
- **Owner proposals** are read from the candidate's uncleared extraction when a
  card is drawn: one per action with a grounded proposal, at most 40.
- **A new revision before a decision** supersedes the open proposal (today's
  lineage rule). Surfaces redraw it as replaced.
- **A new revision after a decision** becomes a new proposal. The decided one
  and its record stay as they are.
- A proposal is decided only through the decision table. Supersession skips a
  proposal that has a decision row; nothing else blocks it.

## 3. Deciding

**Decision table** (`authority_approval_decisions_v1`): one row per proposal,
written once, never changed except to add the publisher's receipt. It
generalizes today's in-app action table.

| Column | Meaning |
| --- | --- |
| `sequence` | Order of decisions. |
| `approval_id` | The proposal. `UNIQUE`: the first decision wins. |
| `command_id` | The surface's idempotency key. `UNIQUE`. Desktop: the card's command id. Slack: `slack:` plus the verified click key. |
| `surface` | `desktop` or `slack`. |
| `body_json` | The request (action, project ids, transcript choice, confirmed owners, snapshot hash), the actor (organization, principal, membership), a digest of the evidence that authorized it, and the time. |
| `receipt_json` | Empty until the publisher writes the record. Approvals only. |

Triggers refuse every update except filling `receipt_json` once, and every
delete.

**`decide(request, authorize)`** is the only way to write a row. In one
immediate transaction it:

1. Re-runs `authorize()` (the surface's own check, see below) and requires the
   actor to be the proposal's reviewer (organization, principal, membership of
   the source) with an active membership.
2. If the proposal already has a decision: the same command and request
   returns the same result (replay); anything else returns
   `already_decided` with the existing outcome and surface. Nothing is written.
3. Requires the proposal to be `staged` and the request's snapshot hash to
   match. A superseded or changed proposal returns `stale`.
4. Checks the choices:
   - Approve: `project_ids` is empty (Only me) or 1 to 20 sorted, unique ids,
     each an active project the actor is an active member of now. Owners name
     proposed actions by signal id, each at most once, as trimmed text of 1 to
     120 characters with no control characters.
   - Reject: no projects, no transcript share, no owners.
5. Inserts the row, then wakes the publisher after commit.

**Desktop authorization:** the signed-in session, checked again right before
the insert (today's rule).

**Slack authorization:** a verified click (section 5) whose Slack user has an
active identity link to the reviewer's membership, read again inside the
transaction. A lost link or a lost project refuses the click.

## 4. Publishing

**One publisher** replaces the in-app `appendPending` and the Slack terminal
coordinator. For each approval without a receipt, oldest first:

1. Build the approved event from the frozen snapshot and the decision: Only me
   → restricted-reviewer policy; projects → project-members-readable policy
   with audience = association = the chosen ids.
2. Build the human-act reference in the new neutral proof format,
   `echo-approval-decision-ref-v1` (field `approval_decision_ref_v1`). It keeps
   every field the record package reads by name (approval id, action,
   audience and association ids, transcript choice and source, audit event,
   sequence and digest, provider action digest, authorization proof digest,
   selected policy and contract digest), and adds `surface` and
   `action_owners` (the confirmed owners by signal id, in brief order, the
   Slack V3 shape). It drops the Slack- and card-specific fields.
3. Append through the record log (signed, idempotent on approval id and
   action).
4. In **one Authority transaction**: write `receipt_json` and run the
   **after-record hooks** (`afterApprovedRecordV1`). A hook gets the
   transaction handle and `{approval_id, record_sha256, reviewer, decided_at}`
   and may only write Authority rows. Spec 2 registers the impact-run enqueue
   here.
5. After the batch: request search reconcile and surface redraw.

**Crash safety.** The record log and the Authority are separate files. A crash
after the append but before step 4 re-runs on recovery: the append returns
`duplicate`, and step 4 then happens once. So the hook runs exactly once per
approved record, and recovery finishes before search reconcile at startup
(today's order).

Rejections write no record and run no hook.

## 5. Surfaces

### Desktop (always)

The review list and card stay in the meetings sheet of the desktop app.

- The list shows each proposal's status (`pending`, `publishing`, `approved`,
  `rejected`, `superseded`) and, once decided, where (`desktop` or `slack`).
- The card shows the meeting content (today's text), **Who can read it**
  (Only me, or a project multi-pick reusing the capture screen's project list:
  search after 8 projects, more pages, at most 20 ticked), **Share the
  transcript** (off), the owner fields, and Approve or Reject.
- Clicking on a proposal already decided elsewhere shows "Already approved in
  Slack" (or rejected) and refreshes. The desktop does not refresh on its own.
- The meetings API envelope moves to `schema_version: 2`:
  - `review_open` returns `{review, snapshot_sha256, content, owners:
    [{signal_id, action, proposed}], suggested_projects: [{project_id, name}]}`.
  - `review` takes `{approval_id, command_id, snapshot_sha256, action,
    project_ids, share_transcript, owners: [{signal_id, owner}]}` and returns
    `{status, decided_on}`.
  - `reviews` rows carry `project_ids` and `decided_on`.
  - `home.sources` lists one source per tool account with `folder_id` and
    `folder_project_id`.

### Slack DM copy (only if the reviewer linked Slack)

Slack becomes a plug-in on the core. It reads proposals and decisions and
calls `decide`; it never writes records.

**Shown-on table** (`authority_approval_presentations_v1`): one row per
proposal and surface (`slack` only for now). It holds the delivery target (the
connection, the identity link, the Slack user and DM channel), the message
timestamp, the card hash, the delivery state (`posting`, `posted`,
`unrepresentable`, `failed`), what the card currently shows (`open`,
`approved`, `rejected`, `superseded`), attempts and the next retry time. It
replaces the Slack assignment table, the Slack terminal receipts, the
delivery quarantine table and the `echo:<approval_id>` presentation id.

**Presenter** (runs in the presentation reconcile after staging and after
publishing):

- Post: for each staged, undecided proposal with no Slack row whose reviewer
  has an active link on the active Slack connection, post the card to the
  reviewer's DM (today's poster, with its marker and retry rules). A person
  who links Slack later gets their open proposals on the next pass.
- Unrepresentable: a card that cannot fit Slack's limits is marked so and not
  retried. The desktop still has it.
- Redraw: when a posted card's proposal is decided (either surface) or
  superseded, replace it with a closed card: "Approved in the ECHO desktop" /
  "Rejected in Slack" / "Replaced by a newer version of this meeting", plus
  the audience.

**Card** (one new version on the existing builders): the review blocks, an
audience select (Only me or Projects), the project multi-select (the
reviewer's active projects, at most 20 ticked, suggested ones pre-ticked), the
transcript checkbox, one owner field per proposed action, and Approve and
Reject. The button value carries `{schema_version: 2, approval_id,
snapshot_sha256}`. There is no Team option and no note field, so both surfaces
offer the same choices.

**Click:** the existing HMAC check, freshness window, size cap and closed
parser stay. After parsing, the plug-in checks that the click's workspace,
channel, message timestamp, user and app match the posted row, then calls
`decide` with `surface: 'slack'`, `command_id: slack:<click key>` and an
authorizer that re-reads the identity link. `already_decided` and `stale`
redraw the card. The handler answers Slack only after the decision row (or the
refusal) is durable.

## 6. Data

All Authority and control-plane state is reset (no migration); the record log
starts empty with it.

**Authority baseline V12** (fresh state only):

- `authority_person_meeting_sources_v2`: one row per person and tool account
  (`source_key`, `person_key`, `folder_id`, `folder_project_id`,
  `settings_revision`). At most one watched folder per person, as today.
- `authority_person_meeting_suggestions_v1`: `(source_key, external_id,
  project_id)`, insert-only, written by import.
- `authority_live_approval_outbox_v2` keeps its name; states are `queued`,
  `staged`, `superseded`; it gains `suggested_projects_json` and loses
  `provider_message_ts`, `frozen_card_sha256`, `private_approval_card_v2_json`,
  `post_started_at`, `control_approval_sha256` and `tombstoned_at`.
- `authority_approval_decisions_v1` (section 3) replaces
  `authority_person_meeting_approval_actions_v1`.
- `authority_approval_presentations_v1` (section 5).
- `authority_trigger_runs_v1` (spec 2), in the same baseline so there is one
  reset.
- Removed: `authority_private_approval_assignments_v3`,
  `authority_private_approval_terminal_receipts_v3`,
  `authority_live_approval_delivery_quarantines_v1`.

**Control-plane baseline V4:** the four `organization_private_approval_*`
tables and their triggers are removed. Slack connection, identity link and
person link tables stay.

**Record proofs:** the record-input codecs and policy projectors for the
in-app V1 reference and the Slack V1, V2 and V3 references are removed (only
possible because the record log is reset). The generic human-act codec stays
for captures. The owner readers (search snapshot, meeting items) read
`action_owners` from the new reference.

## 7. Removed

- The organization source lane: the org branch of the Authority runtime, the
  staging synthetic and fixture selection into source `'1'`, the synthetic-demo
  admission and bundle, the processing-state canary branches, the OpenRouter
  admission verifier for source `'1'`, and the meeting-approval journey
  telemetry sidecar that only observed that lane.
- Slack approval internals: the terminal coordinator, assignment state,
  terminal authority, authority fence, reviewer resolvers by email, the Slack
  record writer, the control-plane approval persistence and policy
  resolutions, and the old card controls (V1 controls, Team, note).
- The in-app review module, replaced by the approval core.

Kept and reused: the Slack client, bot token source, connection health,
identity link lookup, card review blocks and builders, poster, interaction
protocol and HTTP adapter.

## Build order

One or more commits per step; `npm run check` passes after each step.

1. **Remove the organization lane.** Add the staging synthetic personal source
   and re-point the canary, setup finalize and status, and the authority-core
   evaluation harness to personal sources. Delete the org lane. Slack
   approvals are paused from here until step 3.
2. **Approval core.** V12 and control-plane V4 baselines; one source per
   person; proposal freeze with suggestions; decision table and `decide`;
   neutral proof and owner readers; one publisher with the after-record hook;
   meetings API v2; desktop card with projects and owners.
3. **Slack plug-in.** Shown-on table, presenter (post, redraw), new card,
   click → `decide`; delete the old Slack approval code, tables and codecs.
4. **Founder rehearsal** on staging (founder-run): reset, canary, approve on
   desktop, approve another in Slack, confirm one record each.

## Acceptance

Tests that must exist and pass:

- **Race:** desktop and Slack decide the same proposal at once → one decision
  row, one record; the loser gets `already_decided`.
- **One meeting, two projects:** importing one note with "Save to" A and then B
  → one extraction, one proposal, both projects suggested.
- **Edits:** a new revision before a decision supersedes the proposal (both
  surfaces redraw); after a decision it becomes a new proposal and the record
  stands.
- **Crash recovery:** a crash between append and receipt → one record, one
  receipt, one hook call, all before search reconcile at startup.
- **Owners:** the record carries exactly the confirmed owners; cleared fields
  are absent; the snapshot carries none.
- **Refusals:** a project the approver lost, or a Slack link that was removed,
  refuses the decision and writes nothing.
- **Desktop only:** with no Slack connection, the desktop flow works end to
  end; the server starts with neither Slack nor Granola configured.
- **Ask goldens unchanged** (`GOLDEN_WRITE` never set).
- `npm run check` passes.

## Not in this round

- Notifications (no push, no badge beyond the list).
- A manual hand-in source.
- Editing a record's text before approval.
- Delegating review to someone other than the importer.
- A meeting inbox outside the meetings sheet.

## Rulings made while writing

Made on the founder's behalf under "take it end to end"; each is cheap to
change before staging.

1. "Save to" on import and watch stays in the app as a suggestion, so the
   card can pre-tick projects (the alternative was removing it).
2. The Slack card loses the Team option and the note field, so both surfaces
   offer the same choices and one proof format covers both.
3. An owner field appears only for actions with a grounded proposal (ADR-0021
   as written), not for every action.
4. The outbox keeps its table name; only its columns and states change, to
   limit churn in the processing state.
5. The staging canary keeps its receipt kind string
   (`…private-dm-canary-receipt-v1`) so the deploy scripts stay unchanged;
   renaming it is a later cleanup.
6. The four-meeting fixture rehearsal is kept and re-pointed at the synthetic
   personal source rather than retired.
7. The meeting-approval journey telemetry sidecar is removed with the lane it
   observed.
8. The meetings API changes in place to `schema_version: 2`; the desktop and
   the server built with this change must ship together (the reset already
   requires that).
9. The review card stays in the meetings sheet; a separate inbox is later.

## Rulings made while building

Made while executing the implementation plan for this design and its
companion, [runs store and impact card v1](2026-10-07-runs-store-and-impact-card-v1.md),
which shipped together in #294 (b4ca880); the plan was then retired. They are
kept word for word because code cites them by number (R26, R28 and R30(d),
for example). A task (Task 1 to Task 16, and the side track Task 13a) is one
of the plan's steps; spec 1 is this design and spec 2 its companion. These
R-numbers are the plan's own; open items and Home v1 numbers its rulings
separately. The code owns what was built, with
[ADR-0031](../decisions/ADR-0031-unified-meeting-approval-core.md) and
[ADR-0032](../decisions/ADR-0032-stored-trigger-runs.md).

Each ruling says what was decided, why, and what it costs if wrong.

- Ruling R1: Plan tests name helpers (`syntheticWorld`, `approvalCoreFixture`,
  …) without code — each task builds them from the existing fixtures named in
  the code maps — the plan cannot carry full fixture code for a refactor of
  this size — costs some reviewer back-and-forth if a helper hides weak
  assertions.
- Ruling R2: Task 6 updates every `intake.ensure`/`enqueue` caller Task 2
  added (synthetic provider, canary runner, setup finalize) — keeps T2's code
  compiling after the signature change — costs nothing if wrong beyond a
  reviewer catch.
- Ruling R3: Tasks that touch modules the authority-core harness imports (T4,
  T7, T8, T9) also run `npm run test:capacity`; tasks touching the research
  loop or renderers (T13, T14) also run `npm run test:research-loop-eval` —
  root `npm run check` runs neither — costs a broken harness found late if
  skipped.
- Ruling R4: `withoutProposedOwnersV1` and `ownerProposalsV1` live in
  `packages/organization-processing/src/core/processing/owner-proposals-v1.ts`
  (neutral), not in the Slack provider; Slack's card-input module imports them
  — the approval core must not depend on a provider package — costs a file
  move if the founder prefers otherwise.
- Ruling R5: Tasks touching the desktop (T9, T10, T15) also run `npm test` in
  `product/echo-desktop` (build + vitest + Playwright) — root `npm run check`
  does not include the desktop — costs a red desktop suite found late if
  skipped.
- Ruling R6: The hidden count reads "1 item you can no longer open is hidden."
  for one and "N items you can no longer open are hidden." otherwise — correct
  English; the spec gives only the plural — costs a one-line copy change.
- Ruling R7: Keep the implementer's `Co-Authored-By: Claude Sonnet 5.5`
  trailer on 552a111 rather than amending — it names the model that wrote the
  commit and amending is history rewriting — costs a cosmetic trailer
  mismatch.
- Ruling R8: The synthetic tool may appear in staging tool catalogs
  ("Synthetic staging meetings · Linked") — it is composed only on the staging
  origin and review rows are per person across all sources, so the founder
  approves synthetic proposals from the Granola meetings sheet — costs a
  confusing extra row on staging only.
- Ruling R9: The release canary is bound to the release again — the control's
  release_id becomes part of the canary meeting's revision (same external
  meeting id, one new revision per release, so an undecided earlier canary is
  superseded), the runner takes `release_id`, and setup status accepts canary
  evidence only for the current release (ECHO_CLEAN_RELEASE_ID) as before — a
  gate that passes on any historical approval tests nothing; the plan's runner
  signature and the spec's "fixed release-canary meeting" wording did not
  intend that — costs one paid extraction per release (same as the old lane).
- Ruling R10: In Task 3, tests that exercise Slack approvals through the
  organization lane are deleted, not rewritten (Slack approvals are paused
  until Tasks 11–12, which add tests for the new plug-in); non-Slack behavior
  in the same files is re-pointed to the personal lane — rewriting tests for
  code Task 5 deletes is wasted work — costs a coverage gap for Slack
  approvals between Task 3 and Task 12.
- Ruling R11: Accept the one-line `update-clean-v1.sh` edit removing the
  deleted OpenRouter verifier call — the verifier guarded source '1', which no
  longer exists — costs a deploy-order constraint: the host update bundle must
  ship with or before the image built from the feature branch (founder note).
- Ruling R12: The deleted service-level pre-V12 refusal test (non-Slack half:
  record-log and integrations files untouched on refusal) is restored together
  with the packed Person CLI test — both are non-Slack behavior that R10
  requires to be re-pointed, not deleted — costs one more test file to
  maintain.
- Ruling R13: No capacity metric profile bump in the feature branch — the
  harness's shared reader class becomes project-members-readable because spec
  1 removes the Team (organization-member) audience, so the V4 profile's
  organization-member approval class has no live path; any capacity baseline
  taken after the feature branch must say so, and a V5 profile is the
  founder's call — costs a possible apples-to-oranges comparison with a
  pre-branch V4 baseline (none has been taken per the README's "no baseline
  carries forward").
- Ruling R14: The signed-slack-approval-v2 test fixture and its users stay
  until Task 8, which moves them when it deletes the Slack codecs — the
  fixture imports nothing Task 5 deletes and moving it twice is waste — costs
  Task 8 one more fixture to migrate.
- Ruling R15: ownerProposalsV1 returns no proposals when a brief has more than
  40 grounded owners (today's card behavior: fall back and offer no owner
  fields) — the spec's "at most 40" is read as a cap on the whole set — costs
  owner fields on meetings with 41+ grounded proposals (rare).
- Ruling R16: Run work in parallel where files do not overlap (founder asked)
  — side track Task 13a (storable impact card functions + renderer exports,
  runs API contract, recordAnchor lookup) carved from Tasks 13/14 into
  worktree .worktrees/unified-approval-runs-kernel (branch
  feat/unified-approval-runs-kernel from 0a7989c), focused tests only, merged
  into the main branch after Task 6 with one full check; after Task 8, three
  tracks (9→10, 11→12, 13→14) in separate worktrees with serialized full
  checks — machine load already caused timeouts with two concurrent full
  suites — costs merge reconciles in the V12 SQL/hash pins, composition root
  and core options.
- Ruling R17: Tasks 7, 8 and 11 (riskiest) run as Opus 5.5 multi-agent
  workflows (founder asked, "ultracode"): design panel (3 independent designs
  → judge → synthesis → adversarial critique → revision), then one
  implementer, then a multi-lens review with adversarial verification of each
  finding and a bounded fix loop — replaces the single implementer + single
  reviewer for those tasks; Task 7's design workflow runs read-only now, in
  parallel with Task 6 — costs more tokens and the design may need a small
  refresh for Task 6's final shape.
- Ruling R18: recordAnchor requires the readable-search generation at the
  exact record-log head (as initializeDesk does), so a lagging generation
  retries even when it already holds the record — stricter than the brief,
  same uncounted-retry path — costs a few extra retries right after busy
  approval bursts.
- Ruling R19: A stored card keeps the model's `date_at_risk.milestone` and
  research "needs" notes (model-written text, per the spec's storage table);
  only labels of outside items are scrubbed — costs the risk that a
  model-written milestone echoes a phrase from a ticket (final review to
  weigh).
- Ruling R20: Keep ADR-0030's pre-approval readability — the per-meeting
  suggestion rows become the readable-project list for a meeting's imported
  (unapproved) notes: an import with a project writes a suggestion row (as
  now) and the watched folder writes one with the folder's project for each
  meeting it delivers; members of a suggested project can read that meeting's
  imported notes as before; a private import (no project) stays importer-only;
  the import consent text stays accurate — removing a founder-approved
  capability silently would be a regression and the per-person source change
  was not meant to alter who can read notes — costs one more suggestion writer
  (folder intake) and a fix round before review.
- Ruling R21: refreshImpactCardV1 owns re-open mismatches — a fresh item whose
  kind or primary id (ticket key, page id, Slack channel+ts, record
  atom/record, source revision) differs from its stored pointer, or that
  duplicates an earlier kept fresh pointer, is hidden and counted in `hidden`;
  `local` is derived from the citation kind, not supplied by the caller — the
  view must never throw on a provider's legitimate "page from the top" re-open
  — costs: a row about an edited Confluence section may still show page-top
  text beside its old relation when the page id matches (accepted, rare).
- Ruling R22 (revises R19): every stored model-written line — decided text,
  ECHO-local says_now, unconfirmed notes, and date_at_risk.milestone — is
  screened against outside labels (case-insensitive, also matching a label's
  first 200 characters so a truncated note cannot slip through): label
  occurrences in decided/local lines are replaced with "a cited item"; a
  milestone that contains a label drops its date_at_risk; notes stay counted
  as now — the reviewer showed concrete verbatim-title leaks through decided
  text and milestones, which ADR-0032 forbids — costs some lost wording on
  cards; partial-name paraphrases remain unscreened (best effort).
- Ruling R23: Task 7's freeze uses `intake.suggestions(sourceKey, externalId)`
  alone (drop the folder-project union from the plan's freeze rule and the
  third parameter of the core's `suggestions` option) — folder deliveries now
  write their own suggestion rows (R20), so adding the current folder project
  would pre-tick it on private imports made while a watch is on — costs
  nothing if wrong beyond a re-add.
- Ruling R24: Task 14 adds word boundaries to the outside-label screen (a
  non-letter/digit boundary before both patterns, after the full-label pattern
  only; the 200-character prefix stays open at its end) with a test that "Show
  two decimals on the displayed value from the homepage." survives labels
  "Display" and "Home" — without it, short page titles garble stored ECHO text
  ("a cited itemed") — costs a slightly wider gap for labels glued to other
  words.
- Ruling R25: An import's project suggestion is recorded only when the import
  is consumed by processing, never at queue time — enqueue writes a deletable
  pending row (new table authority_person_meeting_pending_suggestions_v1 in
  V12), cancel_import deletes it, and the transaction that consumes the queued
  import (admission of that meeting, or the cursor advance that drops an
  already-admitted revision from the queue) promotes it into the insert-only
  suggestions table; folder deliveries keep writing at admission — a cancelled
  "Save to A" must leave A with no access — costs one small table and its hash
  pins.
- Ruling R26: The importer always reads their own imports, including a project
  import after they leave that project (no third party gains access; the
  review card already shows them the snapshot); ADR-0030's sentence is updated
  in Task 16 to "importing person always; members of a suggested project while
  they are members" and says suggestions are per meeting — costs a slightly
  wider rule than ADR-0030's wording.
- Ruling R27: While in the file, the Task 6 fix also replaces
  `INSERT OR IGNORE` with
  `ON CONFLICT(source_key, external_id, project_id) DO NOTHING`, narrows the
  two bare `catch {}` blocks (suggestedProject, reviews membership check) to
  AuthorityOperationError, and adds the release-recheck test for a
  non-importer project reader who leaves the project — cheap, same code, and
  swallowed errors would otherwise reach the final review — costs a few extra
  lines in this fix round.
- Ruling R28: Promote pending import suggestions in the cursor-advance
  transaction that drops the meeting from the queue after processing (both
  fresh and already-admitted revisions), not at admission; folder deliveries
  keep writing at admission — a cancel during extraction or after a failed
  cycle must leave the project with no access (R25's intent), and this also
  promotes an in-flight re-import's project — costs a second fix round;
  between admission and advance, project members cannot read the note yet
  (fail closed).
- Ruling R29: Task 7's freeze sets suggested_projects_json from the meeting's
  promoted suggestions UNION its pending import suggestion rows (deduped,
  sorted, ≤ 20) — under R28 a fresh import's projects are still pending when
  the stager freezes, so suggestions alone would pre-tick nothing; the frozen
  list is only a pre-tick hint, never read access — costs a pre-tick of a
  project whose import is cancelled after the proposal is already staged (the
  approver can untick it).
- Ruling R30: Accept the Task 7 design workflow's rulings as listed under
  "Design rulings, Task 7" below, including its five controller items — (a)
  the freeze uses intake `proposalSuggestions` = promoted ∪ pending
  suggestions (matches R29); (b) freeze-at-stage stands, so a "Save to B"
  chosen after the meeting's current revision is frozen is not pre-ticked; (c)
  receipt_json stores canonical `{record_sha256, receipt}` with a CHECK tying
  them; (d) Task 8 amendment: after-record hooks run only when the receipt
  UPDATE changes one row, and a zero-change path verifies the stored
  record_sha256; (e) Task 11 presenters bind as factories
  `(core) => ApprovalPresenterV1` via ApprovalCoreOptionsV1.presenters — the
  panel weighed these against the code and spec — costs: each is listed with
  its own cost below.
- Ruling R31: Accept the Task 8 design workflow's rulings (listed under
  "Design rulings, Task 8" below), notably — Team refused by the neutral codec
  and projector (Only me = restricted-reviewer with [], projects =
  project-members-readable 1..20); audit_event_id must equal
  'audit:'+command_id and the command binds to the surface; the hook event's
  reviewer/decided_at come from the signed reference and are asserted equal to
  the decision body (Task 13 relies on it); transcript_source is frozen into
  the decision body by decide() (Task 8 amends Task 7's approval-core-v1.ts)
  so retries rebuild identical bytes; the codec refuses an approved brief with
  zero signals (only actionable candidates are staged, so decide() needs no
  change); the lifecycle is NOT changed — after a failed pass, search
  reconcile and redraw wait for the next successful pass or cycle (spec §4
  step 5 met that way; startup recovery stays fail-closed); after_record
  reaches production via an approval_core option on
  openGranolaPersonLiveRuntimeV1 (Task 13 adds the hook line);
  authority-record-protocols-v1.ts is the single list of
  codecs/projectors/approvers shared by composition root, fixtures and the
  harness — costs: listed per ruling below; the riskiest is the lifecycle
  choice (a permanently failing row delays search for rows that did publish
  until another pass succeeds).
- Ruling R32: (founder, near usage limit) Task 8's workflow drops the
  three-skeptic verification — one agent per round verifies each review
  finding against the code and fixes only the real ones, then a scoped
  re-review checks fixes and dismissals; at most 2 rounds. Applied by stopping
  the run after the four reviews finish and resuming with the edited script
  (implement + reviews come back from the run's saved results) — costs weaker
  filtering of false findings (the fixer judges its own) and fewer rounds.

### Design rulings, Task 7 (approval core)

From the Task 7 design panel, accepted as ruling R30.

- R23 followed over the brief: options.suggestions is (sourceKey, externalId).
  The freeze unions nothing with the source's current folder_project_id,
  because folder deliveries write their own suggestion rows (R20/R25). Cost if
  wrong: re-add the third parameter and a union in one function.
- Correction to the judge's graft. The judge said
  canonicalJson(result.receipt) carries $.record_sha256
  (record-append-factories-v4.ts:33). That line is the receipt seed. The
  append returns the signed receipt V2 {body, receipt_sha256,
  signing_key_descriptor, signature}, so the digest is at
  $.body.record_sha256. Decision: store the raw signed receipt (no wrapper, as
  the judge preferred), CHECK json_type(receipt_json,'$.body.record_sha256')
  IS 'text', and export APPROVAL_DECISION_RECORD_SHA256_PATH_V1 =
  '$.body.record_sha256'. Task 13's trigger, written in the plan as
  '$.record_sha256', must use this path. Cost if wrong: one CHECK and one
  constant.
- One owner rule, placed in
  packages/organization-protocol/src/approval-owner-choice-v1.ts
  (isApprovalOwnerTextV1, isApprovalSignalIdV1,
  APPROVAL_OWNER_MAX_CHARACTERS_V1, APPROVAL_OWNERS_MAX_V1), not next to
  owner-proposals-v1.ts as the judge asked. organization-processing does not
  depend on organization-protocol, and Task 8's codec lives in protocol. The
  rule is the spec's: trimmed, 1 to 120 code units, no \p{Cc}\p{Cf}. It is
  looser than the Slack V3 NFC and single-space rule. canonicalProposedOwner
  is a strict subset, and a services test pins that. Cost if wrong: move the
  predicate; Task 8 must import it.
- Signal ids an owner can name must pass the record identifier pattern.
  ownerProposals() leaves out proposals whose signal id does not, so surfaces
  never offer an owner that Task 8's codec would refuse (signal ids are only
  non-empty strings in DecisionSet). Cost: an action with an exotic id gets no
  owner field.
- The global state is a delegating SqliteApprovalWorkflowStateV1 in the
  processing state module. Per call it resolves source_key and adapter, then
  delegates to a per-source SqliteAuthorityMeetingProcessingStateV1 built from
  the configured cursor policy and processor adapter. This replaces design 1's
  extracted rows helper and keeps assertAdmissionSnapshot without refactoring
  the 1,311-line class. Cost: one lookup query and one object per call.
- ApprovalWorkflowContextV1 keeps `state`. Design 3's removal is rejected
  because it ripples into the harness and fixtures and no requirement needs
  it. Cost: none.
- ApprovalWorkflowBundleV1 and ApprovalWorkflowComponentsV1 are deleted (no
  implementer since Task 5). source-boundary.v1.json's canonical component
  becomes 'Approval workflow context' / ApprovalWorkflowContextV1 at the same
  path, so check-architecture-boundaries.mjs:244 passes.
  github-governance.test.ts:53 and package.json:80 stay valid because the file
  stays. Cost: none.
- Six database triggers, not design 1's five plus owners: staged plus
  snapshot, active reviewer, and sorted audience with active membership on
  decisions; ordered transitions, suggestion order and existence, and
  decided-final on the outbox. The owners trigger is dropped. Owner validity
  rests on decide() plus Task 8's codec, which checks against the snapshot, so
  the owner rule lives in one place. Cost if wrong: an owner bug in a future
  surface is caught at publish rather than at insert.
- The proposal snapshot is checked with validateApprovedDecisionSnapshotV2
  (protocol subpath record-codec-support-v4) at freeze time. On failure the
  proposal stays queued and the failure is visible (there is no quarantine).
  Cost: a code defect shows as 'needs attention' on that source until it is
  fixed.
- decide() refuses an approval whose source revision is no longer retained
  (AuthorityOperationError 'unavailable'), so an immutable decision can never
  be one that cannot publish. Cost: an approval during a custody gap must wait
  for re-retention.
- Static request validation (validateApprovalDecisionRequestV1, exported for
  Tasks 9 and 12) runs before authorization and refuses extra keys. A
  malformed request to an already-decided proposal returns invalid_request,
  not already_decided; every well-formed loser still gets already_decided
  (spec section 3, step 2). Cost: a buggy client sees invalid_request instead
  of the outcome.
- Owners must be in brief order and project_ids strictly ascending. Both are
  refused, not normalized, so the stored request is exactly what was validated
  and what Task 8's reference needs. Cost: clients must sort and order; a
  reordered replay becomes already_decided.
- command_id is bound to surface: slack requires /^slack:[A-Za-z0-9._:-]+$/
  (spec section 3), and desktop must not start with 'slack:'. This is enforced
  in the validator and by CHECK ((surface='slack') = (command_id GLOB
  'slack:*')). The command pattern is /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/ so
  that 'audit:<command_id>' fits the record identifier. Cost: Task 12 keys
  must be base64url or hex of at most 122 characters.
- The evidence kind must match the surface (person-session for desktop,
  slack-click for slack); a mismatch is unauthorized. The actor's organization
  must equal the runtime coordinates. Cost: none.
- A command id reused on another proposal returns invalid_request (judge's
  preference over design 3's stale_access_state). Cost: none.
- The wake fires after commit for decided (approve and reject, so presenters
  redraw) and for replayed (a first response may have been lost after commit;
  the harness expects wakes === 2). It never fires for already_decided, stale
  or refusals. Cost: one extra wake per replay.
- Revoked reviewer (fixes defects_in_all #3). No terminal state is invented.
  Freeze returns {kind:'revoked'} and the proposal stays queued. Reconcile
  lists only active reviewers. decide refuses (unauthorized). Views carry an
  additive reviewer_active flag so Task 11 presenters skip such proposals, and
  status stays 'pending'. A revoked membership cannot authenticate and
  re-provisioning creates a new membership_id, so the proposal is unreachable.
  Cost: stale undecided rows remain until the next reset.
- Undecided proposal views filter the frozen suggestions to projects the
  reviewer can read now (options.projects per id, catching only
  AuthorityOperationError, memoized per call). Decided views return the
  decision's ids verbatim. Every presenter (the v1 route, Task 9, Task 11)
  gets the same list (fixes defects_in_all #6). Cost: up to 20 membership
  reads per undecided row.
- ApprovalProposalViewV1 narrows snapshot_sha256 and snapshot_json to non-null
  (only frozen proposals are returned) and adds decided_at and
  reviewer_active. Cost: none; this narrows and adds without breaking callers.
- stage() on an already-staged proposal returns staged without rebuilding the
  snapshot (first freeze wins), so a later change to compileDecisionBrief
  cannot break a frozen proposal. freezeProposal's byte comparison remains
  only for cross-process races. Cost: no determinism self-check on re-stage.
- Beyond the brief, ApprovalCoreV1.stagerForSource(sourceKey) is added. The
  runtime's lanes use it so reconcilePendingDeliveries touches only that
  person's source, keeping today's per-source failure isolation. The global
  stager remains for the harness and tests. Cost: one more method.
- Suggestions are frozen at staging (spec section 2). A 'Save to B' import of
  a meeting whose current revision is already frozen does not tick B on that
  proposal. Imports before processing (the spec's acceptance case) do. Cost: a
  user may need to tick B manually on the card.
- The interim v1 route maps already_decided to stale_access_state 'Meeting
  review has already been resolved' and stale to 'Meeting review has changed',
  matching today's behavior and tests, until Task 9 returns {status,
  decided_on}. Cost: a Slack-first decision shows as a generic error on the
  desktop until Task 9.
- The interim publisher pages through every unpublished approval per call with
  per-row isolation (first error rethrown after the loop, immediate rethrow
  when aborted). It skips sources this runtime does not configure and
  publishes even if the reviewer's membership was revoked after deciding
  (today's rule). Cost: a permanently failing row is retried every cycle.
- proposals() does not join authority_person_meeting_sources_v2, so there is
  no hidden dependency. The runtime tests therefore use
  approvalContextFixture() without a staged proposal. Cost: one more fixture
  helper.
- stageCandidate's transaction becomes .immediate() so a cross-handle
  supersession waits on busy_timeout instead of failing with SQLITE_BUSY on a
  deferred upgrade. Cost: earlier lock acquisition during staging.
- durable_staged_at is removed from the candidate types and queries (ledger
  Task 5 leftover; its only reader is a cycle test). Cost: none.
- The interim projector (person-meeting-approval-projection-v1.ts) compares
  witness.action.project_ids instead of mapping project_id. The in-app V1
  reference uses frozen_card_sha256 = approved_snapshot_sha256 (the value the
  old in-app stage computed) and authorization_proof_sha256 over {actor,
  evidence}. Task 8 deletes both. Cost: none after Task 8.
- Task 7 builds on Task 6's committed fix 54dc4d1 (pending suggestions,
  recordAdmission, allowed()), not on the working tree the design panel saw.
  Cost: hash pins and the fixture must be derived from that commit.
- Base is 56ef4ba (Task 6 fix round 2, R28, committed; the worktree was clean
  when read). This revision replaces the earlier 54dc4d1 base. lane() keeps
  the 7-argument SqliteAuthorityMeetingProcessingStateV1 call, including
  afterCursorAdvance -> providerIntake.promoteConsumedImports. The per-source
  delegates of SqliteApprovalWorkflowStateV1 omit that hook because they never
  advance a cursor.
- NEEDS CONTROLLER LEDGER ENTRY (amends R23 for R28): the freeze keeps R23's
  two-parameter `suggestions(sourceKey, externalId)` and still adds no
  folder-project union. The runtime wires it to a new intake reader,
  `proposalSuggestions`. It returns the sorted union of
  authority_person_meeting_suggestions_v1 and the meeting's
  authority_person_meeting_pending_suggestions_v1 rows for projects the
  importer is still an active member of, which is the rule
  promoteConsumedImports applies. stage() runs before advanceCursor, so the
  pending half is exactly what the advance is about to record. A frozen
  suggestion is a pre-tick only and never a read grant: access stays on the
  insert-only table (R20/R26/R28). A cancel that lands after the freeze read
  but before the advance leaves a pre-tick and no grant. Moving the freeze
  into the afterCursorAdvance transaction was rejected: it would split staging
  from the stage result and re-couple the cycle to the stager.
- PROPOSED FOR CONTROLLER (spec acceptance 'One meeting, two projects'):
  freeze-at-stage stands (spec section 1). The acceptance test means both
  'Save to' choices are made before the proposal is frozen: queued together,
  or B chosen while A is being extracted. A 'Save to' made after the freeze
  records the suggestion (B's members can read the note) but does not change
  the frozen proposal, and the reviewer can still tick B. The runtime tests
  assert frozen [A,B] for the queued-together and in-flight cases and frozen
  [A] with recorded [A,B] for the after-staging case. Rejected alternative,
  local to the views if the founder wants it: undecided proposals show frozen
  plus later recorded suggestions, filtered to readable projects.
- Receipt storage (reverses revision 1's raw-receipt ruling): receipt_json is
  canonical JSON `{record_sha256, receipt}`. `receipt` is the signed record
  receipt verbatim, and the CHECK enforces that `$.record_sha256` equals
  `$.receipt.body.record_sha256`. APPROVAL_DECISION_RECORD_SHA256_PATH_V1 =
  '$.record_sha256', so the plan's Task 13 trigger SQL works unchanged and
  needs no brief amendment. Writers go through approvalDecisionReceiptJsonV1.
- NEEDS TASK 8 BRIEF AMENDMENT: after-record work runs inside the receipt
  transaction only when the receipt UPDATE returns changes === 1. The changes ===
  0 path checks that the stored $.record_sha256 equals the append's
  record_sha256 (and throws if not) and returns without running hooks. Task 7
  builds this as createInterimApprovalPublisherV1's onReceiptWritten and pins
  it with a two-handle test in which both publishers append before either
  writes a receipt (hook count 1). Task 8 swaps onReceiptWritten for
  after_record under the same rule.
- Presenter binding (decided now, built in Task 11): ApprovalCoreOptionsV1
  will gain `presenters?: readonly ApprovalPresenterFactoryV1[]` with
  `ApprovalPresenterFactoryV1 = (core: Pick<ApprovalCoreV1,'proposal'|'ownerProposals'>) => ApprovalPresenterV1`,
  and createApprovalCoreV1 calls each factory once with its own frozen core.
  Task 7 records this in the ApprovalCoreOptionsV1 doc comment and does not
  declare the type, to avoid dead code. The runtime passthrough
  `approval_core` is typed Pick<ApprovalCoreOptionsV1,'now'>, static options
  only; Task 8 widens it with after_record. Presenter instances never travel
  through it.
- Owner rule location: isApprovalOwnerTextV1, isApprovalSignalIdV1,
  APPROVAL_OWNER_MAX_CHARACTERS_V1 = 120 and APPROVAL_OWNERS_MAX_V1 = 40 live
  in packages/organization-protocol/src/approval-owner-choice-v1.ts, shared by
  decide(), ownerProposals and Task 8's codec. organization-processing cannot
  import organization-protocol, so a services test pins that
  canonicalProposedOwner output satisfies the predicate (R4 keeps the owner
  helpers in owner-proposals-v1.ts). ownerProposals returns [] above 40
  grounded proposals (R15).
- Runtime-wide state: SqliteApprovalWorkflowStateV1 routes each call to a
  per-source SqliteAuthorityMeetingProcessingStateV1 built from the configured
  cursor policy, so every existing frozen-row check stays in force. Sources
  whose adapter is not configured are invisible.
- ApprovalWorkflowContextV1 keeps `state`. ApprovalWorkflowComponentsV1 and
  ApprovalWorkflowBundleV1 are deleted (no implementer since Task 5), and
  source-boundary.v1.json names ApprovalWorkflowContextV1 instead.
- Revoked reviewers: a freeze for an inactive reviewer returns `revoked` and
  leaves the proposal queued. Views expose `reviewer_active`, and the reviewer
  trigger refuses any decision.
- Views filter the suggestions of undecided proposals to projects the reviewer
  can read now. Decided proposals show the decision's project_ids verbatim.
- stagerForSource(sourceKey) is added, so per-lane reconcile only touches its
  own source.
- Request validation (validateApprovalDecisionRequestV1) runs before
  authorization and reads nothing. A malformed request to a decided proposal
  gets invalid_request; well-formed losers get already_decided.
- NULL-safe CHECKs replace the brief's `= action` form, which accepted a body
  with no request.action.
- Supersession skips only proposals that have a decision row, and the
  decided_final trigger makes a decided proposal immutable.
- Until Task 9 the v1 route maps already_decided and stale to
  stale_access_state, and project_id to project_ids [] or [id] with owners [].
- Snapshot validation at freeze: validateApprovedDecisionSnapshotV2 runs
  before freezing. A refused snapshot leaves the proposal queued; the cycle
  advances the cursor (which records the consumed import's choices) and
  rethrows. Reconcile then re-freezes with the same suggestion set read from
  the recorded half.

### Design rulings, Task 8 (neutral proof, publisher, after-record hook)

From the Task 8 design panel, accepted as ruling R31.

- R-T8-1 Team refused: the neutral codec and projector accept only
  restricted-reviewer (Only me, project_ids []) and project-members-readable
  (1..20 projects). organization-member-readable is refused even when
  reference and event agree. This follows spec 1 ruling 2 and makes [] mean
  Only me with no ambiguity. Cost: test worlds move Team and reject records to
  the generic human-act V1 codec, which production still registers for
  captures.
- R-T8-2 Publisher signature: keep the brief's synchronous
  createApprovalPublisherV1(database, context, hooks). Signer inspection
  starts at construction (void-caught), is awaited on every pass, and is reset
  after a failure so the next pass retries. createApprovalCoreV1 keeps its
  Promise signature but no longer awaits the signer. This resolves Task 7
  minor 112 in favour of the brief.
- R-T8-3 Snapshot surface: APPROVAL_DECISION_SNAPSHOT_SURFACE_V1 =
  'echo-approval-core' moves to organization-protocol, approval-core-v1.ts
  aliases it as APPROVAL_SNAPSHOT_SURFACE_V1, and the codec refuses any other
  approved_payload.surface. This is defense in depth with no runtime import
  cycle.
- R-T8-4 The codec also requires audit_event_id === 'audit:' + command_id and
  binds the command to the surface: slack needs /^slack:[A-Za-z0-9._:-]+$/,
  desktop must not start with 'slack:', and both follow the Task 7 command
  pattern.
- R-T8-5 Witness shape (binding for Task 12): {decision: body.request verbatim
  (7 keys), evidence: {surface, organization_id, principal_id, membership_id,
  kind, sha256}, audit: {approval_id, event_id 'audit:'+command_id, sequence,
  action_sha256, authorization_sha256, approved_at}}. provider_action_sha256,
  authorization_proof_sha256 and audit_entry_sha256 are the canonical digests
  of the three parts.
- R-T8-6 One pure builder: buildApprovalDecisionRecordV1 (in
  approval-decision-projection-v1.ts) is the only way a decision becomes a
  record input. The publisher and the test fixture both use it.
- R-T8-7 One shared protocol list:
  services/organization-authority/src/composition/authority-record-protocols-v1.ts
  exports AUTHORITY_RECORD_INPUT_CODECS_V1,
  authorityRecordPolicyProjectorsV1() and
  AUTHORITY_RECORD_APPROVER_PROJECTORS_V1. The composition root, the test
  fixtures, the staging canary test and the eval harness import it instead of
  keeping copies. This file is in addition to the brief's file list.
- R-T8-8 Hook gating (R30(d) as built): hooks run inside the receipt
  .immediate() transaction only when its UPDATE changed exactly 1 row, in
  registration order, on the same handle. When it changed 0 rows, the
  publisher verifies that the stored $.record_sha256 equals the append result
  and runs nothing. A hook must return undefined, so an async hook fails the
  transaction. An idle-handle check runs before every receipt transaction.
- R-T8-9 Hook event: approval_id, record_sha256 (from the append result),
  reviewer {organization_id, principal_id, membership_id} and decided_at come
  from the signed reference (organization_id, final_approver, approved_at).
  The publisher asserts they equal the decision body's actor and decided_at.
  Task 13's trigger may rely on that equality (defect 4).
- R-T8-10 Transcript coordinate frozen at decide (amends Task 7, defect 3):
  ApprovalDecisionBodyV1 gains transcript_source, the retained coordinate that
  decide() already computes for an approve, or null for a reject. The
  publisher never reads retention, so every retry rebuilds identical bytes.
  There is no V12 schema change. A source erased after the decide still
  publishes; transcript readers serve nothing for an erased revision.
- R-T8-11 Zero-signal briefs (defect 2): the codec refuses an approved brief
  with no decisions, actions or rationales. decide() needs no change, because
  only actionable candidates (signals.length > 0) are ever staged
  (sqlite-authority-meeting-processing-state-v1.ts:336-341) and decide
  requires a staged proposal. A test pins that an Only-me transcript share
  publishes.
- R-T8-12 Lifecycle wake (defect 1): a publication pass that rejects, or a
  worker cycle that fails, still calls search.request() and
  requestApprovalPresentation() unless it was aborted or is closing, because
  per-row isolation means other rows may have published. Startup recovery
  stays fail-closed (the existing test is pinned). Task 13's hook must
  therefore be total.
- R-T8-13 R14 fixture rule: signed-slack-approval-v2.ts is moved with git mv
  to signed-approval-decision-v1.ts and keeps the SIGNED_APPROVAL_* export
  names. Array audiences go through the production builder. Team and reject
  records go through the generic human-act V1 codec. Lost 'mine' coverage is
  restored with explicit decision-proof Only-me records for EMP_B
  (meetingWorld gains an extra option), and the implementer reports every
  changed expectation.
- R-T8-14 pre-codec-slack-v4.json is deleted, not moved. Fail-closed
  composition is proven with an inline envelope of an unknown reference kind,
  so the grep gate needs no exceptions for tracked files.
- R-T8-15 Owner readers: all three (services person-meeting-items-v1.ts,
  organization-record record-retrieval-source-snapshot-v1.ts, desktop
  views.ts:491) keep reading action_owners by field and never branch on kind.
  Only the services reader changes logic: it now refuses a repeated signal id.
  The desktop reader is named but unchanged.
- R-T8-16 The Slack provider keeps its @echo-brain/organization-protocol and
  organization-record dependencies and tsconfig references, because
  tests/architecture/workspace-boundaries.test.ts:432-441 pins them. Only
  exports, entry points and canonical components are removed, and the deleted
  paths go into retired_source_paths. Task 16 prunes the dependencies if they
  are still unused.
- R-T8-17 after_record reaches production through the runtime passthrough
  Pick<ApprovalCoreOptionsV1,'now'|'after_record'> and a new approval_core
  option on openGranolaPersonLiveRuntimeV1. Task 8 registers no hook; Task 13
  adds one line at the composition-root call site. This closes Task 7 minor 111.
- R-T8-18 The codec registry copies validateInput onto its own frozen object,
  so `this.validateInput` would work. The new codec uses plain closures for
  clarity only; design 1's stated reason is corrected.
- R-T8-19 The grep gate runs over tracked files with git grep, after the stale
  gitignored dist outputs of the deleted modules have been removed and the
  workspace rebuilt. The brief's grep -rn is valid only after that cleanup.
- R1 Team audience: the approval-decision codec and projector refuse
  organization-member-readable (spec 1 ruling 2); [] always means Only me
  (restricted reviewer), 1..20 sorted prj_ ids means project-members.
- R2 Publisher signature: createApprovalPublisherV1(database, context, hooks)
  per the brief; signer inspection starts at construction, is awaited every
  pass and is not cached after a failure (resolves Task 7 minor 112 for the
  brief).
- R3 Snapshot surface constant APPROVAL_DECISION_SNAPSHOT_SURFACE_V1 =
  'echo-approval-core' lives in organization-protocol; approval-core-v1.ts
  aliases it as APPROVAL_SNAPSHOT_SURFACE_V1; no runtime cycle.
- R4 Witness shape {decision: body.request (7 keys), evidence (6 keys), audit
  (6 keys)}; Task 12 Slack decisions must produce the same shape.
- R5 Hook event fields (reviewer, decided_at) come from the signed reference
  and are asserted equal to body.actor and body.decided_at.
- R6 Hook synchrony (revision 2): async functions ([object
  AsyncFunction]/[object AsyncGeneratorFunction]) are refused with TypeError
  at registration in createApprovalPublisherV1 and therefore
  createApprovalCoreV1; at call time only a thenable return is refused, after
  its outcome is adopted with Promise.resolve(returned).catch(() =>
  undefined); any other return value (RunResult, number) is ignored.
- R7 transcript_source is frozen into ApprovalDecisionBodyV1 by decide()
  (non-null exactly for approve); publish never re-reads retention.
- R8 Zero signals: the codec refuses an approved brief with no signals;
  decide() needs no change because only actionable (>=1 signal) candidates are
  staged; the test fixture refuses a zero-signal approval-decision input with
  its own message.
- R9 Open-route fixture record 'zero' (revision 2): deleted together with its
  assertions at person-meeting-open-route.test.ts:75 and :192-195, because
  production can no longer write a zero-signal project-audience record; it is
  NOT converted to a generic Team record (that would silently change the
  asserted visibility); codec test 'refuses an approved brief with no signals'
  covers the refusal.
- R10 Lifecycle (revision 2): organization-authority-service-lifecycle.ts is
  not changed (outside the brief; tests :318-365 and :1035-1072 pin no wake
  after a failure). Spec 1 section 4 step 5 is met by the next successful
  publication pass (.then at :336-341) or cycle (onCycleComplete at :252-257).
  Startup recovery stays fail-closed.
- R11 Fixture rule: Team audiences and rejections in test worlds use the
  generic human-act V1 codec (still registered in production); lost 'mine'
  coverage is restored with explicit approval-decision Only-me records; every
  changed assertion is listed (file:line, old -> new or deleted).
- R12 List benchmark (revision 2): the 1,017 bench records become even index =
  approval decision by EMP_A with projects [] (index % 4 === 0) or [SHARED],
  odd index = generic Team by EMP_B, so emp_a's global and Mine pages both
  stay full (26 rows) and Mine still filters about half; no expect changes.
- R13 Slack package dependencies on organization-protocol and
  organization-record are kept (workspace-boundaries.test.ts:432-441); Task 16
  prunes them if unused.
- R14 ADR-0021 and ADR-0030 wording is left for the Task 16 docs sweep;
  INV-ADAPTERS-005:183 and docs/components/README.md:74 are updated in Task 8.
