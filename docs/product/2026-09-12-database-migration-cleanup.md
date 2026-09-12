# Database migration and cleanup audit

Date: 2026-09-12. Source audited: `2f338552c16de80ad73600e86dd66cf78a11af4f`.
Status: source audit and isolated schema experiments complete; no live data or
shipped SQL baseline changed. Production deployment remains pending.

## Migration verdict

There is no supported database upgrade path in the current runtime. Baseline
appliers require completely empty databases, and the pre-open guard refuses an
incompatible schema version or schema digest without upgrading it. The release
CLI's `legacy-staging-host-v1` migration updates host tooling, not databases.

If production retains the August 23 `c186576` lineage found in historical
deployment evidence, an explicit state migration is required. That historical
source is not proof of production's current installed schema. Removing the
retired storage below also requires a versioned transition from today's staging
state; another fresh-only baseline would repeat the deployment gap.

| Database role | Historical source | Current candidate | Relevant transition |
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

The candidate constructs **64 application tables** across the seven roles,
excluding lineage-manifest tables and SQLite internals. These are schema counts,
not measured production row counts or disk savings. The proposed target has
**42 tables** and retires the derived database role.

| Area | Candidate removal | Current evidence |
| --- | --- | --- |
| Authority | 4 of 22 tables | No shipped reader/writer references; no retained foreign key or trigger depends on them. |
| Control plane | 9 of 20 tables | Retired reaction-approval/activation persistence; current private DM approval uses separate tables. No retained foreign key or trigger depends on these nine. |
| Record derived | All 9 tables and the database file | Bootstrap initializes metadata/cursor; the other seven tables have no shipped readers/writers. Current reads/search use the canonical log and permission facts. |
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

These are removal candidates, not permission to discard historical contents.
Old provider-action and record-write receipts may retain audit value even when
the current runtime no longer queries them. Establish their disposition from a
restored source inventory before building the production transition.

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

## Implementation sequence

1. Obtain exact production image/source, root manifest, role schema digests,
   and content-free row counts through the reviewed operator lane. Use an
   isolated restored copy for migration work. An unrecognized source digest
   must refuse, including historical variants sharing a V1 filename.
2. Specify one bounded offline transition to the lean target, with explicit
   supported source versions. Keep startup free of a generic migration runner.
   Preserve canonical record bytes, hashes and authority/organization bindings.
   Provider-specific source-state conversion belongs with that provider.
   Reconcile or explicitly disposition pending approvals; do not manufacture a
   new human approval or silently discard pending work.
3. Construct new versioned target baselines with only the retained tables.
   Replace the seven-role manifest contract with an explicitly versioned
   six-role contract, updating genesis, runtime validation and recovery tools
   together. Retiring `record-derived.sqlite` without this change makes the
   current verifier reject otherwise healthy state.
4. Validate a populated converted copy: identities and sessions retained,
   record bytes and chain unchanged, owner/member/denied reads preserved,
   approvals and retries not duplicated, rebuilt search current, and foreign
   keys/integrity valid. Rehearse interruptions and rollback before live writes.
5. Retire unused baseline APIs, bootstrap-only derived writes, obsolete table
   inventories and tests for removed runtime behavior. Keep immutable
   historical fixtures and negative compatibility tests needed to prove the
   transition; do not delete them solely because they mention V1/V2/V3.
6. Build and qualify one new candidate through staging, then resume the
   production plan with concrete backup, cutover and rollback evidence. Remove
   temporary copies and superseded paths only after acceptance and the agreed
   recovery window.

## Completed cleanup and validation

Corrected source comments claiming that migrations run on open, that the
pre-open guard is not wired, that current manifests/application IDs do not
exist, and that a retired derived materializer still calls atom identity code.
Documented the remaining derived database as lineage compatibility storage.
No frozen SQL bytes, runtime behavior or persisted state were changed.

Reconstructed all seven historical/current role schemas in in-memory SQLite.
For the proposed removal sets, empty-schema experiments found no retained
foreign-key/trigger references; foreign-key and integrity checks passed. This
proves structural feasibility, not populated-data migration or record parity.
The duplicate-index experiment retained the UNIQUE constraint and indexed
ordered lookup. Private local experiment receipts are retained outside Git.

After installing/building this worktree's dependencies, five existing suites
passed **33 tests**, covering lineage validation/refusals and fresh Authority,
control-plane and record-log baselines. An earlier attempt in the staging
checkout lacked a built kernel export; the successful run used this worktree.

The underlying pattern is **runtime features were retired while their frozen
storage contracts remained, and fresh initialization became the only supported
schema transition**. Close that gap with one preservation-tested migration and
complete retirement, rather than accumulating another fresh-only schema.
