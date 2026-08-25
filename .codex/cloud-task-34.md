## Issue

Closes #34

## Outcome

Add a stopped-state, operator-only way to preview bounded pending Granola note
metadata without mutation, then qualify one exact previewed note through the
existing immutable intake and approval path.

## Root cause

The live worker currently selects the next note through the normal pull path.
That path can fetch content, invoke processing, and stage Slack approval state
before an operator can confirm which note is being rehearsed. There is no
supported preview identity or exact-note qualification path.

## Lean V1 implementation constraints

- Preview only sanitized selection metadata: stable provider note ID, a
  deterministic revision/identity, ordering or update time, and title only when
  the existing policy explicitly permits it.
- Preview must not write a cursor, candidate, approval, Slack, Layer 1, or Layer
  2 fact; fetch transcript content; invoke a model; or expose pagination tokens,
  prompts, credentials, or provider payloads.
- Exact qualification must accept an identity returned by preview, fetch only
  that provider note, revalidate the exact ID and metadata revision, enforce the
  admitted post-onboarding cutoff, reject an already-frozen canonical revision,
  and then reuse the normal candidate/Slack/approval pipeline.
- Missing, changed, pre-cutoff, or already-consumed notes must fail before any
  model, Slack, cursor, or record mutation. Never fall back to a nearby note.
- Keep normal automatic intake unchanged. Do not add compatibility paths.

Likely code and tests:

- `services/organization-authority/src/processing/adapters/meeting-sources/granola/`
- `services/organization-authority/src/processing/clean-v1/`
- the stopped-state founder/live CLI composition
- focused Granola adapter, live-only source-cycle, admission, and command tests

## Required proof

Write the focused tests red first, covering:

1. sanitized preview with zero state/model/Slack writes;
2. exact identity selects only the requested note and uses normal staging;
3. missing ID, changed revision, pre-cutoff note, and frozen revision all fail
   without side effects; and
4. output excludes transcript, prompt, model response, provider cursor, and
   credentials.

Run focused tests and `npm run check`. Self-review the final diff for correctness
and scope. Update this pull request with root cause and exact proof. Delete this
temporary task file before the final commit. Do not deploy, call AWS/SSM, access
live Granola or Slack, merge the PR, or close the issue directly.
