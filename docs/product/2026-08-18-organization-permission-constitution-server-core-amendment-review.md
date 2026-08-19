# Server-core constitution amendment review submission

**Submission identifier:**
`permission-constitution-server-core-amendment-v1-review-1`

**Submission state:** submitted for review; disposition pending.

**Submitted at:** 2026-08-18.

**Submitted by:** migration implementation agent under the recorded founder
authorization for reversible Phase-2 work.

**Requested reviewers:** constitution owner/founder and a permissions/security
reviewer.

**Repository baseline:**
`74dee5f5957d3a6f33e155decb39a861e109a46e`.

**Candidate:**
[Organization permission constitution: server-core actor amendment proposal](2026-08-18-organization-permission-constitution-server-core-amendment-proposal.md).

**Candidate SHA-256:**
`ac5c643ea2f94d35b872c829f332074da82cdabad97602a815df0e9d66827e6c`.

The digest binds review request 1 to the exact submitted proposal bytes. Any
candidate edit requires a new digest and a later review request; it must not be
silently treated as the artifact submitted here. The repository artifact is
the explicit submission record and becomes durable when the containing change
is committed.

## Requested review

| Review area | Question | Required response |
| --- | --- | --- |
| Rung 1 | Does Authority signing retain the exact human approval or rejection act and preserve installation-signed V1 history? | `accept`, `request changes`, or `reject`, with rationale |
| Actor versions | Are `installation-v1`, `person-session-v2`, and `authority-processing-v1` non-interchangeable? | `accept`, `request changes`, or `reject`, with rationale |
| Processing scope | Is `pre-record-processing-v1` the minimum sufficient internal read scope, with no human/admin disclosure path? | `accept`, `request changes`, or `reject`, with rationale |
| Audit | Does the proposed versioned `INV-10` evidence keep audit-before-release and avoid a second disclosure surface? | `accept`, `request changes`, or `reject`, with rationale |
| Migration boundary | Does the proposal clearly withhold live cutover, key retirement, and deletion authority? | `accept`, `request changes`, or `reject`, with rationale |

## Evidence supplied

- Constitution v1 is not edited by the submission.
- [ADR-0001](../decisions/ADR-0001-organization-operated-server-core.md)
  records Authority signing, pre-record governance, and the named processing
  service-principal requirement.
- [ADR-0002](../decisions/ADR-0002-external-oidc-person-sessions.md)
  records exact Person-session meaning and the rule that V1 installation
  history is never reinterpreted.
- The candidate states an exact logical service actor and scope, versioned
  Person and service audit evidence, compatibility rules, and explicit
  non-goals.

## Disposition

No reviewer decision is recorded.

- **Status:** pending.
- **Reviewer:** not recorded.
- **Reviewed artifact digest:** not recorded.
- **Decision reference:** not recorded.
- **Required changes:** not recorded.

Documentation validation proves only repository shape, link integrity, and
safety scanning. It is not review acceptance, implementation evidence,
qualification, deployment evidence, or Phase-2 completion.
