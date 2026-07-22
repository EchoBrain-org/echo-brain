# Local organization integration

**Status:** Phase 4 local enrollment and access runtime

This module connects one installed Echo Brain to one organization authority. It
owns enrollment preparation, authority pinning, bounded HTTP-client
orchestration, signed-result verification, and the minimum local organization
evidence required by the onboarding/access slice.

It does not own central membership truth, organization signing keys, admin
sessions, meetings, decisions, reasoning, or core processing. Migration `0005`
adds three tables to the existing installation database for the write-once pin,
exact enrollment evidence, and atomic access high-watermark. The raw bearer
grant is never persisted.

Stable files here never import `src/experimental/n2` or the central service.
The product artifact bundles only the three shared protocol/API workspaces.
