Public RFC 3161 diagnostic receipt obtained from FreeTSA on 2026-09-05.
The timestamp commits only SHA-256 of the literal UTF-8 string
"authority-capacity-anchor-integration-check-v1". It contains no private data,
candidate registration, trace, credentials, or capacity result.

The offline regression test verifies the actual third-party signature and
rejects a modified local message imprint and a timestamp after an allowed
start. These artifacts test the anchoring mechanism only; they cannot anchor a
qualification attempt, which needs its own immutable registration digest.
