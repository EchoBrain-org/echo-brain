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
