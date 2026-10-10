# Meeting extraction from numbered units (v1)

Date: 2026-10-10. Status: implementing on `feat/meeting-extraction-units`. The
founder delegated the work end to end and validates the result.

## Why

Two numbers from 2026-10-10:

- **Staging, last 14 days.** 0 of 5 real-length meeting versions passed
  extraction. Every synthetic canary and fixture passed.
- **Side by side on 9 of the founder's real Granola meetings.** Same model.
  - Today's extractor delivered 1 item out of 62 the model found. One meeting
    of nine reached an approval card.
  - A prototype of this design delivered 80 of 87 items, and all nine
    meetings reached a card.
  - A second model pass judged none of the delivered items unsupported in
    either design.

Two causes compound:

1. **The model gets two shapeless blocks.** For Granola, that is one block
   holding the participant list, private notes and the AI summary, and one
   holding the whole transcript. It has no date and no names. The prompt then
   asks for one exact, contiguous quote per block. Ideas spread across a call
   force the model to copy long passages, cite a block twice, or join passages.
2. **Any one flawed item rejects the whole meeting.** What the exact-quote
   check proves is narrow: that the quoted text exists in the meeting. It does
   not prove the quote supports the item.

## What changes

Four parts, behind the existing contracts: `MeetingDocument` in, `DecisionSet`
out. The approval core, the record and every surface stay as they are.

### 1. Sources fill the shared format (Granola mapping)

The Granola MCP mapping fills fields it currently drops:

- **Meeting date.** Parsed from Granola's date label ("Oct 2, 2026 8:08 PM
  PDT") into `time.actual_start_at` and an IANA time zone. Known US
  abbreviations and UTC/GMT are supported. An unknown abbreviation leaves the
  time empty rather than guessing.
- **Participants.** Built from `known_participants` ("Name (note creator) from
  Org <email>, …") into structured participants with no role: Granola's list
  proves neither identity nor attendance. Each entry ends at its `<email>`, so
  commas inside names or organizations do not split it. An email is kept only
  when it is a canonical person email. The raw text is kept as
  `provider_fields.mcp_known_participants` and no longer appears as quotable
  meeting content.
- **Separate blocks with the right origin.** The person's private notes become
  their own block (`note`, origin `human`). Granola's AI summary becomes its
  own block (`summary`, origin `source_ai`).

The transcript stays one block. Splitting it is the shared step's job, so
pasted and uploaded transcripts get the same treatment. The normalizer version
goes from 2.2.0 to 2.3.0.

### 2. A shared preparation step (new, vendor-neutral)

New module: `organization-processing/src/core/processing/meeting-evidence-units-v1.ts`.
It is pure, reads only `MeetingDocument`, and never branches on the source.

- **Header.** Title, the meeting's local date and time zone (when known), and
  participant names.
- **Units.** Each unit is a short, numbered span of one block.
  - Every unit records its block ID and character offsets, and its text is
    exactly `block.text.slice(start, end)`.
  - **Transcript-like blocks** (`transcript`, `caption`, `chat_message`)
    become turns:
    - A block with a known speaker is one turn.
    - Otherwise, a line beginning `Label: ` starts a new turn, and unlabelled
      lines continue the current one.
    - Consecutive turns with the same label merge up to about 400 characters.
    - Turns over about 600 characters split at sentence ends, including
      Chinese and Japanese punctuation.
  - **Notes and summaries** split into one unit per non-empty line.
    - Markdown headings become the section label of the units under them and
      are not units themselves.
    - Bullet markers are left out of the unit span.
    - Long lines split at sentence ends.
  - **Hard cap.** No unit is longer than 600 characters. A part still over 600
    after sentence splitting is cut at its last whitespace before 400
    characters, else at 400 characters without splitting a surrogate pair.
    Same-speaker turns stop merging before the merged span passes 600.
- **ID prefixes.** `T` for transcript turns, `N` for notes written by people
  (including documents), `S` for anything written by a tool's AI (`summary`,
  origin `source_ai`, `chapter`, `provider_action_item`, `provider_decision`).
  IDs number in reading order. Split parts get `T12.1`, `T12.2`.
- **Nothing to extract from.** A meeting with no units returns an empty
  decision set without a model call. That is the existing `no_signals` path,
  with no spend.

### 3. Extraction cites unit IDs (prompt v11)

- **Input.** Plain text, not escaped JSON: the header, then one section each
  for notes, AI summary and transcript, with one `[ID] text` line per unit.
  Unit text is shown with whitespace collapsed, so meeting text cannot fake an
  extra unit line.
- **Citations.** The model cites `evidence_units: ["T12","T14"]` instead of
  copying quotes. It is told to prefer transcript and notes units, and to cite
  AI-summary units only when nothing else supports the item.
- **Everything else is unchanged:** item kinds, statuses, owner rules, date
  rules and rationale links.
- **Versions.** The adapter goes to 2.0.0, the prompt to
  `decision-extraction-v11`, and the schema to `decision-extraction-schema-v8`.
  Model, token limit and timeout are unchanged.

### 4. Each item is checked on its own

| Check | Result |
|---|---|
| A cited ID differs only in case, or names a split unit's parent (`T12` for `T12.1`, `T12.2`) | Read it in upper case; a parent ID cites all its parts. |
| An item cites at least one unknown ID but also valid ones | Drop the unknown IDs and keep the item. |
| An item cites more than six units | Keep the first six in citation order. This bounds the approved record, which is limited to 256 KiB. |
| An item cites no valid unit | Set aside (`evidence_id`). |
| A rationale links to no surviving decision | Set aside (`rationale_supports`). |
| Two items have the same kind, text and units | Keep the first. A rationale linked to the dropped copy links to the kept one. |
| A decision marked decided cites only questions | Downgrade it to proposed. |
| A due date is unparsable or falls before the meeting date | Clear the due date and keep the item. |
| An owner is not grounded | Clear the owner, as today. The owner is kept when a cited unit names them, or when the cited speaker label is that person committing in the first person. |
| The answer is not JSON, or its top level is wrong | Fail the meeting, as today. |
| The answer had items but every one was set aside | Fail the meeting with the first item's reason. The existing parking path applies. |

Evidence spans come from the units: one span per cited unit, with
`quote = block.text.slice(start, end)`. Records and cards stay verbatim, and
the canonical decision-set check still passes unchanged.

Set-aside items go to the private diagnostic capture from #314, never to
operational metadata.

## What stays

- **Attempt ledger, parking and cursor.** One paid attempt per input; parking
  and cursor behavior are unchanged.
- **Failure-stage allowlist.** These stages are no longer produced but stay
  listed, because the V14 table's CHECK constraint and the pre-Slack evaluator
  depend on the list: `evidence_quote`, `evidence_duplicate`,
  `due_before_meeting`, `decided_question_only`, `schema_due_at`,
  `schema_confidence`, `schema_supports`, `schema_evidence_item` and
  `schema_owner`.
- **Downstream.** The approval core, snapshots, Slack and desktop surfaces, and
  the record are unchanged, with one Slack presenter fix: a card that cannot
  be built marks only its own row unrepresentable (or backs it off once
  posted) instead of stalling every later card. Real meetings now yield 10–25
  items, which made that stall reachable.

## Deploy consequence

- **Every LLM-processed source stops until reset.** The extractor's processing
  version is part of each source's admitted processor commitment, and the
  per-pass check compares processor commitments only. Every source admitted
  under the old extractor fails that check. That includes the synthetic
  staging source, so the release canary fails until the reset, and any
  non-staging Authority with admitted sources, such as founder-live.
- **Every Granola meeting gets a new revision.** The normalizer bump changes
  each meeting's canonical revision.
- **Staging needs the fresh-state reset.** This is the same human-lane reset
  as V14: `replace-rehearsal`, then onboarding. After it the canary produces a
  staged card again, because its one-sentence blocks become units N1–N3 and T1.
- **Reset before any watched folder runs.** The new Granola revision would
  otherwise make every folder meeting look changed and get extracted again.

## Deferred

These were observed or found, but are out of this change:

- **Owner-facing visibility.** Held meetings on Home and self-serve retry. The
  founder is doing this in a separate session.
- **HTTP 402 handling.** Out-of-credit replies park each meeting as
  `permanently_rejected` with no free retry. This was observed on Oct 3 and
  again today. It needs a provider-unavailable rule that spends no attempts.
- **Folder scan.** One bad note fails the whole folder scan.
- **Model refusals.** One defense-topic meeting was refused outright.
- **Processor changes.** A processor change needs a reset instead of
  re-admission.
- **Recall.** What both designs miss has not been measured.

## Proof

- **Focused tests** for each part, then `npm run check` on the final
  candidate.
- **Real-meeting rerun.** One run of the shipped new path (production Granola
  mapping, preparation step and extractor, plus the support judge) on all 12
  real meetings. It is compared with the earlier measurement of today's path
  on 9 of them. OpenRouter credit, which ran out on 2026-10-10, allows only
  this one run.
- **Draft PR** with results, line-count deltas, and the reset note.

## Tasks

1. Preparation module and tests.
2. Granola mapping and tests. This can run in parallel with task 1.
3. Extractor v11: prompt, schema, per-item checks, evidence from units, and
   tests. Depends on task 1.
4. Repository fixups: cycle and evaluator tests, OpenRouter config hashes,
   docs. Then the full check.
5. Rerun of the real-meeting evaluation, then the PR.
