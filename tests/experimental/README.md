# Experimental test lane

Experimental tests are intentionally outside every stable Vitest include.
They run only through `vitest.experimental.config.ts` or
`npm run test:experimental:n2` and are typechecked by
`tsconfig.experimental.json`.

This separation keeps frozen reference behavior available for promotion work
without allowing it to define stable product qualification.
