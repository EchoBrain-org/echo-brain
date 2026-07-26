# Frozen N=2 reference implementation

This directory preserves the pre-promotion N=2 ingest-and-receipt pilot as
reference evidence. It is not part of the stable employee-machine product or
the central organization-authority service.

The stable `npm run build` and `npm run typecheck` commands exclude this tree,
and the product builder does not copy its migrations, schemas, or SQL assets
into `dist/`. Stable code must never import this directory. Experimental code
may depend on stable protocol and product primitives while parity is being
proved.

Use the explicit lane when changing the frozen reference:

```sh
npm run typecheck:experimental
npm run test:experimental:n2
```

Promotion happens capability by capability. The stable onboarding/access
slice is already under `packages/`, `src/product/organization/`, and
`services/organization-authority/`. Experimental ingest and batch receipts
remain here until their own parity gate is complete; they must not be restored
to the stable artifact as a shortcut.
