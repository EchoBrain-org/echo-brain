# Connector and context capture integration V1

**Status: implementation for source testing; production activation is deferred.**
This combines the connector implementation at `577c065` and the context
foundation at `08eb41d`. It implements the ingestion-only direction in the
[foundation design](2026-10-01-context-intake-foundation-v1-design.md).
It does not accept the proposed design or ADRs by implication.

## Implemented path

```text
Configured provider source and current read authorization
  -> provider-owned classification and typed mapping
  -> shared SourceEnvelopeV1<ContextCaptureContentV1>
  -> Authority identity, representation and policy checks
  -> authorized immutable SQLite capture OR request-only result
```

The envelope, structured payload, semantic revision builder and validation live
in `organization-processing/core`. Providers depend inward on that contract;
they do not import Authority service internals. Authority retains policy
selection, current authorization, transaction fencing and storage ownership.

`createContextSourceIntakeV1` binds a configured source identity, organization
and disposition. It serializes pulls, checks the read grant before and after a
single source pull, owns returned bytes before an asynchronous recheck, and
passes them to the existing shared intake. The default pull limit is 50; each
provider may impose a lower bound. Returned cursors are caller-owned and are
returned only after successful admission of the batch. Cancellation and identity
drift prevent admission. A read grant never implies a retention grant.

The opt-in provider profiles in
[`provider-context-intakes-v1.ts`](../../services/organization-authority/src/composition/provider-context-intakes-v1.ts)
make the integration choices explicit:

| Source  | Mapping and representation                                                                                                                                                                                                                                          | Authority disposition                                                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Granola | Reuses the one configured meeting adapter. Selected normalized summaries, notes and transcripts become a bounded exact snapshot, or a pointer. A source start time produces a meeting payload; otherwise a plain-text note payload. Participant refs remain opaque. | Explicit retained policy with synchronous transaction fence, or request-only                                                                     |
| Jira    | Uses the existing person-bound transport and fixed configured project. Preserves ticket key, status, labels, provider update time, optional priority and opaque assignee account reference. Body is omitted for a pointer.                                          | Request-only by default. An explicit Authority binding may retain pointers only through the shared SQLite admission fence; excerpts are refused. |
| Slack   | A provider-only, pointer-only adapter reads one fixed authorized channel and maps message coordinates, selected metadata and a Slack-provided permalink. It has no Authority composition, configured read scopes or registration.                                   | No content capture source is registered.                                                                                                         |

Granola still uses its existing organization API credential directly. This
integration does not add another setup, Nango sync or background poller. Jira
reuses its transport and current-grant fence, with no new OAuth implementation.
Jira date-only due dates are omitted rather than converted into invented UTC
instants. Provider display names never create directory identities.

Capture revision IDs commit semantic content and optional predecessor, excluding
poll time and adapter implementation version. An unchanged replay deduplicates;
changed metadata or representation creates a new immutable revision. A snapshot
keeps its exact full selected text; its bounded passage list need not cover every
character. Pointer metadata is still content and requires policy authorization.

## Source proof

The Authority integration tests compose actual provider implementations with
fake provider responses, then use the shared intake and real SQLite:

- [Granola integration](../../services/organization-authority/test/granola-context-source-intake-v1.test.ts): actual meeting adapter over a fake Granola API client; one configured pull, retained captures, immutable replay/change, restart and retention revocation.
- [Jira integration](../../services/organization-authority/test/jira-context-source-intake-v1.test.ts): actual bounded HTTP transport/parser over fake HTTP responses; default request-only capture, explicit retained-pointer admission, replay/change, SQLite restart, grant and custody-fence revocation, and organization/disposition refusal.
- [Slack provider adapter](../../providers/slack/server/test/context/slack-context-source-v1.test.ts) and [transport](../../providers/slack/server/test/context/slack-context-transport-v1.test.ts): fake Slack API responses exercise fixed-channel pointer mapping, grant fences, bounded paging and provider-response validation. They do not compose an Authority intake or prove configured Slack scopes.
- [Intake composition](../../services/organization-authority/test/context-source-intake-v1.test.ts): provider-byte ownership across async checks, concurrent pull exclusion, retry cursor ownership, cancellation and identity drift.

These are local source proofs. They are not provider-live, artifact, deployment
or customer acceptance qualification. Real Slack/Nango and Granola probes from
the connector review remain separate work.

## Connector recovery repairs included

Startup recovers durable approval outcomes without reaching Slack/Nango for
terminal card redraw. Periodic presentation attempts are bounded to one terminal
card, fairly rotated and cancellable. Optional presentation failure cannot
prevent required durable processing or its search reconciliation.

Lost Slack connection rebind verifies the same app/workspace/bot, then checks
that the previous Nango connection is still absent. Current owner and local
state fences run after the last provider await and before the synchronous
credential write. This is a fresh remote observation, not an atomic transaction
with Nango. [ADR-0027](../decisions/ADR-0027-rebind-lost-nango-slack-connection.md)
retains its proposed status.

## Shared Jira connection flow

`echo-brain person tools connect --tool jira` now follows the shared browser and
wait pattern. The Jira client fragment supports status/cancel by attempt ID and
disconnect; the separate `person jira` command family and shared-server Jira
routes are removed. Provider-owned status discovers consent and verifies the
current Person, configured site and account before committing a grant. Durable
attempt status survives restart, and local cancellation wins over in-flight
completion. The client prints no consent URL or Nango connection locator.

This is connection plumbing with synthetic-provider proof. It adds no content
pull command, source registration, scheduler, retention grant or Jira production
enablement. See [the Jira provider](../../providers/jira/README.md) for commands
and the remaining live qualification boundary.

## Disposable local rehearsal profile

The disposable local option uses a separate Authority with test accounts. The
[local rehearsal runner](../../services/organization-authority/README.md#disposable-local-connector-preparation)
creates isolated configuration, state and Person paths. It first prepares and
preflights an empty root, then builds, bootstraps, serves only on
`127.0.0.1:39489`, and uses the isolated `person -- ...` client for invitation
login and provider consent. Credentials install and finalization run only while
that listener is stopped. A second serve owns one private Unix control socket
for authenticated `capture` and `cycle-once` requests.

The runner does not create the public HTTPS endpoint: a dedicated test origin
and matching OIDC callback, human provider credentials, browser login and human
approval remain required. Bootstrap needs only its public-origin, owner and
OIDC inputs. The first serve additionally needs Nango and Jira cloud inputs;
Jira may connect and capture before Granola finalization, while its configured
project is needed at capture. Granola/OpenRouter inputs belong to the later
stopped credential-install/finalize phase. It never reuses a staging session or
origin. Its receipts contain hashes and counts rather than provider content,
cursors or credentials. This profile is local-only and `qualified: false`.

Two source-tested building blocks support this local profile; real-provider
qualification remains the outstanding live proof:

- Jira's server-only `captureConnection` derives a transport and current-grant
  fences from the authenticated Person's stored connection. It accepts no
  caller-selected account, site or connection locator. The
  [connected-capture test](../../services/organization-authority/test/jira-connected-capture-intake-v1.test.ts)
  connects this actual handoff to shared request-only intake and proves that
  reconnect and disconnect invalidate it before another provider read.
- `runContextCaptureRehearsalV1` performs one pull of 1–5 items through an
  already-authorized intake with a cooperative deadline. Its receipt contains
  source identity and revision hashes, source type, admission results and
  counts. It emits neither provider contents nor opaque cursors. The trusted
  intake remains responsible for checking limits and current authorization
  before any durable admission; a receipt wrapper cannot undo prior writes.

Granola HTTP JSON is now limited to 2 MiB while streaming, before parsing.
Missing or misleading Content-Length cannot bypass that limit. Oversized inline
transcripts use the existing paged fallback; each page is bounded and assembled
transcripts are limited to 16 MiB. These are provider transport limits, separate
from the selected context snapshot's 128 KiB limit. Oversized data is rejected,
never silently truncated. Focused source tests cover cancellation and fallback;
real provider qualification is still pending.

Granola capture is a retained, initial-owner-scoped qualification observation
under the shared capture foundation. It reads the current admitted cursor but
does not advance it. The legacy processing cycle remains the single owner of
meeting intake, approval publication and that cursor; `cycle-once` invokes one
such cycle only when the manually scheduled service is active. Jira remains
request-only: its current Person grant is checked around the request and its
capture is never retained. There is no scheduler or automatic convergence.
Manual source polling does not block the existing derived approval,
presentation, or search-reconciliation wakes after a manual cycle.

## Staging connector rehearsal V1

The selected live-test target is the existing staging Authority. A separate,
versioned opt-in profile reuses its HTTPS origin, Google sign-in and owner
session. The local runner retains its isolated-state and origin guards.
The profile is embedded in the existing nonsecret onboarding input, installed
privately by the host wrapper, and selected only on the exact staging origin.
Its closed configuration fixes the Jira cloud, integration and project, plus
the `initial-owner-granola-retained-jira-request-only-v1` capture policy.

This is an explicit staging qualification selection. It does not accept
ADR-0026 or enable the ordinary Jira release gate. The selecting composition
mounts provider-owned Jira connection commands and one authenticated rehearsal
endpoint through a neutral HTTP runtime port. It does not select the ticket
reader or the additional Ask route. Existing Slack setup and approval delivery,
the synthetic release canary, periodic processing and telemetry keep their
ordinary paths.

The owner Mac runs `authority:staging-connector-rehearsal` with the expected
release ID and the exact nonsecret profile. The client verifies the staging
session and uses the existing bounded Person transport; no bearer credential
enters command arguments, host control, output or a test receipt. The server
compares the expected release and profile digest and authenticates the exact
initial owner. Each capture pulls 1–5 items under the runtime's exclusive work
lane, propagates cancellation, and releases only validated counts and hashes.
The current-owner and source/grant checks apply around provider reads and
durable admission. Concurrent capture requests are refused rather than queued.

Granola uses the same admitted source object as ordinary meeting processing.
Its separate owner-scoped capture policy permits retained observations; this
test never moves the legacy meeting cursor. Ordinary polling remains the cursor
owner, so an observation may legitimately contain zero items. Jira capture
remains request-only and leaves no durable ticket content. Neither source
adds graph projection, retrieval, Evidence Desk or Ask behavior.

Jira consent attempts and connection references live in a private rehearsal
sidecar outside the canonical Authority databases. A marker binds that sidecar
to the Authority lineage, initial owner and profile digest. Same-profile process
restarts can resume consent; a different binding fails closed. The sidecar is
not an additional canonical database or a recovered Person grant. Host recovery
must follow the explicit cleanup/refusal rules in the
[deployment guide](../../deploy/organization-authority/README.md).
Remote Nango connections require explicit disconnect/revocation when retiring
the rehearsal; a local reset alone cannot prove remote cleanup.

The [service guide](../../services/organization-authority/README.md#staging-connector-rehearsal)
owns the commands. Source tests are not live qualification: the server image,
matching Person client and reviewed host tooling must first be deployed through
the existing operator lane. Every receipt remains `qualified: false`; successful
captures are evidence for those observations, not blanket provider acceptance.

## Boundaries before activation

The general production profile registers neither shared-capture source in a scheduler.
The explicit staging profile mounts only the bounded observation operation.
The existing meeting approval path remains the production path; a later startup
profile must select a single owner for each source cursor, rather than polling
the same source through both paths. Jira remains production-disabled. Slack bot
approval history is not a personal content read grant.

Malformed or oversized provider items fail the bounded pull without returning a
cursor. Earlier committed captures can be replayed and deduplicate, but a
permanently invalid item still requires intervention. This slice adds no retry
loop, rejection ledger or skip policy. Durable rejection accounting and cursor
progress past bad items must be designed before unattended ingestion. Granola's
transport bounds limit memory use; they do not solve the existing bad-note
retry problem.

Production activation additionally needs accepted capture policy, registered
current read and retention authorities, retention lifecycle/deletion decisions,
capacity checks and live provider qualification. The factories require these
authority ports; they do not synthesize permission from a working credential.

The user-approved next-round Slack direction is pointers plus a retained message
snapshot under explicit Authority composition. It is deferred: no current Slack
adapter retains message text, and no read grant selects retention. That round
must also define the policy for provider message edits and deletes, including
which revisions remain retained and when retained snapshots are removed. The
current local and staging runners remain Jira request-only and have no Slack
source.

Graph projection, enrichment/learning, Evidence Desk, retrieval, Ask, release
audits and response schemas are unchanged. Request-only Jira captures disappear
with the request; they do not yet enrich a durable graph or feed Ask through
this capture path. The normal production Jira gate is unchanged.
