# Test ownership

Tests live at the narrowest layer whose public behavior they exercise:

| Path | Scope |
| --- | --- |
| `tests/core/` | vendor-neutral processing |
| `tests/adapters/` | source, processor, approval, and delivery adapters |
| `tests/infrastructure/` | filesystem and process primitives |
| `tests/architecture/` | source and workspace boundaries |
| `tests/product/` | product composition, state, and federation |
| `tests/machine/` | CLI, lifecycle, credentials, backup, and signer |
| `tests/integration/` | deliberate product/service crossings |
| `packages/*/test/` | shared protocols |
| `services/organization-authority/test/` | central authority |
| `services/organization-control-plane/test/` | provider connections and grants |

Useful commands are `npm test`, `npm run test:core`, `npm run test:adapters`,
`npm run test:infrastructure`, `npm run test:architecture`,
`npm run test:integration`, `npm run test:product`, `npm run test:machine`,
`npm run test:federation`, `npm run test:local-org`,
`npm run test:protocols`, `npm run test:authority`, and
`npm run test:control-plane`. Shared helpers live in `tests/support/`.
