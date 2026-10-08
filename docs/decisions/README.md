# Architecture decision records

Architecture decision records preserve why an important, expensive, risky, or
hard-to-reverse choice was made.

## Lifecycle

1. Create an ADR as `proposed` when the alternatives and tradeoffs are ready
   for review.
2. Mark it `accepted` or `rejected` after the decision.
3. Do not rewrite accepted or rejected rationale to match later history. Only
   lifecycle and relationship metadata may be appended after disposition.
4. When direction changes, create a new ADR. The old ADR changes to
   `superseded` and links `superseded_by`; the new ADR links `supersedes`.
5. Use `updates` only when both records remain necessary to understand the
   current decision.

Decision status does not imply implementation or qualification. Record those
separately.

## Index

| ADR                                                                      | Title                                            | Status     |
| ------------------------------------------------------------------------ | ------------------------------------------------ | ---------- |
| [ADR-0001](ADR-0001-organization-operated-server-core.md)                | Organization-operated server-core processing     | accepted   |
| [ADR-0002](ADR-0002-external-oidc-person-sessions.md)                    | External OIDC person sessions                    | accepted   |
| [ADR-0003](ADR-0003-server-core-lean-authority-contracts.md)             | Server-core lean Authority contracts             | superseded |
| [ADR-0004](ADR-0004-founder-authority-clean-state-reset.md)              | Founder Authority clean-state reset              | superseded |
| [ADR-0005](ADR-0005-person-content-policy-v2-lineage.md)                 | Person content-policy v2 lineage                 | superseded |
| [ADR-0006](ADR-0006-permission-aware-clean-v1-completion.md)             | Permission-aware clean V1 completion             | accepted   |
| [ADR-0007](ADR-0007-lean-layer-4-answer-composition-v1.md)               | Lean Layer 4 answer composition V1               | accepted   |
| [ADR-0008](ADR-0008-echo-hosted-authority-by-default.md)                 | ECHO-hosted Authority by default                  | accepted   |
| [ADR-0009](ADR-0009-retained-authority-data-volume-boundary.md)          | Retained Authority data-volume boundary          | accepted   |
| [ADR-0010](ADR-0010-disposable-related-atom-projection-v1.md)           | Disposable related-atom projection V1            | accepted   |
| [ADR-0011](ADR-0011-bm25-lexical-scoring-v1.md)                         | BM25 lexical scoring V1                          | accepted   |
| [ADR-0012](ADR-0012-person-public-response-privacy.md) | Person public response privacy and internal release witnesses | accepted |
| [ADR-0013](ADR-0013-project-context-v1-contract.md) | Project context V1 contract | accepted |
| [ADR-0014](ADR-0014-unified-source-ingestion-and-document-custody.md) | Unified source ingestion and project-owned document processing | accepted |
| [ADR-0015](ADR-0015-global-and-project-scoped-person-ask.md) | Global and project-scoped Person Ask over authorized evidence | accepted |
| [ADR-0016](ADR-0016-organization-people-directory.md) | Organization people directory for any active member | accepted |
| [ADR-0017](ADR-0017-project-meeting-approval-v1.md) | Project audiences and explicit transcript release for meeting approval | accepted |
| [ADR-0018](ADR-0018-project-settings-v1.md) | Minimum project settings with reversible archive | accepted |
| [ADR-0019](ADR-0019-agentic-ask-v1.md) | Bounded agentic Ask and the evidence desk | accepted |
| [ADR-0020](ADR-0020-minimized-person-layer-1-record-projection.md) | Minimized Person Layer 1 record projection | proposed |
| [ADR-0021](ADR-0021-ask-reach-and-approval-owners.md) | Ask over shared transcripts, refused project choices, and confirmed action owners | accepted |
| [ADR-0022](ADR-0022-agentic-ask-only.md) | Agentic Ask is the only Ask | accepted |
| [ADR-0023](ADR-0023-reader-scoped-upload-releases.md) | Reader-scoped upload audiences and uploader-only request IDs | accepted |
| [ADR-0024](ADR-0024-person-list-open-and-mine-scope.md) | Person list, open by ref, and the mine scope | accepted |
| [ADR-0025](ADR-0025-nango-holds-slack-connection-credentials.md) | Nango holds Slack connection credentials | accepted |
| [ADR-0026](ADR-0026-jira-person-live-evidence-nango.md) | Person-bound Jira live evidence with Nango custody | accepted |
| [ADR-0027](ADR-0027-rebind-lost-nango-slack-connection.md) | Rebind a lost Nango Slack connection under the same credential handle | proposed |
| [ADR-0028](ADR-0028-broadened-layer-1-source-captures.md) | Layer 1 holds the people directory, signed record log and source captures | proposed |
| [ADR-0029](ADR-0029-capture-and-derive-foundation.md) | Project-scoped capture and exact derivation inputs | proposed |

| [ADR-0030](ADR-0030-personal-meeting-custody-and-review.md) | Personal Granola custody and shared in-app meeting review | accepted |
| [ADR-0031](ADR-0031-unified-meeting-approval-core.md) | One meeting approval core with optional surfaces | accepted |
| [ADR-0032](ADR-0032-stored-trigger-runs.md) | Stored trigger runs keep pointers and judgments, not outside text | accepted |
| [ADR-0033](ADR-0033-shared-open-items.md) | Open items are one shared row per affected item, seen by the decision's audience | proposed |

Other decisions remain embedded in `docs/product/` design contracts and
architecture pages. Extract them incrementally when the affected boundary
changes; do not perform a mechanical rewrite that loses context.

Use the [ADR template](../_templates/adr.md).
