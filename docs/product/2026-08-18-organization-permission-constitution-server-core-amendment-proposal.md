# Organization permission constitution: server-core actor amendment proposal

**Amendment identifier:** `permission-constitution-server-core-amendment-v1`

**Status:** proposed; submitted for review; not accepted and not in force.

**Proposal baseline:**
`74dee5f5957d3a6f33e155decb39a861e109a46e`.

**Proposed update to:**
[Organization permission architecture (constitution v1)](2026-08-09-organization-permission-architecture.md).

**Decision context:**
[ADR-0001](../decisions/ADR-0001-organization-operated-server-core.md) and
[ADR-0002](../decisions/ADR-0002-external-oidc-person-sessions.md).

The constitution v1 source remains unchanged. If this amendment is accepted,
v1 installation-authenticated history keeps its original meaning and the
rules below add versioned Person-session and internal-service meanings. Merely
landing or validating this proposal does not accept it, implement it, or
satisfy a Phase-2 exit gate.

## Proposed actor vocabulary

- **Principal** remains the Authority's stable organization identity.
- **Person** remains the live evaluation-time view of one principal, its exact
  current membership, and its effective identity bindings.
- **Authenticated actor** is the versioned source of one authorized act. The
  admitted actor kinds are historical `installation-v1`, `person-session-v2`,
  and the single internal `authority-processing-v1` actor proposed below.
- **Caller** is the transport or in-process invoker. A caller does not acquire
  authority merely by naming a principal or actor. Authorization derives the
  actor from current Authority state and binds the exact operation to it.
- **Subject** remains the principal whose visibility is evaluated. Ordinary
  Person reads are self-only: the authenticated Person and subject must be the
  same exact active principal and membership.

No installation-era request, envelope, receipt, fact, or audit row is
relabelled as a Person or service act. V1 readers retain the old
installation-authenticated interpretation for as long as that history is
served.

## Proposed trust-ladder rung 1

Replace the forward-looking rung-1 wording, without rewriting historical
rows, with:

> **Canonical envelope.** Human-approved or human-rejected,
> organization-Authority-signed, Authority-receipted, hash-chained, and bound
> to immutable actor and authorization evidence. It may be cited as the
> organization's recorded fact. Historical installation-signed V1 envelopes
> remain canonical under their original V1 meaning.

Authority signing does not turn a processor into a human author. The envelope
must retain the exact approved or rejected human act and its authorization
evidence. A deterministic processor may prepare a candidate; it may not
manufacture the human act that moves that candidate onto rung 1.

## Proposed Person path root

Every new ordinary Person content path begins with all of:

```text
authenticated, unexpired Authority access credential
AND active session family and exact active OIDC identity binding
AND current active membership for the authenticated principal
AND authenticated principal equals the requested subject
AND the operation's separately reviewed content path
```

The credential is only authentication material. It is not a reusable
authorization decision. Each read re-resolves the credential, family,
identity binding, principal, and membership before selection and again before
audited response release. Installation plus access-lease remains a V1
compatibility root only; it is not a root for a V2 request.

## Proposed processing service principal

The one named logical service actor is `authority-processing-v1`. Its one read
scope is `pre-record-processing-v1`:

- test an exact owning member's exact source or meeting exclusion before
  first raw admission;
- read only typed, Authority-admitted pre-record candidates and slots needed
  to process, present, resolve, deliver, retry, or expire that work; and
- perform those reads only inside the Authority-composed processing module.

The scope does not grant a human-content path, ordinary organization-record
read, search, export, report, administrator surface, arbitrary table query, or
permission to return pre-record bytes to a Person. It cannot be delegated to
an adapter or selected by request input. An application split must replace
the current in-process binding with an authenticated, replay-bound service
binding before crossing a process boundary.

The name and scope are proposed authorization semantics, not a claim that a
service-principal database row or generic service-identity framework exists.
No broader service-principal vocabulary is proposed.

No human principal reads raw pre-record content by default. The owning member
may read only the separate exclusion control that member owns. An explicit
administrator break-glass read is a distinct act and must commit its audit
before any selected bytes are released. Direct database access by the box
operator remains inside the infrastructure trust boundary and is not claimed
to be application-auditable.

## Proposed `INV-10` actor evidence update

For a new response-authorization decision, replace the mandatory
installation-only evidence field with a versioned actor binding. Minimum
evidence becomes:

- actor kind and actor-binding version;
- exact requester or service identity evidence appropriate to that actor;
- operation and target or opaque target digest;
- allow or deny decision and closed path or reason code;
- current Person/session state digests, or the exact service-scope version;
- decision timestamp; and
- exact prepared-response digest before byte release.

V1 audit rows retain requester-plus-installation meaning. A V2 Person row does
not synthesize an installation identifier. A service row does not synthesize
a Person. Denials and break-glass audit rows contain no transcript, title,
participant, exclusion coordinate, or other content that would create a
second disclosure surface. Audit failure denies response release.

## Compatibility and non-goals

This proposal does not:

- change any existing envelope, hash-chain, request, receipt, or audit bytes;
- accept a browser transport, live identity provider, or live Slack flow;
- authorize a raw pre-record Person reader or generic administrator query;
- authorize Phase-3 cutover, key retirement, credential movement, or any
  Phase-4 deletion; or
- introduce a generic policy engine, service-principal framework, or
  distributed authorization fence.

The six installation-era Authority tables and their V1 methods remain live
until the later additive re-keying, Phase-3 drain, and Phase-4 entry gates have
all been satisfied.

## Review gate

Acceptance requires an explicit review disposition that answers all of:

1. Does the rung-1 wording preserve the human act while moving the signer to
   the organization Authority?
2. Are V1 installation history and V2 Person/service meanings unambiguously
   separated?
3. Is `authority-processing-v1` limited to the minimum pre-record scope?
4. Does the `INV-10` update preserve audit-before-release without making the
   audit a second disclosure surface?
5. Are the stated non-goals sufficient to prevent this proposal from being
   read as Phase-2 completion or destructive authorization?

The linked
[review-submission record](2026-08-18-organization-permission-constitution-server-core-amendment-review.md)
records submission only. Until a later disposition explicitly accepts this
amendment, constitution v1 remains the governing text.
