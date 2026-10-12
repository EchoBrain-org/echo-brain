---
schema_version: 1
id: INV-OPERATIONS-001
kind: invariant
title: Components sharing a runtime namespace share lifecycle qualification
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-OPERATIONS-RELEASE
created_at: 2026-08-13
reviewed_at: 2026-10-11
reviewed_ref: 3aea847cca4fa44cfa1ab28dbf44b1b707590b8b
normative: MUST
enforcement_status: partial
enforcement_scope: Explicit proxy restart in the update, backup-maintenance and tracing operator paths; Compose restart propagation is declared but not exercised in CI
failure_pattern_ids:
  - FP-OPERATIONS-001
---

# INV-OPERATIONS-001: Components sharing a runtime namespace share lifecycle qualification

## Statement

When one component joins another component's runtime namespace, restart and
qualification MUST treat that namespace as a shared lifecycle resource.
Application health and externally served reachability MUST be proved
independently after restart.

## Scope and failure behavior

An explicit dependency restart propagates to namespace dependents and proves
the new process and route. Engine-initiated crash restart remains a separately
stated residual until the topology or supervisor closes it.

## Enforcement and verification

`deploy/organization-authority/compose.clean-v1.yaml` still declares the proxy
with `network_mode: service:authority` and
`depends_on.authority.restart: true`, and
`tests/architecture/organization-authority-deployment-profile.test.ts` pins
that declaration. The CI smoke that restarted the Authority and proved the
proxy process was replaced (added in `5aa7a37`) was removed in `e75250d`, so
CI no longer exercises Compose restart propagation.

The tested mitigation is an explicit `compose restart proxy` after the
Authority starts in `restart_and_prove` (`backup-authority-maintenance.sh`),
`start_and_check` (`update-clean-v1.sh`) and `langsmith-tracing`
(`onboard-clean-v1.sh`). Those restarts are asserted by
`tests/architecture/authority-backup-maintenance.test.ts`,
`tests/architecture/organization-authority-release-record.test.ts` and
`tests/architecture/organization-authority-deployment-profile.test.ts`; the
runbook's public failure rehearsal is asserted by
`tests/architecture/authority-observability-stack.test.ts`. The other
onboarding starts (`start_runtime`, a whole-stack `compose up --wait`) rely on
the declared Compose propagation alone. Externally served reachability remains
a separate exact-run qualification assertion.
