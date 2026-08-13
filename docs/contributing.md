# Contributing to ECHO documentation

Documentation changes use the same branch, review, and verification workflow
as code. Capture knowledge while the implementation and evidence are still
available.

## Record types

| Kind | Answers | Lifecycle |
| --- | --- | --- |
| Component | What does this part own, trust, store, and expose? | Living |
| Invariant | What must or must not remain true? | Stable; change explicitly |
| ADR | Why was an important choice made? | Immutable after acceptance |
| RFC | What coordinated change is being proposed? | Proposed through disposition |
| Failure pattern | How can this class of boundary fail? | Preserved; mitigation evolves |
| Playbook | How do I investigate an uncertain problem? | Living and tested |
| Runbook | How do I reach a known operational outcome? | Living and tested |
| Qualification | What did this exact artifact and configuration prove? | Immutable per run |
| Evidence index | Where is bounded proof and how is it verified? | Append-only references |

Do not combine these lifecycles into one growing design diary. Link records
together with stable IDs.

## Required metadata

Durable records use YAML front matter. Use the template for the record kind.
The checker intentionally accepts only the flat scalar-and-list subset used by
the templates; nested mappings and inline arrays are outside schema V1.
At minimum record:

```yaml
schema_version: 1
id: FP-ADAPTERS-001
kind: failure-pattern
title: Provider acknowledgement differs from stored state
owners:
  - unassigned
component_ids:
  - CMP-ADAPTERS
created_at: 2026-08-13
reviewed_at: 2026-08-13
reviewed_ref: 808ac89eaf3e8eba529b356bd80d4509b9a2a293
invariant_ids: []
decision_ids: []
failure_pattern_ids: []
runbook_ids: []
qualification_ids: []
issue_urls: []
```

`reviewed_at` means a human or agent checked the document against
`reviewed_ref`. It is not automatically updated because the file changed.
Use an ISO `YYYY-MM-DD` date for review policy and an RFC 3339 timestamp for
an exact event. Relation fields contain stable IDs, except `issue_urls`.
Use `unassigned` honestly until an owner accepts responsibility.

## Stable identifiers

Use these prefixes. Domains come from controlled component IDs; do not invent
synonyms for an existing domain.

| Prefix | Record |
| --- | --- |
| `CMP-*` | Component landing page |
| `INV-<DOMAIN>-NNN` | Invariant |
| `ADR-NNNN` | Accepted or proposed architecture decision |
| `RFC-NNNN` | Proposed coordinated change |
| `FP-<DOMAIN>-NNN` | Failure pattern |
| `PB-<DOMAIN>-NNN` | Investigative playbook |
| `RB-<DOMAIN>-NNN` | Operational runbook |
| `QMAT-<DOMAIN>-NNN` | Reusable qualification matrix |
| `QUAL-YYYYMMDD-HHMMSS-NNN` | Exact qualification run |

Never reuse an ID. A renamed record keeps its ID. Qualification IDs include a
UTC time suffix in addition to the date when concurrent runs are possible.

## Status is multi-dimensional

Do not use one status to imply several different claims. Where applicable,
record them independently:

Status belongs to the record that owns the claim. ADRs and RFCs own decision
status. Failure patterns own mitigation status. Qualification reports own an
exact run result. Invariants must name their enforcement scope and link proof;
they must not claim global qualification from one bounded run.

An accepted design can be unimplemented. Implemented code can be unqualified,
and a deployed artifact can have an open regression. State each fact directly
rather than inferring it from a generic status.

Accepted or rejected ADR bodies are not rewritten to make history look
current. Only lifecycle and relationship metadata may be appended after
disposition. A replacement changes the old record to `superseded`, links its
`superseded_by`, and links the new record's `supersedes`. Use `updates` only
when both records remain necessary.

## From observation to durable knowledge

When development or live qualification exposes a problem:

1. Preserve the raw receipt without editing it.
2. Write a factual incident or qualification summary for the exact event.
3. Create or update a failure pattern if the lesson can recur.
4. Create or strengthen an invariant if the failure exposed an enduring rule.
5. Write an ADR when the repair makes a significant or hard-to-reverse choice.
6. Add a deterministic regression test or qualification case.
7. Add a playbook or runbook if a human may need to diagnose or recover it.
8. Open a GitHub issue for unresolved corrective work.
9. Mark the pattern mitigated only after the change and linked proof exist.

Closed issues remain linked, but the failure pattern and invariant stay
discoverable.

## Evidence safety

Raw founder-live and customer evidence can contain provider payloads,
infrastructure identifiers, private object locations, credentials, or personal
content. Do not copy those values into the repository.

A tracked evidence index may contain only the minimum sanitized information:

- stable qualification and receipt IDs;
- source commit and artifact digest;
- result and assertion IDs;
- opaque evidence ID and content hash;
- sensitivity class;
- the date and actor that verified the hash.

The real filename, local path, object key, provider identifier, and resolver
mapping remain only in the access-controlled evidence system. Configuration
and state identities in Git must be sanitized digests or opaque IDs.

An exact receipt proves only the assertions it names. Do not cite one stopped
proof as evidence for unrelated failure patterns.

## Pull request expectations

A behavior-changing pull request should answer:

- Which component pages are affected?
- Which invariant IDs are preserved, added, or changed?
- Does the change require an ADR or RFC?
- Does it create or mitigate a failure pattern?
- Which regression tests and qualification cases prove the result?
- Does an operator playbook or runbook change?
- Is the status claim source-only, merged, deployed, qualified, or released?

Prefer links over duplicated prose. Keep component pages short enough to act as
maps; put exact contracts in reference documents and executable schemas.

## Verification

Run `npm run check:docs` while editing durable records. The check validates
metadata and stable IDs, relationships, component/workspace coverage, local
links, exact qualification matrices and results, evidence-index hashes,
historical implementation and regression references, and a bounded set of
private-material leak signatures. Its negative cases run with the normal test
suite.
