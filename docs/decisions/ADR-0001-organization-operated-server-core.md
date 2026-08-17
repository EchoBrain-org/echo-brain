---
schema_version: 1
id: ADR-0001
kind: decision
title: Organization-operated server-core processing
component_ids:
  - CMP-LOCAL-RUNTIME
  - CMP-CENTRAL-ORGANIZATION
  - CMP-CORE-PIPELINE
created_at: 2026-08-17
reviewed_at: 2026-08-17
reviewed_ref: 4665c3a93187095d5d14acbe95e825cd69aaf31e
status: accepted
supersedes: []
superseded_by: []
updates: []
---

# ADR-0001: Organization-operated server-core processing

## Context and options

Today every enrolled machine is a complete instance of the product: it
captures, extracts, publishes, resolves, records, and searches, and the
organization record is an emergent property of N machines agreeing with each
other. Of the machine installable's 33,407 non-test LOC, roughly 17,000
exist only to compensate for durable, security-relevant state living on
hardware the record's operator does not own, cannot reach, and cannot trust:
self-supervision, a self-update fleet, backup/restore, enrollment and machine
PKI, secret hardening, filesystem-as-database, and a submission protocol with
ten failure modes.

Two premises decide the option set, and both are now settled facts rather
than assumptions:

- **P1 — extraction runs on a hosted model provider.** No on-device model is
  viable near-term. The canonical meeting therefore leaves the employee's
  machine under every option except the deterministic `structured-text`
  processor. The only remaining custody question is whether the
  organization's own server also sees it.
- **P2 — the buyer is an executive purchasing for the organization.** Fleet
  install is a procurement cost, not a feature; the employee-from-employer
  boundary is a compliance requirement to satisfy rather than a selling point
  to lead with; sources trend org-tenant.

Options weighed (full table and reasoning in
[server-core migration plan v3](../product/2026-08-17-server-core-migration-plan-v3.md)):

| Option | Processing | Custody operator | Deletes |
| --- | --- | --- | --- |
| A. Status quo plus | machine | organization | ~0 |
| B. Organization-operated server-core | organization server | organization | ~17,000 |
| C. ECHO-hosted service | ECHO | ECHO | ~17,000, spends the product-control boundary |
| D. Local processing, server-held identity | machine | organization | ~6,000 |

D was scored against the **marginal** figure — roughly 11,000 lines, not the
gross 17,000, because ~6,000 come off under D too without touching custody.
D lost on P1 (its custody advantage evaporates once the transcript reaches a
provider from the machine anyway, while N laptops each hold an org-paid
provider key) and on P2 (it keeps the fleet install). A is the null baseline.
C is deferred to its own ADR.

## Decision and consequences

**1. Adopt option B.** Processing moves into the organization-operated
authority process. The recorded product-control boundary is preserved intact:
the organization continues to own operations, database, backups, ingress,
logs, and keys, and ECHO holds no credential, key, shell, or audit
visibility. That boundary is the differentiator against multi-tenant
notetakers and is not spent here.

**2. `AD-06` is superseded — as a correction, not a concession.** Raw
transcripts and vendor payloads now reach the organization-operated server
and the organization's chosen model provider; never ECHO. The registry marks
`AD-06` "implemented at baseline," but that status held only under the
shipped `structured-text` processor: any configuration selecting the LLM
processor with a hosted provider already sends the canonical meeting off the
machine. This ADR records what was already conditionally true.

**3. `AD-05` is superseded.** The rejected package no longer stays local. It
resides in the organization's pre-record store under the retention rule
below, and is never projected, indexed, or made searchable. Rejection
withholds the atom; it does not withhold the bytes from the operator.

**4. Granola is a bridge source; only the organization-owned key is held.**
The workspace/admin credential lives in the server secret store. Personal
`grn_` account credentials are **never** collected centrally — the vendor's
own administrators cannot read members' private notes, and ECHO does not
build the path that defeats that. Consequence, accepted: centrally the corpus
is limited to workspace-visible notes until org-tenant platforms (Zoom,
Teams, Google) land in phase 5, which is where the corpus is expected to come
from under P2. The exposed credential is rotated as a standing item.

Generalized as an invariant for every future source: **credential ownership
follows source scope, not adapter.** A credential is held server-side only if
the account it authenticates belongs to the organization.

**5. Pre-record store governance (binding from its first row).** Phase 1
creates a store of real meeting transcripts on the organization's server.
Before that store exists:

- Its only application reader is the processing module's named service
  principal, with a declared read scope. No human principal reads it by
  default.
- Break-glass access is an explicitly audited administrator act. Direct
  database access by the box operator cannot be guaranteed auditable at the
  application layer; whether it can be enforced at the database layer is an
  open question, not a settled control, and is not claimed as one.
- **Retention: 30 days after a candidate reaches a terminal state** —
  approved, rejected, or withdrawn — then hard deletion. This number is
  provisional and is re-evaluated at phase 5 gate 2; it may require legal
  input before an external organization operates the store.
- Any fixture corpus captured for phase-1 replay is disposed of within 7 days
  of phase-1 exit.
- **Visibility floor:** content ingested with no human release intent is
  `invisible` by default — not discoverable, not readable. Drafted here,
  landed as a phase-5 entry gate.

**6. Phase 1 parity runs the deterministic processor only.** Fixture replay
compares the relocated module against the machine pipeline using
`structured-text`. This defers the model-provider egress question to phase 3
entry, where enterprise terms (provider, training opt-out, retention) must be
recorded in writing before real transcripts reach a provider from the server.
Consequence, accepted: phase-1 parity proves the pipeline and its identity
chain, not the LLM path.

**7. The member valve: control preserved, observability degraded.** The
landed pre-ingest exclusion has two properties — the member controls it, and
the organization has no trace of it. Under B the first survives and the
second cannot, because the exclusion becomes a row in a database the
organization operates. Accepted, with compensations: no application route
exposes the table to an administrator; the only application readers are the
pull-time service principal and the owning member; a break-glass read emits
an audit record. The operator can still observe that exclusions exist and how
many — not what. Under P2 this is reframed for the buyer as the control that
keeps HR one-on-ones, interviews, works-council and accommodation
conversations, and privileged calls out of the record. Ships in phase 2.

**8. Deliberately deferred, recorded so the deferral is a decision.**

- **Option C (ECHO-hosted).** Its own ADR, opened by any one of: a qualified
  buyer refusing to operate a container as a condition of purchase; a second
  organization onboarded while one operator runs both boxes; or the
  deployment-maturity gate failing twice for the same cause. C must supersede
  the product-control boundary clause by clause, in writing.
- **Local-only mode** (`jsonl-outbox`) — retire-scope question, decided
  before phase 4a.
- **Model-provider terms** — phase 3 entry condition, per decision 6.
- **`feat/onboard-slice-1`** — push to preserve RFC-0001 and the record of
  why; build no further slices. A preservation push of existing commits, not
  new phase-1 code.
- Postgres, service extraction, push delivery, device attestation, offline
  mode, and federation revival remain out of scope.

**What gets harder, accepted rather than hidden.** Authorization must scope
reads and publication targets, not only actions. The organization's server
becomes load-bearing for daily use and offline capture is surrendered at
phase 3. Signing concentrates from N machine signers to one custodian,
compensated by off-host signed head checkpoints before the last machine
retires its receipts. Reviewer capacity becomes the central product risk and
gates phase 5 quantitatively.

## Migration, rollback, and evidence

The phased path, with per-phase entry, exit, kill, and hold criteria, is
[server-core migration plan v3](../product/2026-08-17-server-core-migration-plan-v3.md).
Phase 0 ends with this ADR; phase 1 is authorized on its acceptance.

**Evidence.** An isolated, test-gated spike executed the mechanical half of
phase 1 and the reversible part of phase 4a on branch
`migration/server-core-relocate-retire`, off pinned baseline `4665c3a`:

- 54 files relocated byte-identical into
  `services/organization-authority/src/processing/` behind a
  `check:boundary`-enforced seam; 6,733 lines deleted with zero insertions;
  machine `src/` reduced 33,407 → 18,052 non-test LOC.
- Every commit gated on a full `npm run check` observed green, with
  clean-rebuild verification at both checkpoint tags.
- Deletion was test-driven and self-limiting: 2 of 13 retire candidates came
  off; the remaining 11 were refused with named living-importer proofs, and
  the boundary checker's unreachable-module oracle reported zero orphans,
  making the held list exhaustive by construction.

**Known consequence surfaced by the spike.** The machine package now
runtime-depends on the unpublished workspace-local authority package and is
not in `bundleDependencies`; a packed machine tarball is unshippable and the
dependency direction is machine → server. This is phase-2 scaffolding — the
dependency disappears when the machine stops consuming processing at
cutover — and the branch is explicitly non-shippable until then.

**Rollback.** Tags `pre-migration/4665c3a`, `checkpoint/relocated`, and
`checkpoint/retired` are verified rollback points; the phase-0 baseline
rollback was exercised before any code moved. `main` was never modified and
nothing was pushed. Reverting the whole line of work is deleting one branch.

**Reversibility boundary.** Everything through phase 2 is reversible. Phase 3
step 2 is the one-way door: raw transcripts flow to the server for real, and
machine keys retire. This ADR is the only custody gate in the plan;
everything downstream manages operational risk, not custody.
