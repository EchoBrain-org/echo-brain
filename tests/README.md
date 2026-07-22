# Test ownership and lanes

Tests follow the same ownership boundaries as production code. A test belongs
to the narrowest layer whose public behavior it exercises; cross-boundary
behavior belongs in `tests/integration/`.

| Path                                    | Owner                                                                         | Independent command                                                               |
| --------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `tests/core/`                           | organization- and vendor-agnostic processing                                  | `npm run test:core`                                                               |
| `tests/adapters/`                       | replaceable source, processor, approval, and delivery adapters                | `npm run test:adapters`                                                           |
| `tests/infrastructure/`                 | filesystem, process, and local harness primitives                             | `npm run test:infrastructure`                                                     |
| `tests/architecture/`                   | repository dependency, provenance, and source-boundary policy                 | `npm run test:architecture`                                                       |
| `tests/product/`                        | employee-machine composition, state, and product behavior                     | `npm run test:product`; use `test:machine` or `test:local-org` for focused slices |
| `tests/product/federation/`             | stable local federation composition, identity, projection, and export         | `npm run test:federation`                                                         |
| `tests/machine/`                        | installed-product CLI, lifecycle, credentials, release, and recovery behavior | `npm run test:machine`                                                            |
| `tests/machine/target/`                 | target-only macOS arm64 hardware and packaging behavior                       | `npm run test:machine:target`                                                     |
| `tests/integration/`                    | deliberate local-product/service crossings                                    | `npm run test:integration`                                                        |
| `packages/*/test/`                      | shared trust-boundary contracts                                               | `npm run test:protocols`                                                          |
| `services/organization-authority/test/` | central org=1 authority                                                       | `npm run test:authority`                                                          |
| `tests/experimental/n2/`                | frozen pre-promotion N=2 reference                                            | `npm run test:experimental:n2`                                                    |

The stable compiler and stable Vitest configurations exclude
`src/experimental/` and `tests/experimental/`. The experimental lane has its
own TypeScript and Vitest configurations and can never enter the shipped
product merely because its tests pass.

Useful aggregate commands:

- `npm test` runs stable repository, protocol, service, infrastructure, and
  integration tests.
- `npm run test:local-org` isolates the employee-machine organization client
  and state store.
- `npm run test:federation` isolates stable federation composition and
  foundation behavior from its single owned test directory.
- `npm run test:machine:target` runs the darwin/arm64-only machine checks that
  stable host-neutral tests exclude and product qualification includes.
- `npm run check:experimental` typechecks, lints, and tests only the frozen
  pilot.
- `npm run check` runs the complete stable repository and product
  qualification gates.

Shared test helpers live in `tests/support/`. They must not import a concrete
product implementation into an adapter or core test. A test that needs both
sides of such a boundary is an integration test.
