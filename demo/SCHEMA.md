# Canonical meeting record used by this demo

The target contract is `MeetingDocument` v1 from the provider-neutral core. A
real meeting provider and this synthetic source must cross the same boundary.

## Top-level fields

| Field | Required | Meaning |
| --- | --- | --- |
| `schema_version` | Yes | Must be `1`. |
| `id` | Yes | Stable canonical meeting ID. |
| `provenance` | Yes | Source identity, source record ID, revision, observation time, and normalizer version. |
| `capture` | Yes | Overall capture state and per-component availability. |
| `participants` | Yes | Participant records; the array may be empty when the source supplies none. |
| `content` | Yes | Summaries, notes, transcript turns, chat, and other evidence blocks. |
| `artifacts` | Yes | Referenced files/recordings; use an empty array when there are none. |
| `title` | No | Meeting title. |
| `description` | No | Meeting description. |
| `lifecycle` | No | Scheduled, active, completed, cancelled, deleted, or unknown. |
| `time` | No | Scheduled/actual times, timezone, and all-day flag. |
| `context` | No | Owner, calendar, location, scopes, labels, language, and meeting type. |
| `governance` | No | Sensitivity, consent, retention, deletion, and redaction facts. |
| `extensions` | No | Provider-specific JSON that cannot be represented canonically. |

## Required nested fields

- `provenance.source`: `kind: "meeting-source"`, `adapter_id`, `instance_id`,
  and `version`.
- `provenance`: `external_id`, `canonical_revision`, `observed_at`, and
  `normalizer_version`.
- `capture`: `state` and `components`.
- Each capture component: `kind` and `state`.
- Each participant: `id`.
- Each content block: `id`, `kind`, and non-empty `text`.
- Each artifact: `id`, `kind`, and `availability`.

Everything else nested under those objects is optional, but the validator rejects
unknown keys rather than silently accepting a near-canonical shape.

## Cross-reference and formatting rules

- Participant, content-block, and artifact IDs must be unique in one meeting.
- `speaker_participant_id`, `author_participant_id`, calendar organizer, and
  `context.owner_participant_id` must resolve to a participant in the same record.
- An artifact reference on a content block must resolve to an artifact in the
  same record.
- Canonical timestamps must be exact UTC ISO strings, for example
  `2026-08-24T16:00:00.000Z`.
- Numeric sequences and offsets must be non-negative integers; start cannot be
  after end.
- Confidence, when present, must be between `0` and `1`.
- Metadata and extensions must contain JSON values only.
- When the processor expects a particular source adapter, the complete source
  identity must match it.

## Demo-specific requirement

`context.owner_participant_id` is optional in the general canonical schema, but
it is required for this demo because the runtime must resolve one private Slack
approval recipient. Here it is always `zhen`, and that participant must have
exactly one canonical lowercase email identity. Replace only
`owner@example.test` before a staging run.

Approval policy, expected extracted facts, expected answers, and Slack IDs do not
belong in a meeting record. The policy is chosen in Slack after extraction, and
the evaluation oracle remains in `expectations.json` outside the runtime input.
