# Organization protocol schemas

The four V1 schemas are self-contained draft-07 documents so consumers do not
need a custom cross-file `$ref` resolver. Tests lock their shared identifier,
digest, timestamp, public-key, and integrity definitions against drift.

The authority descriptor is deliberately unsigned. Enrollment request,
enrollment receipt, and installation access state use the shared federation
P-256/RFC 8785 signature profile. The schemas enforce wire shape; the package's
verifiers enforce signatures, cross-document bindings, chronology, lease
freshness, real calendar timestamps, and monotonic access-state progression.
Timestamp schemas deliberately use portable syntax constraints rather than a
consumer-specific custom format.
