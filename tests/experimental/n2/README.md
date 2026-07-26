# Frozen N=2 compatibility tests

These suites preserve the disposable pre-promotion pilot:

- development file signers;
- manual two-installation onboarding;
- experimental authority ingest and batch receipts;
- local receipt synchronization; and
- the intentional wire break between the pilot and the stable organization
  protocol.

They may import `src/experimental/n2/` and stable primitives. No stable test or
production module may import the experimental implementation in the opposite
direction.
