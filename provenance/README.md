# Provenance model

The JSON records in this directory bind the immutable source-extraction commit
`41c28171c64710b3ad23392a2606d75cfe8e7b2c`. They are historical evidence for
the reviewed Project ECHO split; they do not claim that later standalone-product
changes were copied from that source snapshot.

`node tools/check-provenance.mjs` verifies that extraction commit by default.
Pass `--commit <tree-ish>` only when auditing whether another commit is still the
exact extraction tree; successor product commits are expected to differ.

Successor records under `successors/` describe intentional post-extraction
changes without rewriting the historical extraction claim. In particular,
`0002-tool-agnostic-core.v1.json` records the core/adapter dependency direction
that governs future integrations. `0003-adapter-composed-runtime.v1.json`
records the first durable, manually approved vertical slice built on that
boundary.
