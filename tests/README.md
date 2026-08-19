# Test ownership

Tests live at the narrowest active boundary they exercise:

| Path | Scope |
| --- | --- |
| `tests/person-client/` | thin Person CLI and private session behavior |
| `tests/architecture/` | source, workspace, and artifact boundaries |
| `tests/integration/` | deliberate cross-workspace processing checks |
| `packages/*/test/` | shared protocol and API contracts |
| `services/*/test/` | server application, persistence, and runtime behavior |

Use `npm test` for the complete active suite. Focused commands include
`npm run test:person`, `npm run test:authority`, `npm run test:protocols`,
`npm run test:integration`, and `npm run test:architecture`.

Tests for the retired LaunchAgent machine runtime, local product database,
installation enrollment client, JSONL outbox, and fleet updater were deleted
with that production code. Historical qualification evidence remains in
`docs/qualification/`.
