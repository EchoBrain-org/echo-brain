# Phase-4b Authority retirement sizing ledger

**Status:** pinned offline sizing evidence; not deletion authorization and not
Phase-2 completion.

**Source commit:**
`74dee5f5957d3a6f33e155decb39a861e109a46e`.

**Decision source:**
[ADR-0002, decisions 9 and 10](../decisions/ADR-0002-external-oidc-person-sessions.md#9-freeze-the-phase-4b-retirement-disposition).

This ledger sizes the exact six-table, 29-method Authority retirement frozen
by ADR-0002. It names the successor or deliberate absence of a successor for
each table and enumerates every immediate non-test TypeScript call site at the
pinned commit. Historical migrations remain immutable. Nothing here permits a
table drop, method removal, V1 reinterpretation, machine drain, key
retirement, or credential movement.

## Measurement contract

The measurements use the pinned Git object, not mutable working-tree bytes.

- **Direct method LOC** is the inclusive physical line span, from first token
  through closing token, of each named method's
  `AuthorityRepositoryTransaction` signature and
  `SqliteAuthorityTransaction` implementation. Comments and blank lines
  inside a span count. The 29 methods own **464 direct non-test TypeScript
  lines**.
- **Call sites** are TypeScript `CallExpression` property accesses whose
  resolved symbol is one of those exact port or SQLite method declarations.
  The scan covers every production source in the Authority TypeScript project
  and excludes `test/` and `*.test.ts`. There are **79 immediate production
  call sites**. Symbol resolution excludes unrelated methods such as the
  authorization fence's separate `grant` method.
- **Affected caller LOC** is the union of inclusive spans of the nearest
  production function or method containing at least one resolved call. There
  are **31 unique immediate caller functions spanning 2,625 physical lines**.
  Some contain retained membership, Person, record-ingest, or integration
  behavior and therefore require surgery rather than deletion.
- Historical SQL definitions are mapped for meaning but are not counted as
  removable LOC. Migrations `0001` through `0011` remain checksummed history;
  retirement, when authorized, uses a later forward migration.
- Shared stored types, row validators, public DTOs, HTTP/client/CLI surfaces,
  and transitive callers are not assigned speculative deletion LOC. They are
  reviewed from the call-site list during Phase 4b. Thus 464 is an exact
  direct surface, not a claim that the final diff deletes only 464 lines.

Path aliases used below:

- `P` —
  `services/organization-authority/src/application/ports/authority-repository.ts`
- `R` —
  `services/organization-authority/src/adapters/persistence/sqlite/sqlite-authority-repository.ts`
- `A` —
  `services/organization-authority/src/application/organization-authority.ts`
- `Q` —
  `services/organization-authority/src/application/admin-queries.ts`

## Size summary

Affected-caller figures overlap across subsystem rows. Only the final union is
additive.

| Retired subsystem | Methods | Direct method LOC | Immediate calls | Unique affected caller functions | Affected caller LOC |
| --- | ---: | ---: | ---: | ---: | ---: |
| Enrollment grants | 5 | 79 | 10 | 5 | 492 |
| Enrollments/installations | 10 | 151 | 35 | 23 | 2,033 |
| Access states | 4 | 63 | 16 | 13 | 1,205 |
| Access-lease requests | 3 | 49 | 4 | 2 | 268 |
| Internal-live releases | 4 | 63 | 9 | 4 | 285 |
| Internal-live update receipts | 3 | 59 | 5 | 3 | 266 |
| **Exact direct total / unique caller union** | **29** | **464** | **79** | **31** | **2,625** |

## Table-by-table disposition

“Successor” means the target meaning after the Phase-3 drain. It does not mean
old rows are backfilled, relabelled, or dropped now.

| Retired table | Historical definition | Successor or no replacement | Required boundary before retirement |
| --- | --- | --- | --- |
| `authority_enrollment_grants` | `0001_single_org_authority.sql:36-53`; admin-command extension `0002_admin_command_idempotency.sql:33-64` | `authority_person_login_grants` (`0009_person_identity_and_sessions.sql:9-61`) is the one-use administrator authorization for initial Person binding. It is a distinct V2 grant, not a rewrite of an enrollment grant. | Every active Person is bound through the exact OIDC bootstrap flow; machine enrollment grants are accounted for; no Phase-3 rollback grant remains live. |
| `authority_enrollments` | `0001_single_org_authority.sql:55-89` | Meaning splits across retained `authority_principals` and `authority_memberships`, `authority_oidc_identity_bindings` (`0009:63-129`), and `authority_person_session_families` (`0009:287-361`). Installation anchors that describe the central workspace remain separately retained metadata. | Additive record, control-plane, audit, and protocol V2 meanings are live; all machines have drained; V1 history remains dual-readable. |
| `authority_access_states` | `0001_single_org_authority.sql:91-128` | No append-only lease-state successor. Current authorization derives from the active identity binding, session family, digest-only access credential (`0009:363-426`), and current membership on each request. Person read decisions use the additive V2 audit (`0010_person_read_decision_audit.sql:5-161`). | Every surviving operation authenticates and re-resolves Person/session state without a positive lease cache; installation routes are no longer operational dependencies. |
| `authority_access_lease_requests` | `0001_single_org_authority.sql:130-143` | **No table replacement.** Authority-owned access/refresh credentials and transactional refresh replace installation requests for renewable access leases. V2 audit records decisions, not lease requests. | Thin-client refresh and every surviving V2 operation are implemented and race-tested; no V1 access-lease request remains necessary for rollback. |
| `authority_internal_live_releases` | `0004_internal_live_release_rollout.sql:9-83` | **No Authority database replacement.** One organization-operated service is deployed through the server release/runbook path; there is no remote machine fleet to direct after drain. | All machines have drained or are held on an already-installed old binary under the Phase-3/4 rules; the server upgrade and rollback procedure is exercised. |
| `authority_internal_live_update_receipts` | `0004_internal_live_release_rollout.sql:85-139` | **No Authority database replacement.** Fleet update receipts cease with the fleet updater. Server deployment evidence belongs to the operations/release record, not a synthetic installation receipt. | Internal-live machine rollout is no longer an operational path and every retained historical receipt remains readable as V1 history if required. |

The replacements above do not collapse the broader re-keying. Before any
retirement, organization-record envelopes and organization-scoped
idempotency, control-plane actor bindings, Authority query audits, and
organization API/protocol clients each require additive V2 contracts while V1
bytes remain unchanged.

## Exact 29-method ledger

Definition spans show `path:start-end`; the parenthesized number is the direct
physical LOC included in the total. Call sites show every resolved production
call at the pinned commit.

### Enrollment grants — 5 methods, 79 LOC, 10 calls

| Method | Definition spans | LOC | Production call sites |
| --- | --- | ---: | --- |
| `grant` | `P:571-571` (1); `R:965-967` (3) | 4 | `A:1391,1443,1504,1603`; `R:1104` |
| `grantByAdminCommand` | `P:572-572` (1); `R:969-971` (3) | 4 | `A:1364,1381` |
| `grantsAfter` | `P:573-576` (4); `R:973-997` (25) | 29 | `Q:249` |
| `insertGrant` | `P:661-661` (1); `R:2432-2452` (21) | 22 | `A:1422` |
| `consumeGrant` | `P:663-667` (5); `R:2486-2500` (15) | 20 | `A:1645` |

**Disposition.** Replace bootstrap authorization with the already-additive
Person login-grant application and persistence. Remove enrollment-grant admin
listing/issuance only after the rollback-grant boundary is closed. Do not
rename old grant audit rows.

### Enrollments/installations — 10 methods, 151 LOC, 35 calls

| Method | Definition spans | LOC | Production call sites |
| --- | --- | ---: | --- |
| `enrollmentByGrant` | `P:577-579` (3); `R:1153-1157` (5) | 8 | `A:1451` |
| `enrollmentByRequest` | `P:580-582` (3); `R:1159-1163` (5) | 8 | `A:1630` |
| `enrollmentById` | `P:583-583` (1); `R:1165-1167` (3) | 4 | `A:397,818,832,1074,1778,1839,2046,2267,2356,2575,2736,2750,3440`; `R:1270,1562` |
| `enrollmentByInstallation` | `P:584-586` (3); `R:1169-1173` (5) | 8 | `A:592,678,1625,3093,3138,3208,3303`; `R:1493` |
| `enrollmentByKey` | `P:587-587` (1); `R:1175-1177` (3) | 4 | `A:1627` |
| `enrollmentsForMembership` | `P:588-588` (1); `R:1179-1191` (13) | 14 | `A:3368,3428,3492` |
| `enrollmentsAfter` | `P:589-592` (4); `R:1193-1218` (26) | 30 | `Q:202` |
| `activeEnrollments` | `P:593-593` (1); `R:1220-1238` (19) | 20 | `A:938,1117` |
| `insertEnrollment` | `P:662-662` (1); `R:2454-2484` (31) | 32 | `A:1637` |
| `revokeEnrollment` | `P:679-684` (6); `R:2607-2623` (17) | 23 | `A:3153,3466` |

**Disposition.** Person identity and sessions replace employee-machine
identity. Calls serving current integrations, record ingress, membership
revocation, and V1 read compatibility must move to their separately versioned
actor meanings; they are not deleted merely because they call an enrollment
lookup today.

### Access states — 4 methods, 63 LOC, 16 calls

| Method | Definition spans | LOC | Production call sites |
| --- | --- | ---: | --- |
| `currentAccessState` | `P:594-596` (3); `R:1366-1377` (12) | 15 | `Q:203`; `A:386,1847,2054,2364` |
| `accessState` | `P:597-600` (4); `R:1379-1390` (12) | 16 | `A:1458` |
| `accessStateByDigest` | `P:608-610` (3); `R:1392-1399` (8) | 11 | `A:2825,2886,3009`; `R:1595,1598` |
| `insertAccessState` | `P:668-668` (1); `R:2502-2521` (20) | 21 | `A:3034,3151,3323,3464`; `R:2483` |

**Disposition.** Replace positive installation access state with
request-current Person/session resolution. Membership and family revocations
remain terminal, but no compatibility layer may manufacture a V2 access lease
or reinterpret an old access-state digest.

### Access-lease requests — 3 methods, 49 LOC, 4 calls

| Method | Definition spans | LOC | Production call sites |
| --- | --- | ---: | --- |
| `accessLeaseRequestByDigest` | `P:601-603` (3); `R:1654-1663` (10) | 13 | `A:2820` |
| `accessLeaseRequestById` | `P:604-607` (4); `R:1665-1676` (12) | 16 | `A:2873,2982` |
| `insertAccessLeaseRequest` | `P:669-669` (1); `R:2523-2541` (19) | 20 | `A:3063` |

**Disposition.** Remove the request/response idempotency path with the V1
installation lease endpoint. Single-use Person refresh is a different
transaction and does not reuse these rows or request kinds.

### Internal-live releases — 4 methods, 63 LOC, 9 calls

| Method | Definition spans | LOC | Production call sites |
| --- | --- | ---: | --- |
| `internalLiveReleaseByCommand` | `P:611-613` (3); `R:1449-1459` (11) | 14 | `A:890,903,969` |
| `internalLiveReleaseBySequence` | `P:614-616` (3); `R:1461-1471` (11) | 14 | `A:1043,1071` |
| `currentInternalLiveRelease` | `P:617-617` (1); `R:1473-1481` (9) | 10 | `A:915,1001,1116` |
| `insertInternalLiveRelease` | `P:670-670` (1); `R:2543-2566` (24) | 25 | `A:964` |

**Disposition.** Retire approval, fetch, and rollout-status application
surfaces when the machine updater is no longer live. Server deployment uses
its own stopped release/rollback procedure and does not emulate a fleet
directive inside Authority SQLite.

### Internal-live update receipts — 3 methods, 59 LOC, 5 calls

| Method | Definition spans | LOC | Production call sites |
| --- | --- | ---: | --- |
| `internalLiveUpdateReceiptByTransaction` | `P:618-620` (3); `R:1522-1532` (11) | 14 | `A:1029,1059` |
| `latestInternalLiveUpdateReceipt` | `P:621-624` (4); `R:1534-1549` (16) | 20 | `A:946,1143` |
| `insertInternalLiveUpdateReceipt` | `P:671-673` (3); `R:2568-2589` (22) | 25 | `A:1091` |

**Disposition.** Retire receipt ingest and rollout aggregation with the
internal-live updater. Preserve historical V1 rows according to the later
forward-migration decision; do not mint server-deployment rows that pretend to
be installation receipts.

## Immediate caller-span inventory

These are the 31 unique nearest production callers behind the 2,625-line
union. The ranges size review/rewrite context; they are not a deletion list.

| File | Functions and inclusive ranges |
| --- | --- |
| `Q` | `installations:192-235`; `enrollmentGrants:237-271` |
| `A` | `requireCurrentAccessState:382-391`; `requireEnrollment:393-402`; `integrationAdminContext:561-639`; `recordIngestInstallationContext:672-702`; `authenticatedActiveInstallationContext:812-865`; `approveInternalLiveRelease:883-990`; `fetchInternalLiveDirective:992-1010`; `recordInternalLiveUpdateReceipt:1012-1111`; `internalLiveRolloutStatus:1113-1170`; `issueEnrollmentGrant:1351-1436`; `existingEnrollmentResult:1438-1466`; `completeEnrollment:1468-1666`; `authenticateReadableSearchRequest:1761-1816`; `readableSearchPersonSnapshot:1833-1951`; `recentDecisionsPersonSnapshot:2040-2142`; `serveRecentDecisions:2238-2333`; `reviewerRecentDecisionsPersonSnapshot:2350-2442`; `serveReviewerRecentDecisions:2554-2656`; `permissionSubjectStatus:2709-2813`; `storedLeaseResponse:2815-2832`; `issueAccessLease:2834-3083`; `revokeInstallation:3085-3179`; `recoverInstallationAccess:3197-3351`; `revokeMembership:3353-3508` |
| `R` | `enrollmentFromRow:999-1141`; `accessStateFromRow:1265-1364`; `internalLiveReceiptFromRow:1483-1520`; `leaseRequestFromRow:1551-1652`; `insertEnrollment:2454-2484` |

## Gates deliberately still open

This sizing artifact does not close any of the following:

- the additive organization-record writer and organization-scoped
  idempotency version;
- Person/control-plane integration bindings and additive audit meaning;
- V2 organization API/protocol operations for every surviving client action;
- the thin-client private session store and measured final client LOC;
- real-corpus Phase-1 evidence, live identity-provider verification, or real
  Slack validation;
- the Phase-3 drain, rollback grants, credential movement, key retirement,
  or hold; or
- a later forward migration that retires the six tables after every entry
  condition is met.

Accordingly, the six tables and 29 methods remain live. This ledger completes
only the offline sizing and table-by-table naming obligation.
