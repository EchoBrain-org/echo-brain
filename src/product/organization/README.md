# Local organization integration

**Status:** local enrollment and access runtime

This module connects one installed Echo Brain to one organization authority. It
owns enrollment preparation, authority pinning, bounded HTTP-client
orchestration, signed-result verification, and the minimum local organization
evidence required by the onboarding/access slice.

It does not own central membership truth, organization signing keys, admin
sessions, meetings, decisions, reasoning, or core processing. Migration `0005`
adds three tables to the existing installation database for the write-once pin,
exact enrollment evidence, and atomic access high-watermark. The raw bearer
grant is never persisted.

Local product files never import the central service. The product package
bundles only the three shared protocol/API workspaces.
