# Local organization integration

**Status:** Accepted local boundary; no runtime integration

This module will connect one installed Echo Brain to one organization
authority. It reserves ownership for enrollment preparation, authority pinning,
authority-client orchestration, signed-result verification, and the minimum
local organization evidence later accepted for the onboarding/access slice.

It does not own central membership truth, organization signing keys, admin
sessions, meetings, decisions, reasoning, or core processing. The existing N=1
product database remains unchanged; no organization table, table count,
persistence mapping, or migration is selected by this scaffold.

Stable files here must never import `src/experimental/n2` or the central service.
The root product will not consume the new workspaces until its artifact builder
can stage their exact checked closure.
