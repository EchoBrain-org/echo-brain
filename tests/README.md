# Test ownership

Tests live at the narrowest active boundary they exercise:

| Path | Scope |
| --- | --- |
| `tests/person-client/` | thin Person CLI and private session behavior |
| `tests/architecture/` | source, workspace, and artifact boundaries |
| `packages/*/test/` | shared protocol and API contracts |
| `services/*/test/` | server application, persistence, and component behavior |
| `providers/**/test/` | provider adapters, connections and live readers |
| `product/echo-desktop/test/` | Electron desktop unit (`unit/`, Vitest) and end-to-end (`e2e/`, Playwright) tests, with the app's own configs |
| `tools/evals/*/test/` | evaluator `node --test` suites |

Use `npm test` for the complete root Vitest suite. Focused commands include
`npm run test:person`, `npm run test:authority`, `npm run test:protocols`,
and `npm run test:architecture`.
The provider-neutral processing core and the active durable meeting-processing
pipeline are covered by `packages/organization-processing/test/core/` and
`packages/organization-processing/test/admitted-meeting-processing/` in the
root `npm test` suite.

Prefer named table cases for the same behavior under different inputs. Keep
distinct failure and recovery assertions when consolidating setup. Expected
release bytes use the independent serializer in `tests/support/test-canonical-json.ts`.
Mutable Git fixtures use `tests/fixtures/coherent-worktree.ts` to give each case
an isolated checkout of the original dirty and untracked inputs.
Every root suite, including the stateful workspace suites, runs under the root
`vitest.config.ts`. The focused `test:*` commands pass it a path filter.
That config points `HOME` and `XDG_DATA_HOME` at one temporary folder per run
(`tests/support/isolated-home.ts`), so no test reads or writes the real Person
store. Person CLI tests still pass their own `home_directory`:
`runPersonClientCli` refuses a call without one.

The desktop app and the `node --test` suites are outside that config and run
separately, as CI does:

- `cd product/echo-desktop && npm test` builds the app, then runs its unit and
  Electron end-to-end tests. It needs `npm ci` in that directory, the Person
  client built at the root (`node tools/build.mjs --person-client`) and a
  graphical session; CI uses Xvfb on Linux.
- `npm run test:capacity` runs `tools/evals/authority-core/test/`,
  and `npm run test:research-loop-eval` runs `tools/evals/research-loop/test/`.
