# Organization API tests

The suite verifies the package's current runtime validators and canonical byte
encoders:

- Person OIDC and session DTOs, including the Person email identity rules.

Wire compatibility assertions intentionally retain the existing URL paths,
JSON fields, and serialized `kind` values even when source names are more
specific.
