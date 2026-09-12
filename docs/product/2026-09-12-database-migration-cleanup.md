# Database schema cleanup and offline transition

Date: 2026-09-12. Source audited: `2f338552c16de80ad73600e86dd66cf78a11af4f`.
Status: cleanup implemented locally with populated conversion coverage. Existing
SQL baseline bytes and live databases are unchanged. Production remains pending.

## Migration verdict

Startup does not upgrade the canonical Authority-state databases. Baseline
appliers require empty databases; the pre-open guard rejects incompatible
schemas. The new offline converter supports one explicit predecessor and writes
a separate converted copy. The release CLI's `legacy-staging-host-v1` transition
updates host tooling, not databases. The auxiliary meeting-journey telemetry
store has its own V1-to-V2 upgrade; it is outside the canonical role inventory.

If production retains the August 23 `c186576` lineage found in historical
deployment evidence, an explicit state migration is required. That historical
source is not proof of production's current installed schema. Removing the
retired storage below is handled by the new explicit staging-era transition.
The converter does not claim support for the unverified August 23 lineage.

| Database role | Historical source | Audited predecessor | Relevant transition |
| --- | --- | --- | --- |
| Authority | V1, 18 tables | V4, 22 tables | Provider-specific source processing replaced; private approvals and quarantine added; membership email column added. |
| Control plane | V1, 16 tables | V2, 20 tables | Private approval evidence added; Slack-link challenge gained DM and recipient bindings. |
| Record log | V1, 5 tables | V2, 5 tables | Policy-fact triggers also accept the private approval's `selected_policy_id`; table/column counts alone miss this change. |
| Record derived | V1, 9 tables | V1, 9 tables | Schema retained, application materializer and readers retired. |
| Retrieval facts | V1, 2 tables | V2, 3 tables | Related-atom pairs added; regenerate derived search state. |
| Retrieval lexical/content | V1, 3/2 tables | V1, 3/2 tables | Baseline bytes unchanged in this comparison. |

The current Authority V1 foundation and control-plane V1 foundation differ from
their historical bytes despite retaining V1 filenames. A migration must match
the actual source artifact and schema digest, not infer compatibility from a
filename, `user_version`, or the broad `clean-v1` release label. Freeze the
currently accepted bytes; do not rewrite historical baselines during cleanup.

## Concrete removal scope

The audited predecessor constructs **64 application tables** across seven roles.
The implemented target has **42 tables** across six roles: Authority V5 has 18,
control V3 has 11, record log V3 has 5, and the three retrieval roles retain 3/3/2.
Counts exclude lineage-manifest tables, SQLite internals and auxiliary telemetry
stores. These are schema counts, not measured production rows or disk savings.
No VACUUM or historical-generation pruning is performed.

| Area | Implemented removal | Current evidence |
| --- | --- | --- |
| Authority | 4 of 22 tables | No shipped reader/writer references; no retained foreign key or trigger depends on them. |
| Control plane | 9 of 20 tables | Retired reaction-approval/activation persistence; current private DM approval uses separate tables. No retained foreign key or trigger depends on these nine. |
| Record derived | All 9 tables and the database file | Historical bootstrap initialized metadata/cursor; the other seven tables have no shipped readers/writers. Current reads/search use the canonical log and permission facts. |
| Record log | One redundant index | Its exact columns, order and collation are already covered by a UNIQUE constraint's index. Preserve every log table and record. |

Authority removal set:

- `authority_provider_human_action_reproofs`
- `authority_record_write_inputs`
- `authority_record_write_receipts`
- `authority_live_v4_receipts_v2`

Control-plane removal set:

- `organization_approval_binding_contracts` and `organization_approval_binding_current`
- `organization_approval_action_capability_contracts` and `organization_approval_action_capability_current`
- `organization_approval_activation_resources` and `organization_approval_activation_commands`
- `organization_person_slack_pending_approvals` and `organization_person_slack_pending_approval_commands`
- `organization_provider_human_action_evidence`

The retired derived role contains `organization_derived_metadata`,
`organization_derived_cursor`, `organization_derived_atom`,
`organization_derived_meeting_snapshot`, `organization_derived_participant_observation`,
`organization_derived_rejection`, `organization_derived_edge`,
`organization_derived_reviewer_policy_exclusion`, and
`organization_derived_member_readable_policy_exclusion`.

The duplicate index is
`organization_record_member_readable_person_fact_by_record` on
`(record_position, atom_order)`. An isolated `EXPLAIN QUERY PLAN` confirmed that
the same ordered lookup uses the existing UNIQUE index after its removal.

Conversion requires all 13 retired Authority/control tables and all seven
retired graph tables to be empty. Derived metadata may contain only the matching
organization; its singleton cursor must be absent or zero. Nonempty historical
receipts or projections refuse conversion and remain in the source. Their
disposition requires a separate, explicit plan.

## State that stays

Preserve Authority identity, memberships, sessions, provider identity links,
connection commitments, approval evidence, canonical records, signed receipts,
and record policy facts. Permission facts are actively used, not a redundant
copy of a generic derived graph. Preserve the current source cursor, pending
work, replay receipts, quarantine and outbox state unless an explicit conversion
accounts for each item. No credential or identity can be synthesized from a
hash or silently replaced through onboarding.

Search facts, lexical and content planes are derived but serve different
permission/query responsibilities. Removing a plane is not justified by this
audit. The existing builder cleans interrupted `.staging-*` directories; no
published-generation retirement was found in the inspected path. Bounded
retirement of unreferenced generations is a separate disk-growth opportunity
requiring active-reader, current-pointer and rollback retention checks.

## Implemented transition

[Local converter](../../tools/authority-schema-cleanup.mjs) usage and operator
boundaries are in the [release guide](../../deploy/release/README.md#offline-schema-cleanup).
The converter accepts only a V1 root with exact frozen Authority V4, control V2,
log V2, derived V1, retrieval-facts V2 and lexical/content V1 digests. The four
primary schemas are additionally compared against their actual SQLite objects;
unrecognized tables, indexes or triggers refuse. Same-version historical SQL
variants are not accepted by filename or header alone.

Inspection inventories the private stopped/restored state tree and reports
content-free row counts and digests. Conversion requires that inventory digest
and an explicit candidate source SHA. It copies into a separate private staging
directory, drops only the allowed empty tables and duplicate index, updates
schema identity, then publishes a V2 root with the same Authority, organization,
lineage and creation time. All three primary databases pass exact target-schema,
foreign-key, integrity, and retained-row parity checks. Untouched private files,
auxiliary stores and retrieval artifacts must remain byte-identical. The source
must still match its inventory before output is published.

The source is never modified or activated. No writer is stopped by this tool;
independent quiescence/restoration is a prerequisite. Interrupted conversion
cannot publish a partial accepted state. The old source plus its old release
remain the rollback input before new writes; after cutover, restoring that input
without reconciliation could lose later writes. The receipt is local conversion
evidence, not a backup proof, provider-admission result or release approval.

Fresh initialization, runtime pre-open checks, stopped control commands and the
offline recovery verifier now agree on the six-role root. Bootstrap-only derived
metadata/cursor writes, the public derived initializer, its runtime database
definition, and obsolete positive assertions are removed. Historical
SQL assets, V1 manifest golden bytes and negative compatibility fixtures remain
because source validation needs them. Existing active record fields, signed
shapes, constraints, permission facts and provider commitments are unchanged.

## Validation and remaining release work

Focused tests cover populated signed records, member versus restricted reads,
duplicate append returning its original receipt, retained membership and active
connection state, immutable connection enforcement, private-file parity, unknown
schemas, inventory drift, nonempty retired evidence, unsafe filesystem entries,
hot journals, existing outputs, and interrupted conversion followed by retry.
New baselines and the V2 manifest have pinned golden digests. Recovery coverage
checks the new primary count and published retrieval databases. `npm run check`
passed: architecture boundaries, documentation, lint, build, type checking and
182 test files (2,079 tests passed; one existing test skipped) before the follow-up
scan below. Three additional schema-refusal regressions cover that scan's fix.

The follow-up scan reproduced two metadata-name exclusions that were too broad:
SQL `LIKE` treated the underscore in `sqlite_%` as a wildcard, and a trigger
sharing the manifest table's name was also omitted. Inspection now exempts only
the literal reserved SQLite prefix and the manifest table itself. Retired-table
emptiness uses a bounded existence query instead of hashing rejected contents.
Copied files, the new root and directory entries are flushed before returning
success; an injected flush failure proves no partial output is published.
Stale runtime ownership and release-version documentation is corrected.

The installed staging updater has no database conversion or state-cutover action.
Its ordinary `stage` preflight must refuse this candidate against the old root.
The offline converter alone is not a live migration procedure: quiescence,
snapshot qualification, candidate/data activation and schema-aware rollback must
be supplied by a reviewed operator operation before retaining the current
staging organization on the new schema. Rehearsal replacement remains a separate
human-only destructive path; neither a merge nor a staging request authorizes
silently discarding the existing organization.

Production's exact installed schema is still unknown. Obtain it through the
reviewed operator lane, qualify an isolated restored copy, and extend the
transition only if its actual source differs. A new candidate must be built and
qualified in staging; the `2f33855` staging acceptance does not cover this change.
Do not reset the live organization or discard nonempty retired evidence to make
a preflight pass. Retain backups and temporary copies through the accepted
recovery window; retired search generations remain separate follow-up work.

The underlying pattern was retirement of runtime features without retirement of
their frozen storage contracts. This change connects removal to explicit lineage
versioning, preservation checks and a bounded offline transition.
