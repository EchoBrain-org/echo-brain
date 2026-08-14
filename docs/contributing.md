# Contributing to ECHO documentation

Use the same branch, review, and verification workflow as code. Capture a
lesson while its implementation and evidence are still available; link records
by stable ID instead of building a design diary.

| Record                         | Use it for                                          |
| ------------------------------ | --------------------------------------------------- |
| Component                      | Ownership, boundaries, and navigation               |
| Invariant                      | A rule that must or must not hold                   |
| ADR / RFC                      | Accepted rationale / proposed coordinated change    |
| Failure pattern                | A reusable boundary failure                         |
| Playbook / runbook             | Uncertain investigation / known operational outcome |
| Qualification / evidence index | An exact run / bounded proof lookup                 |

## Metadata and IDs

Copy the appropriate template. Records use flat YAML scalars and lists only.
`reviewed_at` and `reviewed_ref` mean the record was checked against that exact
source commit; updating prose does not update the claim automatically. Omit an
empty relationship field. In V1, ownership lives on component pages; add an
`owners` list to another record only when it names a real owner. IDs are permanent: `CMP-*`, `INV-<DOMAIN>-NNN`, `ADR-NNNN`, `RFC-NNNN`,
`FP-<DOMAIN>-NNN`, `PB-<DOMAIN>-NNN`, `RB-<DOMAIN>-NNN`,
`QMAT-<DOMAIN>-NNN`, and `QUAL-YYYYMMDD-HHMMSS-NNN`.

Keep separate claims separate: accepted design, implemented code, deployed
artifact, and qualified run are not interchangeable. Do not rewrite accepted
or rejected ADR rationale; supersede it with a linked new ADR.

## Turn an observation into durable knowledge

1. Preserve the raw receipt privately and write a sanitized exact-event summary.
2. Add or update a failure pattern and an invariant when the lesson is durable.
3. Add an ADR for a significant or hard-to-reverse repair.
4. Add a deterministic regression test or qualification assertion.
5. Add an operational procedure and issue when recovery or corrective work remains.

Mark a pattern `mitigated` only with linked proof. An `accepted-risk` pattern
requires its risk decision, residual risk, and review date.

## Evidence and PRs

Tracked documentation may contain opaque IDs, source commits, artifact
digests, result and assertion IDs, evidence hashes, sensitivity class, and
verification metadata. Never add raw provider payloads, credentials, personal
content, private paths or keys, infrastructure identifiers, or resolver maps.
An evidence receipt proves only its named assertions.

For a behavior-changing PR, update the affected component and any applicable
invariant, ADR/RFC, failure pattern, tests, qualification, or runbook. State
whether the claim is source-tested, artifact-tested, deployed,
founder-live-qualified, client-live-qualified, or released. Run
`npm run check:docs`; it checks IDs, relations, catalog coverage, links,
qualification/evidence consistency, historical references, and known private
material signatures.
