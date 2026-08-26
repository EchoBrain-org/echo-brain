---
schema_version: 1
id: ADR-0009
kind: decision
title: Retained Authority data-volume boundary
component_ids:
  - CMP-OPERATIONS-RELEASE
created_at: 2026-08-25
reviewed_at: 2026-08-25
reviewed_ref: 35875e49817c841ac1f8aa3abf669d6e9a636a83
status: proposed
supersedes: []
superseded_by: []
updates: []
---

# ADR-0009: Retained Authority data-volume boundary

## Context and options

The current Authority stores its organization state beneath `clean-data/` on
the Authority host root volume. That makes a host replacement inseparable from
the organization's SQLite databases, retrieval generations, release state,
and private credential files. It also means a rebuilt host could allocate a
different numeric identity for `echo-authority` and lose access to copied
state.

The deployment root is `/srv/echo-authority-clean-v1`. The intended durable
state boundary is narrower than that root: only
`/srv/echo-authority-clean-v1/clean-data` contains organization state. Compose,
Caddy, host configuration, release tooling, and application code must remain
replaceable host material.

| Option                                  | State location                                                                                                                       | Consequence                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| A. Dedicated retained data volume       | One dedicated encrypted data volume mounts at the exact `clean-data` path. Infrastructure retains it when the host stack is deleted. | Separates organization state from a replaceable host and provides a later restore target. |
| B. Root-volume-only state               | Keep `clean-data/` on the instance root volume.                                                                                      | A host replacement remains a data-recovery event; it cannot prove replaceability.         |
| C. Mount the whole deployment directory | Put code, host configuration, and state on one retained volume.                                                                      | Makes host configuration durable state and blurs the replacement boundary.                |

## Candidate decision and consequences

**Candidate recommendation: option A.** Each Authority receives one dedicated
encrypted data volume, mounted exactly at:

```text
/srv/echo-authority-clean-v1/clean-data
```

Its lifecycle is independent of the instance and host stack. The eventual
infrastructure definition retains the volume on stack deletion and enrolls it
in the organization backup policy. The host root volume contains the deployment
root and replaceable material only; it must not become a second live source of
organization state after cutover.

The `clean-data` mount must be present, a real directory rather than a
symlink, mounted from the intended data volume, and owned by the fixed numeric
identity of `echo-authority` before Docker or Compose may start. Startup must
fail closed if those facts cannot be verified. `clean-data/private`,
`clean-data/state`, and `clean-data/release` remain part of the retained data
boundary and retain their existing ownership and mode requirements.

The numeric account identity is taken from a read-only Systems Manager
inspection of the existing Authority host on 2026-08-25. The private operator
receipt retains the host identifier; this decision records only the reusable
numeric identity and the observed state ownership:

| Required value               | Candidate value |
| ---------------------------- | --------------- |
| `echo-authority` UID         | `999`           |
| `echo-authority` primary GID | `988`           |

The inspection also found the existing `clean-data/` and `clean-data/private/`
directories owned by `999:988`. A local default such as `1000:1000`, a new
host's allocation, or a guess from a test environment is not evidence. The
future machine configuration creates `echo-authority` with `999:988` before
the data volume is mounted or any container reads it.

## Migration, rollback, and evidence

This proposed decision does not implement or claim a migration. Acceptance
only establishes the target boundary; a later reviewed runbook and
implementation must carry out the change.

That later migration must, at minimum:

1. capture a verified current recovery point and settle any Authority
   operation lock;
2. stop the Authority cleanly, copy the complete `clean-data` tree to a
   detached data volume while preserving ownership, modes, links, and required
   metadata, and verify the copied structure offline;
3. retain the original root-volume state as a rollback point until the mounted
   target has passed the defined validation; and
4. mount the target at the exact path, verify the mount and fixed UID/GID
   before Docker starts, then run the bounded recovery and onboarding checks.

The migration must never use a whole-deployment mount, silently overwrite an
existing target volume, or destroy the source before validation. Reverting a
failed cutover means stopping the Authority and returning to the preserved
source state under a separately reviewed procedure; it does not mean merging
or copying divergent state trees.

Before this candidate can become `accepted`, the founder must confirm the
verified UID and GID above and approve the retained-volume lifecycle,
encryption owner, backup enrollment, and cutover/rollback plan. After
acceptance, a successful rebuild and restore drill is still required before
claiming a replaceable-host recovery capability.
