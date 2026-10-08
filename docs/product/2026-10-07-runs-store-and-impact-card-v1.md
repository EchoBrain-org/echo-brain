# Runs store and impact card v1

Status: designed on 2026-10-07 under the founder's instruction to take the
sprint end to end; the founder validates the built result. Every design choice
here was made on the founder's behalf and is listed under "Rulings made while
writing". Decision record:
[ADR-0032](../decisions/ADR-0032-stored-trigger-runs.md). Builds on
[unified meeting approval v1](2026-10-07-unified-meeting-approval-v1.md) and
the [research trigger contract v1](2026-10-06-research-trigger-contract-v1.md).
Implementation plan: `docs/superpowers/plans/2026-10-07-unified-approval-and-runs.md`.
Implementation plan executed; see the plan's As built section.

## Goal

When a person approves a meeting, on the desktop or in Slack, ECHO checks what
the approved record changes and shows the impact card next to the meeting on
the desktop. The check runs as the approver, with the approver's own access.

Sprint end state: approve → research runs with the approver's sign-in → the
impact card shows on the approved meeting in the desktop app.

## Product rules this design follows

- **Coordination, not execution.** The card says what an approval affects and
  who should know. ECHO never writes to Jira, Confluence or Slack.
- **Acts as the approver; only the approver sees it** (the trigger's `acts_as:
  approver` and `recipients: actor_only`).
- **No copies of outside text.** Slack's API terms forbid persistent copies of
  Slack data, and ECHO keeps no Jira or Confluence excerpts (RFC-0003,
  connector integration v1). A stored run therefore keeps pointers and ECHO's
  own judgments, never words read from outside ECHO.
- **Every view is a fresh release.** Access is checked again each time the
  card is shown; an item the viewer can no longer open is hidden.
- **Ask stays unstored.** The runs store holds background trigger outputs
  only.

## The shape

```
publisher writes the approved record
   └─ after-record hook (same Authority transaction as the receipt)
        └─ runs store: pending run {approved_record, approval_id, approver}

desktop (signed in as the approver) opens the meetings sheet
   └─ lists its runs → starts the oldest pending run
        └─ server: claim → find the record's citation → research loop
             → impact-card renderer → keep the storable form → done

desktop opens the approved meeting
   └─ view: re-open every cited item as the viewer → rebuild the outside
      parts from the fresh reads → show the card
```

## 1. The runs store

`authority_trigger_runs_v1`, in Authority baseline V12 (one reset with spec 1):

| Column | Meaning |
| --- | --- |
| `run_id` | `run_<uuid>`. |
| `trigger` | Trigger name from the definitions; `approved_record` only for now. |
| `event_ref` | What fired it: the approval id for `approved_record`. `UNIQUE (trigger, event_ref)`. |
| `organization_id`, `principal_id`, `membership_id` | The person the run acts as and the only person who may see it. |
| `record_sha256` | The approved record. |
| `state` | `pending`, `running`, `done`, `failed`. |
| `attempts` | Started attempts that ended without a result. |
| `lease_token`, `lease_expires_at` | Set only while `running`. |
| `result_json`, `result_sha256` | Set only when `done`: the storable card (section 4). |
| `error_code` | Set only when `failed`: `no_access`, `unavailable`, `timed_out`, `research_failed`. |
| `created_at`, `updated_at` | |

Database rules (triggers):

- Identity columns (`run_id`, `trigger`, `event_ref`, the actor, the record)
  never change; rows are never deleted.
- Allowed moves: `pending → running`, `running → pending | done | failed`,
  `failed → pending` (a person asks to try again). A `done` row is frozen.
- An `approved_record` row can only be inserted for an approval decision that
  has its receipt, with the same approver and record.

## 2. The trigger

The publisher's after-record hook (spec 1, section 4) inserts one `pending`
run for every approved record, in the same Authority transaction that writes
the receipt. Rejections create nothing. Because the hook runs exactly once per
record, so does the enqueue.

This replaces the research trigger contract's "Not in this round" line about
firing the approved-record trigger from real approvals: the founder chose this
sprint end state. Card quality is still unmeasured until the founder runs the
approved-record evaluation.

## 3. Running a run

Runs need a person's access token, and only the desktop holds one. So a run
starts when the approver is signed in to the desktop app:

- When the meetings sheet loads its reviews, the desktop lists the person's
  runs and starts the oldest `pending` one. It polls the list every 5 seconds
  while one of its runs is `running` and the sheet is open, then starts the
  next. An approval made in Slack is therefore checked the next time its
  approver opens the sheet.
- **Start** (server, one immediate transaction): the caller must be the run's
  actor (otherwise `not_found`). A `pending` run, or a `running` run whose
  lease has expired, becomes `running` with a new lease of 10 minutes. A
  `running` run with a live lease is returned as is. A person has at most one
  live `running` run; another start returns `busy`.
- **Work** (detached from the request, like the staging evaluation endpoint):
  1. Find the record's citation: the first atom of the approved record in the
     active readable search generation, read as the approver. If search has
     not indexed the record yet, the run goes back to `pending` without
     counting an attempt.
  2. Bind the live evidence desk with the approver's token. Scope: the
     record's single project, or everything the approver can read when the
     record is in no project or in several (the trigger's `record_project`
     rule; multi-project records search globally until the desk can scope to
     several projects).
  3. Run the `approved_record` definition through the research loop and the
     impact-card renderer, on the background budget, with the existing
     content-free research audit.
  4. Validate the card, turn it into its storable form (section 4) and finish
     `running → done` in one transaction, only if the lease is still this
     run's.
- **Failures:** a lost session or lost access → `failed (no_access)`. A
  timeout or cancellation, or a model or provider outage → back to `pending`
  until 3 attempts, then `failed (timed_out | unavailable)`. Anything else →
  `failed (research_failed)`. A failed run shows its reason and a "Try again"
  button, which moves it back to `pending` with its attempts reset.
- **Restarts:** a run left `running` by a crash is claimable again once its
  lease expires.

## 4. What is stored, and what a view shows

**Storable form** (a pure function next to the renderer): the card with every
piece of outside text removed.

| Card part | Stored | Rebuilt on view |
| --- | --- | --- |
| What was decided | Yes (ECHO's own record) | — |
| Affected item: relation, date at risk | Yes (ECHO's judgment) | The date is dropped if the item no longer states it. |
| Affected item: what it says now | Only for ECHO records and documents | Outside items: the first 300 characters of the item's current text on one line, or its title and details. |
| Owner, people to tell | No | From each item's current details. |
| Citations | The pointer only | Label and visibility for this viewer. |
| Couldn't confirm | Notes that name no outside item | A note that named an outside item is stored as a count ("2 items could not be read."). |
| Status (`assessed`, `not_assessed`) | Yes | — |

**View** (`view`, for `done` runs):

1. The caller must be the run's actor.
2. Bind a fresh desk with the caller's token and the scope from section 3.
3. Re-open every stored citation, the approved record included. A failed or
   empty open hides that row (or that decided line); the card says "N items
   you can no longer open are hidden."
4. Rebuild the outside parts from the fresh reads (table above), revalidate
   the desk, validate the card, and return it with the run's finish time.

Nothing from a view is written back.

## 5. The API and the desktop

**API** `POST /v1/person/runs`, one envelope `{schema_version: 1, operation,
…}`:

| Operation | Input | Result |
| --- | --- | --- |
| `list` | — | The caller's runs, newest first, at most 100: `{run_id, trigger, event_ref, state, error_code, created_at, updated_at}`. |
| `start` | `run_id` | `{state}` (`running`, `pending` when search is not ready, `busy`, or the final state). |
| `retry` | `run_id` | `{state: 'pending'}` for a failed run. |
| `view` | `run_id` | `{card, checked_at, hidden}`. |

It is composed next to the Ask services and needs only a configured model. A
server without a model answers `unavailable`, and runs stay `pending`.

**Client and desktop:** one CLI verb, `runs --request <json>`, one host method
`runs`, following the meetings command pattern. On an approved meeting's card
in the meetings sheet, an **Impact** section shows:

- `pending`: "Impact check queued."
- `running`: "Checking what this changes. This can take a few minutes."
- `done`: the card, with "What was decided", "Affected items" (relation, what
  it says now, owner, date at risk, and "Open in Jira / Confluence / Slack" for
  outside items), "Couldn't confirm", "People to tell", the check time and the
  hidden count.
- `failed`: the reason in plain words and "Try again".

## Acceptance

- Approving writes exactly one `pending` run in the receipt's transaction; a
  rejection writes none; a crash between append and receipt still yields one
  run.
- Only the approver can list, start, retry or view a run; anyone else gets
  `not_found`.
- Two starts never run the same work twice; a person never has two live runs.
- An unindexed record sends the run back to `pending` without an attempt.
- The stored result contains no text, label or name read from an outside item
  (a test seeds distinctive outside text and searches the stored row for it).
- A view hides an item the viewer lost, refreshes outside text and owners from
  the current item, and drops a date the item no longer states.
- A run left `running` is picked up after its lease expires; failures follow
  section 3.
- Desktop: approving a meeting in the test Authority shows the Impact section
  move from queued to the card.
- Ask goldens unchanged; `npm run check` passes.

## Not in this round

- Runs started without the approver's desktop (delegated background access).
- Showing results to anyone but the approver, or in Slack.
- Open items and Sweep (spec 3).
- Notifications when a card is ready.
- Re-running a done run.

## Rulings made while writing

1. Stored runs keep pointers and judgments, never outside text; outside parts
   are rebuilt on every view. (Storing the whole card would copy Slack text,
   which Slack's terms forbid, and Jira and Confluence excerpts, which ECHO
   does not keep.)
2. A run starts only from the approver's signed-in desktop; Slack approvals
   are checked when the approver next opens the meetings sheet.
3. One live run per person, a 10-minute lease and 3 attempts.
4. An unindexed record retries without counting an attempt.
5. The product trigger is on wherever a model is configured; there is no
   separate switch.
6. A multi-project record is checked across everything the approver can read.
7. "Try again" resets the attempt count.
8. The Impact section lives on the approved meeting's card in the meetings
   sheet, next to where the approval happened.
