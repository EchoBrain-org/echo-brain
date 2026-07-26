# Organization authority tests

The Phase 4 suites cover application, SQLite persistence, signing, trusted
time, HTTP parsing/rate limits, enrollment idempotency, lease sequencing, and
membership/installation revocation. Phase 5 remains the exact-artifact live
N=2/org=1 gate; a later ingest-and-receipt gate is still required for parity
with the experimental pilot.

HTTP coverage also proves authenticated proxy-client bucket isolation,
fail-closed proxy identity, canonical privacy-preserving client IDs,
route-specific authentication challenges, and persistent serve configuration.
