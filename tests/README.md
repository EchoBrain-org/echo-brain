# Test ownership

Tests live at the narrowest active boundary they exercise:

| Path | Scope |
| --- | --- |
| `tests/person-client/` | thin Person CLI and private session behavior |
| `tests/architecture/` | source, workspace, and artifact boundaries |
| `packages/*/test/` | shared protocol and API contracts |
| `services/*/test/` | server application, persistence, and component behavior |

Use `npm test` for the complete active suite. Focused commands include
`npm run test:person`, `npm run test:authority`, `npm run test:protocols`,
`npm run test:meeting-processing-core`, and `npm run test:architecture`.
The active durable meeting-processing pipeline is covered by
`packages/organization-processing/test/admitted-meeting-processing/` in the
root `npm test` suite.

Prefer named table cases for the same behavior under different inputs. Keep
distinct failure and recovery assertions when consolidating setup. Expected
release bytes use the independent serializer in `tests/support/test-canonical-json.ts`.
Mutable Git fixtures use `tests/fixtures/coherent-worktree.ts` to give each case
an isolated checkout of the original dirty and untracked inputs.
The four stateful workspace suites share `vitest.package.serial.config.ts` and
retain serial execution.

Tests for the retired LaunchAgent machine runtime, local product database,
installation enrollment client, JSONL outbox, and fleet updater were deleted
with that production code. Historical qualification evidence remains in
`docs/qualification/`.
