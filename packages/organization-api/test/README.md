# Organization API tests

The suite verifies the package's current runtime validators and canonical byte
encoders:

- Person OIDC and session DTOs;
- Person Slack identity-link challenges and results;
- meeting-ingestion exclusion changes and scoped reads; and
- administrator membership, overview, and audit DTOs.

Wire compatibility assertions intentionally retain the existing URL paths,
JSON fields, and serialized `kind` values even when source names are more
specific.
