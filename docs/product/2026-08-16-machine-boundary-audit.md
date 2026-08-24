# Machine boundary audit — per-component ledger

**Status:** reference ledger backing the fates table in
[2026-08-16-server-core-migration-plan-v2.md](2026-08-16-server-core-migration-plan-v2.md).
Measured at `main` `4665c3a`; non-test LOC (`*.ts` excluding `*.test.ts`).
Fate assignments are judgment (±10%); counts and file paths are exact.

## The one problem

Every retired component answers the same constraint: **durable,
security-relevant state lives on hardware the operator of the record does
not own, cannot reach, cannot monitor, and cannot trust.** Read the table as
a derivation, not a list.

| Because you cannot… | …you had to build | ~LOC |
| --- | --- | --- |
| restart the machine | self-supervision: launchd agent, installation record, lifecycle locks | 2,199 |
| deploy to the machine | a self-update fleet with validation and rollback | 2,561 |
| back the machine up | manifested backup/restore with named fault points | 1,474 |
| trust the machine | enrollment, invitation files, pinned CA, per-installation signing key | 2,600 |
| secure the machine | secret-file hardening down to macOS ACL inspection | 675 |
| give it a database | transactions faked on a filesystem: locks, atomic writes, create-once slots | 1,900 |
| verify what it writes | a submission protocol with receipt binding and ten failure modes | 1,056 |

## Fate: RETIRED (machine) — ~17,000 LOC

### "Is this machine installed, current and alive?" — 4,760

- **`src/product/operator-lifecycle.ts` (1,628)** — owns the installation
  record (version, config hash, `node_path`, `cli_path`, plist paths);
  drives `bootstrap`/`init`/`reconfigure`/`doctor`/service actions; three
  drift detectors (`requireCurrentRecord`, `requireInstallationIdentity`,
  byte-exact plist ownership); ~140 lines exist solely because launchd does
  not inherit a shell environment (service-safe credential refs). Its
  offline safety check (validate adapters statically, contact no provider)
  is the one idea that transfers: recovery must not depend on provider
  uptime. *Why retired:* every check asks "is this laptop set up right";
  a deployment is immutable and a laptop only logs in.
- **`src/product/update/` (2,561)** — internal-live self-update: pulls
  release bytes, validates against the authority, installs in place,
  records receipts, rolls back. *Why retired:* you deploy a server; a
  version handshake replaces a fleet updater.
- **`launchd-service.ts` + `lifecycle-lock.ts` + `spawn-sanitized-child.ts`
  (571)** — plist rendering/`launchctl`, config-keyed exclusive locks and
  maintenance leases, scrubbed-environment child processes for npm
  operations. *Why retired:* one supervisor, serialized deploys, no
  runtime npm.

### "Can this machine be recovered?" — 2,740

- **`src/product/state-backup.ts` (1,474)** — manifested backup with roles,
  integrity evidence, consistent SQLite copy, validated restore, named
  fault points. Note: it protects only the machine database
  (`echo-brain.sqlite` hard-coded) — the then-current server used a separate
  restore mechanism, since removed with the legacy deployment. *Why retired:*
  server backup is policy on the org box.
- **`src/infrastructure/filesystem/` (862)** — process file lock, atomic
  write (temp/fsync/rename), atomic create. *Why retired:* a database has
  transactions. First thing to grow back if a local queue ever appears.
- **`src/product/storage/` (404)** — machine-side cycle state in SQLite.
  *Why retired:* cycle state moves into the server store where it is
  inspectable.

### "Which machine is this, and may it speak for the org?" — 2,624

- **`src/product/organization/state/` (1,637)** — installation-owned trust
  state: signed org identity, accepted enrollment, derived composition
  facts; deliberately stores signed values, never bearer grants. *Why
  retired:* "who am I" becomes a session lookup.
- **`src/product/organization/enrollment/` +
  `client/authority-ca-fetch.ts` (605)** — invitation reading, enrollment
  with fail-closed clock-skew bounds, CA fetch and pinning. *Why retired:*
  enrollment becomes login. This block caused the EC2 cutover breakage;
  the class disappears.
- **`src/product/machine/security/` (357)** — exportable software signing
  key in 0600/0700 state, descriptor records the lower assurance
  explicitly. *Why retired:* machines stop signing when machines stop
  being parties to the record. Returns as "device attestation" if ever
  accepted — budget it consciously.

### "How does a laptop keep a secret?" — 675

- **`secure-local-files.ts` + `credentials.ts` (675)** — 0600/0700
  enforcement plus macOS extended-ACL inspection (deny-only accepted, any
  allow rejected); resolves Granola/Slack credentials with containment
  checks. *Why retired:* org credentials live in the server store and
  never touch a laptop.

### "How do we trust what a laptop writes?" — 1,056

- **`record/record-submitter.ts` (565) + `record/ports.ts` (279) +
  `client/http-organization-record-client.ts` (212)** — envelope build,
  evidence attachment, submission, receipt-binding verification, ten named
  failure modes (`envelope_digest_mismatch`, `receipt_binding_mismatch`,
  `permanently_rejected`, …). *Why retired:* the writer stops being a
  remote semi-trusted client. The transport dies; the failure taxonomy is
  ported to the in-process path first (plan phase 4a).

### "Where does the workflow keep live state?" — 1,032

- **`approval/decision-node-store.ts` (1,032)** — each decision as a
  directory of create-once slot files (`requested.json`,
  `published-<surface>.json`, `resolved.json`); slots written exactly
  once; the frozen presentation contract means a posted card is never
  reinterpreted. *Why retired:* the invariant survives as unique
  constraints; the filesystem implementation does not. Highest-risk
  deletion — rebuild the guarantee before deleting the files.

### Local-mode leftovers — ~4,100

- **`config.ts` (431) + `adapter-diagnostics.ts` (142) +
  `retired-founder-provenance.ts` (274)** — local config validation with
  mount-table classification; adapter probing for `doctor`; the founder
  cutover fence with its recovery runbook.
- **`jsonl-outbox-delivery-surface.ts` (~680)** — the local-only delivery
  fallback. Dies iff local-only mode dies (plan phase 0.6 decides).
- **`cli.ts`, ~2,600 of 3,179** — 21 of 28 leaf commands: `bootstrap`,
  `init`, `reconfigure`, `doctor`, `validate-config`, `run-once`,
  `backup`, `restore`, `update apply`, six `service` actions, hidden
  `service-run`, `organization enroll`/`status`/`refresh`/`record-flush`/
  `rebind`.

## Fate: RELOCATED (machine) — ~14,600 LOC

- **`src/core/` (2,184)** — the contracts (meeting, decision set, brief,
  approval, envelope, receipt; 1,067 LOC of canonical validation) and the
  four-stage cycle with per-stage deadlines and dead-lettering. The dedupe
  chain is already content-derived: `meetingProcessingKey` →
  `approval_id = sha256(key)` → envelope `idempotency_key`. Lands in the
  processing module unchanged.
- **Wiring: `composition.ts` (572) + `default-adapters.ts` (478) +
  `adapter-factories.ts` (267) + `runtime.ts` (150)** — the record-sweep
  half dies with the submission transport.
- **`adapters/meeting-sources/granola/` (1,689)** — a portable HTTPS
  client (static `grn_` bearer, no OAuth); relocates unchanged; joined
  later by platform-native org ingestion (plan phase 5).
- **`adapters/decision-processors/` (1,707)** — LLM processor + four
  provider clients + structured-text fallback; one call site replaces N
  laptops.
- **Slack surfaces (3,884)** — approval card render/post/poll (2,015),
  shared web-api client (954), delivery surface + receipt store (911).
  Riskiest move: the frozen-contract guarantee must be rebuilt against
  the database, and cards freeze the credential ref (drain gate at
  cutover exists because of this).
- **`approval/decision-node.ts` (1,051)** — the decision-chain substrate
  (requested/published/resolved events, links, source locator, frozen
  presentation contracts). Distinct layer from the record log (candidate
  lifecycle vs post-record truth) — relocates, does not dissolve.
- **Authorization stack (~1,630)** — `approval-action-authorizer.ts`
  (753), evidence modules (357), `reviewer-publication-preflight.ts`
  (176), `runtime-access-controller.ts` (128), gate (16). Grows on
  arrival: must scope reads and publication targets, not just actions.
- **`slack-identity-link-coordinator.ts` (193)** — becomes the web
  identity-link flow.
- **`record/adapters/protocol-record-envelope-builder.ts` (268)** — still
  builds the canonical envelope; writes in-process.

## Fate: RETIRED (authority) — sized in phase 2

The pass v1 missed: 29 of 42 repository-port methods and 6 of 14 tables in
`organization-authority` serve machine enrollment, access leases, or
internal-live self-update; the schema binds `enrollment ≡ installation`
one-to-one. Deleted as plan phase 4b after `enrollment_id →
principal/session` re-keying. Sizing belongs to phase 2, when the session
model fixes what replaces each table.

## Fate: STAYS (machine) — 1,727 direct LOC at lean-v1 checkpoint

Measured from implementation commit
`fd3e2a7191fafa493376b14c118f4c9ef8772b42`, the config-free Person client is
**1,703 non-test TypeScript LOC across six files** plus **24 added lines** in
the root CLI dispatch, for **1,727 direct machine LOC**:

| Person-client file | LOC |
| --- | ---: |
| `authority-client.ts` | 497 |
| `client.ts` | 290 |
| `commands.ts` | 268 |
| `index.ts` | 32 |
| `requests.ts` | 153 |
| `session-store.ts` | 463 |
| **Person-client subtotal** | **1,703** |
| Root `cli.ts` integration delta | 24 |
| **Direct stays estimate** | **1,727** |

This count excludes tests, JSON boundary manifests, and the shared 139-line
organization-API session validator. It includes login/session lifecycle,
the three retained reads, member exclusion control, and Slack identity
linking. The old installation-authenticated readers remain until the later
Phase-4 deletion; they are compatibility source, not additive final-client
LOC. This measured implementation replaces the earlier ~1,400 estimate.

## Corrections applied since the conversation audit

- Command surface: 28 leaf commands (27 advertised), not 26; 5 survive,
  2 become web flows, 21 are deleted.
- v1 phase 0.3 removed: dedupe keys were already content-derived; the real
  identity work is the record log's `UNIQUE (installation_id,
  idempotency_key)` re-scope.
- v1 phase 0.4 answered: decision-node vs record log are different layers;
  no "relocated" shrink.
- The authority's own retirement pass added as a fourth fate.
