# THERM evaluation world (`therm-v1`)

This folder holds the closed world the research-loop answer keys are written
against, plus the edits that turn the existing THERM mock into that world. It is
data only. Nothing here writes to Jira, Confluence or ECHO. The founder seeds
every change by hand and approves each write before it happens.

S0 starts from the founder's private export of 2026-10-06
(`~/Desktop/ECHO-Atlassian-Export-2026-10-06`, bound by its `manifest.json`).
That export is not committed. The files here hold only the additions and short
paraphrases, never copies of export pages.

## Files

| File | What it is |
| --- | --- |
| `additions.json` | The S0 additions: the ECHO project mapping, the restricted project, Jira due dates and assignments (`jira_updates`), one Confluence paragraph (`confluence_updates`) and six meetings (`meetings`). Each meeting has notes, a transcript (one array entry per `Name: text` line) and the records the approved version must contain (`expected_records`). `workspace` holds what the open-ended cases add: accounts, projects with members, roles and tool mappings, tools and follow-ups (see "Workspace" below). |
| `s1.json` | S1, the partial fixes the Sweep cases run against. `apply` moves S0 to S1 and `revert` restores S0. Description edits are exact find-and-replace pairs on the Jira description text, and `status` names the target workflow status. |
| `../cases/development.json` | Cases that tuning sessions may open. |
| `../cases/holdout.json` | Held-out cases. Tuning sessions do not open this file. That is a working rule, not access control. No other file quotes a held-out question, names a held-out case or gives its key: a test that needs them reads them from this file, and `npm run test:architecture` fails on a file that quotes one. |

The meetings are:

- **M1**: a discussion of a two-decimal display with no decision.
- **M2 (T1)**: the meeting that approves the two-decimal display.
- **M3 (T2)**: sets the DVT-R2 date and keeps the DVT gate on hold.
- **M4 (T3)**: decides BUG-412's likely cause and its fix owner.
- **M5**: only discusses when the sample boards will arrive.
- **M6**: the restricted supplier review.

Every person, the customer (Kestrel Valley Care) and the supplier (Corvane
Electronics) are fictional.

## `{{TEST_PERSON}}`

`{{TEST_PERSON}}` stands for the display name of the signed-in test person: the
PM whose ECHO session and Jira login run every case. Before seeding, replace it
everywhere with that account's display name. This covers the Jira assignee, the
meeting attendees, transcript lines, notes, expected records and the `must_not`
text in the cases.

- The same account runs every Ask, approved-record and Sweep case. It must be
  a member of the ECHO project `THERM` and approve M1 to M5. An approved-record
  run acts as the person who approved the record.
- It must not be a member of `THERM Supplier Review`. Approve M6 from a
  second account that belongs to that project only.
- Two actions mention `{{TEST_PERSON}}` but belong to Rafael Moreno (M3
  regression scope, M4 trace confirmation). Keep their owner as Rafael.

## Seeding (by hand, in this order)

1. Create the ECHO project `THERM` and map it to Jira project `10003` and
   Confluence space `1015812`. Create `THERM Supplier Review` with the test
   person excluded.
2. Apply `jira_updates` (five due dates, four assignments) and the
   `confluence_updates` paragraph. Note the page's new version number in a
   seed log.
3. Submit M1 to M6 through the normal intake and approval path, never
   directly into the database. Keep each meeting's listed date as the
   meeting date. If intake cannot keep that date, record the actual date,
   because several keys depend on these dates. Before approving, edit each
   record to match `expected_records`. Share each transcript to its own
   project.
4. Run the S0 cases (all Ask and approved-record cases).
5. For the Sweep cases only, apply `s1.apply`, run the Sweeps, then apply
   `s1.revert` and confirm that BUG-412 is In Progress and TRACE-01 is To Do,
   with no resolution on either.

The global-scope cases only meet the ECHO distractors if the test person can
reach Jira project ECHO or page 589865 through some other mapped ECHO project.
Record in the seed log whether they can.

Any edit to the THERM project, the THERM space or these meetings outside these
steps invalidates the keys. Jira `updated` timestamps and change history cannot
be reverted, but ECHO cannot read either of them.

## Workspace (open-ended cases)

The open-ended family (research tool contract v1) asks about the test person's
workspace: their projects and leads, their open follow-ups and owners, the
meetings those come from, and their tools. `additions.json` `workspace` is that
workspace; seed it after step 3 above, in this order.

1. **Accounts.** Invite the synthetic staging accounts `Mara Lindqvist` and
   `Rafael Moreno` with exactly those display names. No account in the
   organization may carry a leak marker (`Corvane`, `Priya Natarajan`,
   `Wen Hao`) as its display name, including the one that approves M6: the
   people source shows every account to the test person.
2. **Projects.** Give THERM its members and roles. Create
   `Kestrel Pilot Launch` (Mara a lead, the test person and Rafael members, no
   Jira or Confluence mapping) and `THERM EVT Archive` (the test person its only
   lead), then archive `THERM EVT Archive`. The test person must belong to no
   other project; record any other in the seed log, because the current-projects
   keys name exactly these.
3. **Follow-ups.** After approving M2, M3 and M4 (step 3 above), open each
   meeting's follow-ups and send them as `follow_ups` lists: each follow-up
   follows the ticket it names, with the owner it names (pick the owner where
   ECHO proposes none). Day 0 is the day you send. Leave F6 unsent. On day 1,
   reassign F3 to Mara Lindqvist and mark F5 done. Record both days in the seed
   log. If a meeting's impact card does not list a follow-up's ticket, record
   that too: the keys naming that follow-up then cannot hold.
4. **Tools.** The test person's Jira and Confluence stay connected. Slack is
   not keyed; record whether it is connected.

The meetings are submitted as synthetic meetings, which record no
participants: a key that asks who was in a meeting accepts "not recorded",
and charges only people named as participants who are neither recorded nor
speakers in the meeting's transcript.

## Reading the keys

- References name items by citation: `{ "ticket" }`, `{ "page", "section" }`
  (an exact h2 or h3 heading), `{ "meeting", "item" }` and the
  cross-project distractors `{ "jira_project": "ECHO" }` and
  `{ "page": "589865" }`. The open-ended cases add the workspace:
  `{ "project" }` and `{ "person" }` by exact name, `{ "tool" }` by tool id,
  `{ "container", "id" }` for a Jira project or Confluence space by its
  provider id (THERM's are `10003` and `1015812`), and `{ "follow_up" }` for a
  `workspace.follow_ups` entry, matched by the ticket it follows.
- An open-ended case is graded by code on its `reach` and cost, never on
  wording (`../README.md`, "Open-ended family").
- A part's `evidence` lists every item in this world that supports it. Any
  other item that research reads counts as noise.
- Approved-record cases add `affected`: the items the impact card should
  list, with the `relation` it should give and the `owner` their details carry.
  - Which items: every ticket, and each part's sections of a page (any of them
    counts), in the evidence of a `conflict` or `change` part or of a part that
    says the items agree, each listed once. Meeting items are not keyed: a card
    that lists one the case cites is neither credited nor charged.
  - Relation: the record's own text (its `expected_records`) decides.
    `confirms` when the item says what the record says or keeps (M2 keeps the
    ±0.1 °C accuracy, so the accuracy items confirm it); `conflicts` when it
    says something the record contradicts; `needs_updating` when the record
    changes or settles something it describes. A list of acceptable values is
    used only where the record's text supports both:
    - an item stating a fact the record replaces (one decimal, the SW-14c
      hypothesis, a firmware-only fix) is contradicted and out of date, so it
      accepts `conflicts` or `needs_updating`;
    - an item stating a rule or plan the record goes against without
      replacing it (the change-management order M4 skips) is `conflicts`
      alone;
    - an item the record agrees with and only adds to (an open decision M3
      gives an owner and a date) accepts `confirms` or `needs_updating`.

    A date the record puts at risk is the card's date at risk, not a
    relation.
  - Owner: the Jira assignee from `additions.json` (only THERM-47, 52, 53 and
    54 have one), and `null` for every other ticket and every page.
- A `list` part asks which items exist. Its `evidence` names every member
  of that list, each a whole item (a ticket, a page without a section, or a
  meeting item) and each once, and it scores only when the answer names all
  of them ([ADR-0041](../../../../docs/decisions/ADR-0041-complete-lists-as-ask-evidence.md)).
  Only Ask cases have one. The October 4 case keys every Confluence page the
  test person could read that was created on 2026-10-04: the 7 THERM pages and
  page 589865. Record in the seed log whether the test person can still read
  page 589865, and that no other page they can read was created that day. The
  Confluence BUG-412 case tells a list-only answer apart only through page
  589865, the one October 4 page that does not mention BUG-412.
- A case with `key_status: awaiting_founder_confirmation` has a key drafted
  from the export that the founder has not confirmed yet; the two BUG-412 cases
  are such cases. An Ask case's `expected_kinds` names the need kinds its plan
  should declare ([ADR-0041](../../../../docs/decisions/ADR-0041-complete-lists-as-ask-evidence.md));
  a plan that declares any other set of kinds fails the declared-kind check.
  Every held-out Ask case names them. Ask's step prompt teaches the kinds with
  examples that name nothing a case asks about: a new question that shares a
  name or a run of four words with them fails `npm run test:architecture`
  until one of them is reworded.
- `never_appears` lists the M6 items in every case. Any trace of them in a
  research result, the notes or an answer fails the run.
- THERM items carry "SYNTHETIC MOCK" banners. An answer that reports a mock
  result as recorded is correct. An answer that treats it as a real sign-off,
  or as evidence that the ECHO product passed a gate, fails.
