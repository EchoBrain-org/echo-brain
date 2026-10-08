# Task 11 handoff

## Delivered

- Added the V12 Slack presentation table, immutable target/message trigger, and updated every V12 hash pin.
- Added V4 Slack cards (Only me/Projects, selected-project prefill, owners, transcript checkbox, snapshot-bound buttons) and closed-card copy.
- Added the Slack presenter with bounded scans, persisted retry/backoff, marker recovery, concrete DM channel persistence before the marker post, and terminal redraws.
- Added core presenter factories and personal-runtime/lifecycle wiring; composition resolves the active Slack connection and reviewer identity link, then provides the concrete poster/token path.

## Test chronology

I did not capture the brief's requested RED phase before the initial implementation. This is a process gap, not retroactively represented as TDD.

I then added focused tests. The first V4 run failed because V1 fallback text still said `Team`; the card now replaces that copy. A later presenter RED run found an ambiguous `approval_id` SQL selection and showed the retry gate was absent. The implementation now qualifies the query and honors `retry_at`; its crash-left `posting` case calls marker reconciliation rather than reposting.

GREEN:

```text
npx vitest run --config vitest.config.ts packages/organization-authority-kernel/test/adapters/persistence/sqlite/authority-baseline-v12.test.ts services/organization-authority/test/approval-decision-schema.test.ts services/organization-authority/test/approval-core-v1.test.ts providers/slack/server/test/private-approval/slack-approval-card-v4.test.ts providers/slack/server/test/private-approval/slack-approval-presenter-v1.test.ts
# 5 files, 67 passed
npx eslint [Task 11 changed TypeScript files]
npx tsc -b packages/organization-authority-kernel providers/slack/server services/organization-authority
npm run check:architecture-boundaries
```

The first SQLite test attempt was blocked by the isolated `npm ci --ignore-scripts` install lacking the local better-sqlite3 binary. `npm rebuild better-sqlite3` repaired only the isolated dependency, then the same focused batch passed.

## Task 12 boundary and concerns

- V1/V2/V3 card/parser modules remain deliberately because Task 12 still consumes them. V4 is exported separately; Task 12 should migrate parsing/click validation before deleting the retired builders.
- Task 12 must bind a click against the persisted target's workspace, user, app, channel and timestamp, then call `decide`. This task stores the resolved `dm_channel_id` in the immutable JSON before marker posting.
- The reviewer should scrutinize the presentation retry semantics and the composition-root control-database lifetime; no full `npm run check` was run here because the controller owns the serialized full gate.

## Fix round 1

Addressed every review finding in one batch:

- The service lifecycle now invokes presentation reconciliation from both its primary and `additional_processing` lanes, and its wake guard recognizes either lane.
- Presentation work selection excludes settled rows and orders opening/marker work ahead of redraws, so 25 completed rows cannot starve later work.
- The table now reserves immutable identity in `target_json`, assigns `dm_channel_id` once before a marker post, and permits a known `message_ts` to survive a terminal `failed` state. Opening, marker recovery, and message updates all persist exponential retry state and stop at five attempts.
- Provider work revalidates the active connection/workspace/app and active link commitment before and after awaits. A stale target becomes failed without mutating the target, channel, or message timestamp.
- Claim insertion is conflict-tolerant and happens before opening a DM. Only the successful claimant can post the marker.
- `publishing` draws as an approved terminal card; long project names are bounded to Slack's 75-character option-label limit.
- The composition root closes the control database both during construction failure and shutdown, including when Granola shutdown throws.

This round did not have clean RED-before-implementation chronology: the review supplied concrete failing scenarios and the schema/presenter redesign began before the added label/lifecycle-focused checks. The prior report's TDD caveat remains applicable.

Focused GREEN after the batch:

```text
npx vitest run --config vitest.config.ts \
  packages/organization-authority-kernel/test/adapters/persistence/sqlite/authority-baseline-v12.test.ts \
  services/organization-authority/test/approval-decision-schema.test.ts \
  services/organization-authority/test/approval-core-v1.test.ts \
  providers/slack/server/test/private-approval/slack-approval-card-v4.test.ts \
  providers/slack/server/test/private-approval/slack-approval-presenter-v1.test.ts
# 67 passed
npx vitest run --config vitest.config.ts providers/slack/server/test/private-approval/slack-approval-card-v4.test.ts providers/slack/server/test/private-approval/slack-approval-presenter-v1.test.ts services/organization-authority/test/organization-authority-service-lifecycle.test.ts
# 36 passed
npx tsc -b packages/organization-authority-kernel providers/slack/server services/organization-authority
```

## Fix round 2, Stage A: tests-only RED evidence

No production or schema files changed in this stage. The presenter tests now begin with an actually eligible staged outbox proposal and no presentation row. They cover normal delivery, unlinked and late-linked reviewers, persisted-channel crash recovery, `retry_allowed` versus `uncertain`, each provider-operation exception, stale target validation, oversized cards, a terminal decision redraw behind 25 completed rows, and the service lifecycle's `additional_processing` presenter dispatch.

RED command on unmodified production commit `a91fc7d`:

```text
npx vitest run --config vitest.config.ts providers/slack/server/test/private-approval/slack-approval-presenter-v1.test.ts services/organization-authority/test/organization-authority-service-lifecycle.test.ts
# 2 files; lifecycle 32 passed; presenter 11 tests with 7 failures
```

The failures are meaningful behavior gaps: normal and late-linked first delivery calls `reconcileMarker` after opening the DM rather than `postMarker`; `retry_allowed` therefore never reaches the safe first-marker retry; an `openDirectMessage` exception escapes instead of recording retry state; post cannot begin after the durable channel reservation; and thrown reconciliation/publish exceptions escape without durable backoff. The uncertain-marker, stale-target, oversized-card, terminal-redraw/starvation, and additional-lane lifecycle cases are already green. This is an intentional RED stopping point pending the controller's explicit Stage B authorization.
