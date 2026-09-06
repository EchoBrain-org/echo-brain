# Echo demo runbook

## Outcome

Show four things in one closed loop:

1. Realistic meeting intake.
2. Reasoning across related meetings the user did not need to locate or search.
3. Evidence-backed record approval and visibility selection in a private Slack approval.
4. High-quality, cited, permission-aware retrieval in Ask ECHO.

The customer sees Slack and Ask ECHO only. Do not show fixture files, extraction
logs, state databases, indexing commands, or an internal approval dashboard.

## Prerequisites

- Run only in the isolated staging environment.
- Use the runtime containing canonical `context.owner_participant_id`, private
  owner-DM approval, approved V4 record publication, search reconciliation, and
  Ask ECHO answer composition.
- Configure the synthetic source identity as
  `synthetic-demo-source/customer-demo/1.0.0`.
- Replace `owner@example.test` in all meetings with one lowercase staging member
  email that resolves to an active Authority membership and linked Slack user.
- Keep the real meeting provider cursor untouched.
- Use a fresh scenario/revision namespace when rerunning a previously terminal
  demo so the runtime does not correctly treat it as an idempotent replay.
- Verify the Ask ECHO team user is an active organization member. That identity
  plays Audrey, the account newcomer, in every team-visible ask. For the
  privacy proof, use that team user and the exact owner/approver as two distinct
  principals.

## Main question

Use the exact same wording before and after approval:

> Can we promise Echo that all 28 locations will be live on September 16? What can we safely commit to, what must happen first, and what work remains by when?

The wording intentionally omits the meeting titles and internal phrases such as
"adoption gate", "data-processing addendum", and "capacity triage".

## Runtime commands

The direct commands below are for an already isolated operator environment.
The EC2 staging-host switchover lane was retired with the AWS staging slot on
2026-09-06.

Use the same absolute isolated state and personalized meeting-copy paths for
admission and service startup:

```sh
npm run build

node services/organization-authority/dist/synthetic-demo-main.js admit \
  --state-dir /absolute/path/to/demo-state \
  --meetings-dir /absolute/path/to/personalized-meetings

node services/organization-authority/dist/synthetic-demo-main.js serve \
  --state-dir /absolute/path/to/demo-state \
  --meetings-dir /absolute/path/to/personalized-meetings \
  --host 127.0.0.1 \
  --port 8787 \
  --slack-signing-secret-file /absolute/path/to/slack-signing-secret
```

If that state's OIDC manifest uses client-secret authentication, also pass
`--client-secret-file /absolute/path/to/oidc-client-secret` to `serve`. The state
must already be bootstrapped and onboarded with its own setup manifest, owner,
Slack connection, and identity link. A startup result other than
`processing: "active"` is a stop condition.

## Preparation before the customer joins

1. Validate all four JSON documents against the canonical MeetingDocument runtime
   validator and the configured synthetic source identity.
2. Confirm every transcript block's speaker reference resolves to one participant.
3. Confirm `zhen` has exactly one canonical email and is the
   `context.owner_participant_id` in every meeting.
4. Confirm the three Team meetings and the Only-me meeting use distinct stable
   external IDs and revisions.
5. Confirm no expected signal or expected answer from `expectations.json` enters
   the extraction, retrieval, or answer context.
6. Confirm each Slack DM groups decisions with linked **Why** rationale, keeps
   owner-neutral actions under **Next steps from this meeting** without a
   duplicate machine-formatted due-date row, labels any unlinked rationale as
   **Additional meeting context**,
   preserves evidence and the non-release statement in the complete plain-text
   alternative, and retains the Only me/Team selector.
7. Confirm Ask ECHO exposes human-readable source context for cited facts.

## Customer-facing sequence

### Step 1: introduce Audrey and the old workflow

Say:

> Audrey joined the Echo account team this week and covers the call with
> Echo's executive sponsor in five minutes. The answer Audrey needs is spread
> across four ordinary meetings Audrey did not attend. With a traditional meeting
> tool, Audrey would first need to know those meetings happened, guess their titles
> or vocabulary, search them separately, and reconcile their conclusions — in the
> next five minutes.

Do not show another meeting product. Audrey's situation supplies the comparison.

Value shown: the asker needs no meeting identity, no prior knowledge of
existence, and no exact keywords.

### Step 2: ingest in the background

Admit the four canonical meeting documents through the synthetic meeting-source
adapter. The shared production Claude processor extracts candidates and the
normal private-DM stager resolves the meeting owner through the canonical owner
identity.

Nothing from this step is customer-facing.

Value shown: the demo uses the same normalized input and downstream runtime as a
real provider; only the source and meeting content are synthetic.

### Step 3: glimpse the pending approvals

Open the meeting owner's private Slack DMs just long enough to show that four
approval cards have arrived, then close them without approving anything.

Value shown: the knowledge already exists — extracted and waiting for approval —
but no human has admitted it as organizational truth yet. This framing makes the
next step's refusal read as governance rather than absence.

### Step 4: ask before approval

In Ask ECHO, as Audrey, ask the main question.

Required answer behavior:

> Insufficient accessible evidence to answer this question.

It must not reveal meeting titles, people, dates, locations, gates, pricing, or
even the existence of hidden records. It must return no citations.

Value shown: unapproved meeting content is not organizational knowledge. Because
the customer has just seen the pending cards, the empty answer reads as truth
withheld pending human approval, not as a product with nothing to say.

### Step 5: review the private Slack DMs and approve

Return to the linked meeting owner/approver's private Slack DM. For each meeting,
verify that the card shows:

- meeting title;
- exact extracted decisions, actions, and rationales;
- action dates;
- a short evidence excerpt or transcript-turn reference;
- a clear statement that raw transcript and rejected suggestions are not released;
- Only me and Team visibility choices;
- Approve and Reject controls.

Approve these records for **Team**:

1. Revenue signal calibration.
2. Data handling review.
3. Implementation capacity triage.

Approve Commercial exception review as **Only me**.

Value shown: a human controls both truth admission and audience at the moment the
knowledge is created. The linked meeting owner is the approver. Transcript
speakers are not presented as decision-makers or action assignees. Downstream PM
tools assign the action work.

### Step 6: ask the same question after approval

As Audrey, ask the exact main question again.

The answer must communicate all of the following without inventing facts:

- No, all 28 locations should not be promised for September 16.
- September 16 is a conditional onboarding window for the first 10 locations.
- Before the first 10 receive production access, the revised data-processing
  addendum (DPA) must be signed, the Echo security contact must be verified,
  and implementation readiness must pass the September 12 review.
- Later expansion requires at least 8 of 10 locations to complete four
  consecutive weekly workflows without manual correction.

Every material claim must cite the correct one of the three Team meetings.

Value shown: ECHO combines complementary facts across meetings and different
vocabularies into a current, actionable answer.

### Step 7: prove visibility enforcement

As Audrey, ask:

> What special price did Echo receive?

Required answer: `Insufficient accessible evidence to answer this question.`,
with no citations and no hint that a private price exists.

Then ask the same question from the exact owner/approver's authenticated ECHO
account.

Required answer:

> Echo received a $22-per-location rate for the initial 10 locations during
> the 30-day evaluation only. Standard pricing resumes afterward unless Finance
> approves another exception.

The answer must cite Commercial exception review.

Value shown: approval does not mean global disclosure. The selected policy is
enforced at retrieval and answer time.

### Step 8: use supporting queries only if useful

Use `QUERIES.md` to choose one or two short follow-ups based on the customer's
interest. The readiness query is best for operational value; the expansion query
is best for the adoption rule and rationale. Do not turn this into a long prompt parade.

Value shown: ECHO answers questions about current work and organizational truth;
the meetings remain evidence in the background.

### Step 9: close on the thesis

Return to the hero answer on screen and end with one sentence:

> Every fact in this answer was admitted by a named final approver, cited to its
> evidence, and scoped to what you are allowed to see.

Do not follow this with another query. The last thing the customer sees is the
hero answer and this claim, not a prompt parade.

## The approval-cost objection

Expect the question: "So I have to approve every meeting by hand in Slack?"
Answer it directly rather than deflecting:

- Approval is per-decision knowledge admission, not meeting review. The card
  already contains the extracted decisions, actions, dates, rationale, and
  evidence; reading it and choosing a visibility takes seconds per meeting.
- The owner approves once. After that, nobody downstream re-derives, re-checks,
  or re-shares the fact by hand.
- That human moment is exactly what makes the answers trustworthy enough to act
  on. Remove it and ECHO becomes another summarizer whose output must be
  verified before use.

## Expected final rollout answer

Wording may vary, but the facts may not:

> No. September 16 is a conditional onboarding window for Echo's first 10
> locations, not a commitment to all 28. Before those 10 receive production
> access, the revised data-processing addendum must be signed, Echo's named
> security contact must be verified, and implementation readiness must pass the
> September 12 review. Later expansion requires at least 8 of the first 10 to
> complete four consecutive weekly workflows without manual correction.

## Pass/fail gate

The demo passes only when all checks below are true:

- [ ] Four canonical meetings validate without a demo-only runtime schema.
- [ ] Every meeting contains 3-5 participants and natural attributed dialogue.
- [ ] No runtime meeting contains extraction labels or expected outputs.
- [ ] The correct canonical owner receives each private DM.
- [ ] Each DM displays the complete approval bundle and evidence.
- [ ] The all-28 suggestions are not represented as approved/current decisions.
- [ ] Before approval, the main question returns no facts or citations.
- [ ] After Team approval, the main answer contains every required proposition.
- [ ] Each proposition cites the correct source meeting.
- [ ] No answer uses an unapproved transcript or fixture-only retrieval atom.
- [ ] The normal team member cannot learn the private price or that it exists.
- [ ] The exact Only-me approver can retrieve the private price.
- [ ] Repeating either query is deterministic for the same record generation.
- [ ] The hero question returns the required answer in at least six consecutive
      post-approval trials (DF-L4-001 guard).

If any check fails, do not narrate around it. Treat it as a product gap and stop
the customer rehearsal until the root cause is fixed.
