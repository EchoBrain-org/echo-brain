# Task 14 report: durable approved-record runs service, route and CLI

## Result

Implemented the durable runs service over the existing V12 trigger-run DAO,
mounted `POST /v1/person/runs`, and added the Person client and `runs --request`
CLI verb. Starts claim and return immediately; workers bind the approval actor's
fresh desk, use the approved-record trigger's background renderer, and store a
pointer-only card. Views reopen every citation under a fresh actor-bound desk,
withhold inaccessible entries, and revalidate before release. The route remains
reserved and returns `unavailable` after authenticated access when no answer
model is composed.

The task also corrects R24: outside-label screening now needs Unicode
letter/digit boundaries, preventing short labels such as `Display` and `Home`
from corrupting `displayed` or `homepage`.

## RED proof

After adding the R24 behavior test and temporarily retaining the old screen
regular expression, this command failed as expected:

```
npm exec vitest run packages/organization-authority-kernel/test/answer-composition/renderers/impact-card-storage-v1.test.ts
```

The failing assertion received `Show two decimals on the a cited itemed value
from the a cited itempage.` where the ordinary sentence was expected. The final
boundary implementation makes that test pass.

## Verification

Passed:

- `npm run build --workspace @echo-brain/organization-authority`
- `npm exec tsc -- --noEmit -p services/organization-authority/tsconfig.json`
- `npm exec tsc -- --noEmit -p src/product/person-client/tsconfig.json`
- `npm exec eslint services/organization-authority/src/composition/person-trigger-runs-v1.ts services/organization-authority/src/presentation/person-trigger-runs-http-application.ts services/organization-authority/src/composition/organization-authority-api-runtime.ts services/organization-authority/src/presentation/organization-authority-http-server.ts src/product/person-client/authority-client.ts src/product/person-client/client.ts src/product/person-client/commands.ts packages/organization-authority-kernel/src/answer-composition/renderers/impact-card-storage-v1.ts`
- `npm exec vitest run tests/person-client/person-runs.test.ts packages/organization-authority-kernel/test/answer-composition/renderers/impact-card-storage-v1.test.ts` (2 files, 29 tests)
- `git diff --check`

Per coordination, I did not run broad Authority/Person suites or `npm run check`;
root owns the serialized full validation gate.

## Files

- `services/organization-authority/src/composition/person-trigger-runs-v1.ts`
- `services/organization-authority/src/presentation/person-trigger-runs-http-application.ts`
- Authority runtime and HTTP route composition
- Person authority client, high-level client and CLI command
- R24 storage helper and regression
- `tests/person-client/person-runs.test.ts`

## Follow-up focused proofs

Added an actual V12 SQLite DAO fixture for the service and an HTTP transport
fixture. They cover actor-only list/start/retry/view, approver-bound detached
work and outside-text scrubbing, unindexed no-count release, lost-record
access mapping to `no_access`, three deadline attempts to `timed_out`, fresh
empty citation opens, lease expiry takeover, bearer enforcement, route
reservation, and no-model `unavailable` transport behavior.

Passed after those additions:

- `npm exec vitest run services/organization-authority/test/person-trigger-runs-v1.test.ts services/organization-authority/test/person-runs-http.test.ts tests/person-client/person-runs.test.ts packages/organization-authority-kernel/test/answer-composition/renderers/impact-card-storage-v1.test.ts` (4 files, 35 tests)
- `npx tsc --noEmit -p tsconfig.json`
- `git diff --check`
