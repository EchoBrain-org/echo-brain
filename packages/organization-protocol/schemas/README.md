# Organization protocol schemas

The six V1 schemas are self-contained draft-07 documents so consumers do not
need a custom cross-file `$ref` resolver. Tests lock their shared identifier,
digest, timestamp, public-key, and integrity definitions against drift.

The authority descriptor is deliberately unsigned. Enrollment request,
enrollment receipt, installation access state, both record envelopes, and the
record receipt use the shared federation P-256/RFC 8785 signature profile. The
schemas enforce wire shape; the package's verifiers enforce signatures,
cross-document bindings, chronology, lease freshness, real calendar timestamps,
monotonic access-state progression, and every organization record cross-field
rule (unique signal ids, resolvable rationale links, evidence bound to its own
meeting, authorization evidence bound to its own submission). Timestamp schemas
deliberately use portable syntax constraints rather than a consumer-specific
custom format, which is why a syntactically well-formed but impossible calendar
day is a validator rejection rather than a schema rejection.

The record envelope schema is a discriminated union by `event_type` and rejects
the reserved `correction` type. Each branch pins the reviewer authorization
`action` to its own event type, so an allow decision for one act never validates
against the other. The approval branch also pins the V1 constants:
`alternatives` is an empty array, `links` is null, and `intent` is exactly
`restricted: true` with `reconsider_after: null`.

Two rules are structural here and exact in the validator, and both carry a
`$comment` saying so. JSON Schema counts UTF-16 code units, not UTF-8 bytes, so
the rejection reason's `maxLength` is a sound but coarse upper bound — every
reason within 2048 bytes is within 2048 code units, but a multibyte reason
under 2048 code units can exceed 2048 bytes and only the validator rejects it.
Participant `uniqueItems` catches identical entries; two entries sharing an id
but differing in any other fact are the validator's to reject.
