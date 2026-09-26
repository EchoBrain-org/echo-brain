# PC-01 project context persistence handoff

PC-01 supplies the database foundation for the frozen
[PC-00 contract](2026-09-21-project-context-v1-contract.md). Project creation,
membership management, project feeds and project-scoped uploads are **not live
yet**. This change does not add HTTP routes, CLI commands, desktop controls,
project Ask, or another worker.

## Fresh Authority V7 state

Fresh bootstrap and the runtime's pre-open lineage verifier now select
`authority-baseline-v7.sql`. V5 and V6 SQL and their explicit historical
V5-to-V6 transition remain unchanged. Current startup refuses old state;
there is no V6-to-V7 migration, implicit reset, or backfill.

V7 stores projects, exact membership-tenure grants and roles, immutable V2
upload originals and initial coordinates, one current association per
original, optional enrichment work, immutable command receipts and minimized
read audits. Composite foreign keys prevent relationships from crossing
organizations or substituting another principal's membership.

The original's audience and its current project association have different
jobs. The audience controls who can read it. The association decides where
it appears. Changing the association never rewrites original bytes, audience,
or the initial association returned by an upload receipt/status.

The fresh schema retains V1 upload tables while today's routes and worker are
still using them. V1 reads cannot see V2 project-audience originals. V1 and V2
share the retained-corpus limits of 100 uploads per membership tenure and
1,000 per organization. This preserves current product behavior during the
implementation sequence; it does not carry historical data into V7.

## Repository integration

`SqliteProjectContextRepositoryV1` implements the PC-00 transaction ports.
PC-02 supplies the currently authenticated Person, selects the operation's
scope, and performs the operation inside a synchronous repository callback.
For a read, PC-02 resolves the current session again immediately before
`revalidateAndAuditRelease`, then returns the exact immutable audited response
after the callback commits. A failed audit, stale authorization, or failed
commit must release nothing. No await or provider call belongs inside a
repository transaction.

Mutation retries use one organization/membership/request-ID namespace across
all new operations. Exact retries return their committed receipts; they do
not restore subsequently removed project members or associations, or enqueue
another enrichment job. A changed operation or payload conflicts.

Each mutation also has its own SQLite savepoint. If an application callback
catches a mutation error and continues, none of that failed operation's rows
or authorization-revision changes can commit. A failed savepoint cleanup
forces the outer transaction to roll back. Repository reads validate their
request codecs as well: empty searches and invalid page limits fail with
`invalid_request` before candidate selection.

`SqliteProjectUploadEnrichmentAuthorizationV1` supplies the existing worker's
future V2 eligibility checks. It requires the exact active uploader tenure
and, for project audience, a current grant to that audience project. Capture
immediately before source/model handoff and recheck before committing hints.
The fresh grant ID prevents removal followed by rejoining from validating an
old snapshot. The worker must also validate immutable original custody before
handoff. PC-02/PC-03 own that wiring; this adapter starts no work by itself.

## Pagination

Cursors are untrusted keysets, not authorization. Each page selects currently
permitted candidates before matching, scoring or constructing public fields.
The scope binding includes operation, selected project, normalized query,
limit, organization and membership tenure. It includes no session, private
authorization revision, global state digest, or hidden result count.

The encoding is base64url of a version byte (`1`), the 32-byte scope digest,
and NUL-separated UTF-8 public ordering coordinates. This keeps maximum
display names within the existing 512-character wire bound even when their
JSON representation needs escaping. Project/feed cursors contain time and
ID; roster/directory cursors contain display name and membership ID; search
adds its lexical score. A well-formed forged position can skip permitted
rows, but cannot grant access. Pagination does not promise a stable snapshot
across requests.

## Remaining integration and rollout

PC-02 adds authenticated application operations and final session checks.
PC-03 exposes those operations through HTTP and the existing runtime. PC-04
and PC-05 wire the Person CLI and native UI. These lanes can implement against
the checked-in contracts and repository independently; activation still
requires their combined proof in PC-06.

Deployment requires an explicit environment reset/reseed and matched server
and client artifacts under the operator playbook. No local product install,
staging reset, production reset, or deployment was performed for PC-01.

## Verification

Focused tests cover fresh-only initialization and old-version refusal,
composite tenancy constraints, restart/replay, original-byte integrity,
shared V1/V2 capacity, private/team/project visibility, independent association
and audience, membership revocation/rejoin, final-page ordering, transaction
escape and rollback, and exact-response audit failure. Enrichment tests cover
the current uploader tenure and audience-project grant before completion.

The combined change uses `npm run check` as its repository-wide gate. Live
two-Person verification and matched-artifact release remain PC-06 work.

The pre-parallel adversarial round reproduced partial writes after caught
database errors and read-input validation bypasses before fixing them.
Dedicated storage, query and authorization adversarial tests cover these
cases, hidden corrupt private rows, separate audience/association grants,
and forged snapshots. The parallel implementation handoff (removed after merge; see Git history)
set lane ownership and integration order.
