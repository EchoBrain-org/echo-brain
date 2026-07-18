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
boundary. `0004-granola-adapter-boundary.v1.json` records removal of the
top-level capture architecture and relocation of its remaining Granola
compatibility implementation behind the meeting-source adapter namespace.
`0005-state-and-filesystem-boundary.v1.json` records removal of the ambient
ECHO home path policy, explicit injection of remaining compatibility paths, and
relocation of durable file replacement into vendor-neutral infrastructure.
`0006-enrich-retirement.v1.json` records retirement of the unreachable legacy
enrichment pipeline and its synthetic extraction witness in favor of the
canonical adapter/core cycle. `0007-granola-compatibility-retirement.v1.json`
records removal of the Granola raw-event compatibility export so Granola
ingress is only the canonical meeting-source adapter.
`0008-product-qualification-restoration.v1.json` records restoration of the
build-once qualification foundation from Project ECHO commit `f316d565`,
adapted to the standalone core/adapters boundary and root dependency lock.
`0009-product-operator-recovery.v1.json` records the standalone onboarding,
LaunchAgent lifecycle, credential, and stopped-service state recovery path
while keeping managed code-version rollback explicitly pending.
`0010-qualification-runner-portability.v1.json` records PATH-portable Git/npm
invocation and checkout-local npm cache binding for the macOS arm64 DEV
qualification workflow.
`0011-immutable-offline-support.v1.json` records per-install cache isolation so
offline qualification cannot mutate its hashed support bundle.
