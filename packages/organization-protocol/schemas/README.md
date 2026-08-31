# Organization protocol schemas

`organization-authority-descriptor.v1.schema.json` is the package's only
published JSON Schema. It defines the unsigned authority identifier,
organization identifier, and public signing-key descriptor used during
independently authenticated pinning.

The schema validates portable document shape. It does not authenticate the
descriptor or prove control of the corresponding private key.
`validateOrganizationAuthorityDescriptor` adds the runtime syntax and public-key
self-consistency checks, while `verifyOrganizationAuthorityPin` performs the
independent digest comparison.

Organization record envelopes, receipts, approval policies, and human-action
inputs are enforced by the TypeScript validators exported from `src/index.ts`;
this directory does not imply schemas for those contracts.
