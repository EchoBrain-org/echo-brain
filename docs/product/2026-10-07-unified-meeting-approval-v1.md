# Unified meeting approval v1

Status: design approved in conversation on 2026-10-07 (sections 1 to 4). The
founder waived the written-spec review and will validate the built result.
Decisions made while writing are listed at the end under "Rulings made while
writing". Decision record: [ADR-0031](../decisions/ADR-0031-unified-meeting-approval-core.md).
Companion spec: [runs store and impact card](2026-10-07-runs-store-and-impact-card-v1.md).
Implementation plan: `docs/superpowers/plans/2026-10-07-unified-approval-and-runs.md`.
Implementation plan executed; see the plan's As built section.

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
