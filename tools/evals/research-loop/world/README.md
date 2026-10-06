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
| `additions.json` | The S0 additions: the ECHO project mapping, the restricted project, Jira due dates and assignments (`jira_updates`), one Confluence paragraph (`confluence_updates`) and six meetings (`meetings`). Each meeting has notes, a transcript (one array entry per `Name: text` line) and the records the approved version must contain (`expected_records`). |
| `s1.json` | S1, the partial fixes the Sweep cases run against. `apply` moves S0 to S1 and `revert` restores S0. Description edits are exact find-and-replace pairs on the Jira description text, and `status` names the target workflow status. |
| `../cases/development.json` | Cases that tuning sessions may open. |
| `../cases/holdout.json` | Held-out cases. Tuning sessions do not open this file. That is a working rule, not access control. |

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

- The same account runs every Ask, Check and Sweep. It must be a member of
  the ECHO project `THERM` and approve M1 to M5. A Check acts as the person
  who approved the record.
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
4. Run the S0 cases (all Ask and Check cases).
5. For the Sweep cases only, apply `s1.apply`, run the Sweeps, then apply
   `s1.revert` and confirm that BUG-412 is In Progress and TRACE-01 is To Do,
   with no resolution on either.

The global-scope cases only meet the ECHO distractors if the test person can
reach Jira project ECHO or page 589865 through some other mapped ECHO project.
Record in the seed log whether they can.

Any edit to the THERM project, the THERM space or these meetings outside these
steps invalidates the keys. Jira `updated` timestamps and change history cannot
be reverted, but ECHO cannot read either of them.

## Reading the keys

- References name items by citation: `{ "ticket" }`, `{ "page", "section" }`
  (an exact h2 or h3 heading), `{ "meeting", "item" }` and the
  cross-project distractors `{ "jira_project": "ECHO" }` and
  `{ "page": "589865" }`.
- A part's `evidence` lists every item in this world that supports it. Any
  other item that research reads counts as noise.
- `never_appears` lists the M6 items in every case. Any trace of them in a
  research result, the notes or an answer fails the run.
- THERM items carry "SYNTHETIC MOCK" banners. An answer that reports a mock
  result as recorded is correct. An answer that treats it as a real sign-off,
  or as evidence that the ECHO product passed a gate, fails.
