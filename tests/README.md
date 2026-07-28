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

Useful commands are `npm test`, `npm run test:product`,
`npm run test:federation`, `npm run test:local-org`, and
`npm run test:authority`. Shared helpers live in `tests/support/`.
