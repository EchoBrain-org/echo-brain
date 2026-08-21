# Organization authority tests

The suites cover application behavior, SQLite persistence, signing, trusted
time, HTTP parsing and rate limits, enrollment idempotency, lease sequencing,
and membership/installation revocation.

HTTP coverage also proves authenticated proxy-client bucket isolation,
fail-closed proxy identity, canonical privacy-preserving client IDs,
route-specific authentication challenges, and persistent serve configuration.

Organization-record coverage sits in three suites. `organization-record-ingest`
runs the real authority application, the real control-plane audit, and the real
record runtime over real SQLite files: exact receipt fields, idempotent retry,
divergent conflict, every authorization-evidence mismatch, ambiguity as denial,
canonical oversize, tampered signature, and a revoked installation staying
retryable. `organization-record-http` covers the route's raw-body exemption
against the unchanged shared limit and the exact terminal-code mapping.
`organization-record-lifecycle` covers publication at initialization, the
runtime fingerprint, preflight refusal, startup chain verification, clean
shutdown, the `install-integrations` retrofit, and a fatal startup derive halt.

`person-read-contracts-v2` is the private D6-1 structural checkpoint. It
freezes all four semantic request bodies and golden digests plus the exact
bearer-derived caller-binding body/digest, including hostile-object and I-JSON
rejection. It is unwired and makes no scope, release, audit, retention, export,
persistence, public-surface, live-DTO, or caller-supplied-subject-removal claim.
