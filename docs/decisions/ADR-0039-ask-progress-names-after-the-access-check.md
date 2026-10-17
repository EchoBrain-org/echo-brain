---
schema_version: 1
id: ADR-0039
kind: decision
title: Ask streams its progress and names what it read only after the access check
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-PERMISSIONS
  - CMP-PERSON-CLIENT
created_at: 2026-10-16
reviewed_at: 2026-10-16
reviewed_ref: f6a6725981bba13f54793772ac441dad850ef3dc
status: accepted
supersedes: []
superseded_by: []
updates:
  - ADR-0038
  - RFC-0002
---

# ADR-0039: Ask streams its progress and names what it read only after the access check

The founder chose this direction on 2026-10-16 from a two-option mockup and
approved the design,
[Ask progress and internal links v1](../product/2026-10-16-ask-progress-and-internal-links-v1.md),
for build the same day, including its safety rules and trade-off. Acceptance
does not mean the change is deployed or qualified.

## Context and options

A desktop Ask shows "Thinking…" and a timer for up to about two minutes while
the research loop searches, reads, checks access and writes. Staging traces
from 2026-10-11 to 2026-10-16 ran 7 to 74 s. Nothing streams: every hop, up to
the Authority's one `application/json` body, is a single request and response.
[RFC-0002](../rfcs/RFC-0002-agentic-ask-v1.md) left live progress streaming
out of V1 and deferred it to V1.1.

Showing what Ask is reading means sending item names before the answer's
final access check.
[INV-PERMISSIONS-015](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md)
treats that as a new release path, which needs an accepted ADR, wider
enforcement and negative disclosure tests. Under
[ADR-0038](ADR-0038-incremental-access-check-before-model-calls.md), an item
revoked mid-run may stay in model input until the request ends, which that
record describes as exposing it "only to the model".

What to show:

1. **Stages, source kinds and counts only.** No item content leaves before
   the answer, but nothing can be opened until the answer arrives.
2. **Names after the access check the gate already runs before each model
   call.** No extra checks, but names trail by about one research step.
3. **Names after a separate check per name.** That check costs 0.75 to 1.8 s
   with a live source bound (ADR-0038), on the path meant to feel faster.

How to carry it:

- **A. Server-sent events on `/v5`, opt-in by request header.** A disconnect
  still cancels the Ask. Errors after the stream starts must travel inside
  it.
- **B. Start, then read.** The Ask starts and returns an id, and the client
  polls. This works behind any proxy, but it needs a cancel endpoint, limits
  on abandoned runs, and an access check on every read.
- **C. A new route.** Old clients are unaffected either way, so a route adds
  nothing a header does not.

## Decision and consequences

Option 2, carried by A. The wire contract is
`packages/organization-api/src/person-ask-progress-v1.ts`, and the kernel
interface is `agentic-ask-progress-v1.ts` beside the Ask run.

**What may leave the Authority while Ask runs.** Every event is built from
what ECHO ran, never from model output:

- **The stage:** `searching`, `reading`, `checking_access` or `writing`.
- **One `searched` row per research step** (or for the small-scope preload).
  It lists the step's source kinds from the request's own catalog, with a
  live tool named by its tool id. It also gives the number of distinct items
  those search and list reads returned to this person that no earlier read
  in the run had returned.
- **A `reading` count** of items the research model is about to be given in
  full for the first time.
- **Named items.** A name is sent only for an item whose complete released
  text the research model is given for the first time: an opened item, a
  search hit shown in full, or a starting item. Metadata-only rows, related
  references and neighbours an open admitted are not named. Each name is the
  projection an answer citation uses (`PersonAnswerCitationV6`: citation
  coordinates, kind, label, visibility and the open ref). The label is the
  one the answer's source list would show. At most 100 items are named in a
  run.

**What never leaves while Ask runs:** notes, needs, plans, model-written
search terms, Jira queries, bodies, excerpts, scratchpad ids such as `E5`,
desk ids, receipts, round numbers, model or tool internals, and counts that
include anything this person cannot see
([ADR-0012](ADR-0012-person-public-response-privacy.md)). The validators are
exact-key, so an event cannot carry an extra field.

**The gating point.** Names are emitted at the model gate's `before_call`
hook, which runs once per admitted research call, after that call's budget
and access checks. This is the point where the loop marks its scratchpad
entries as read in full. The check before the call covers everything released
since the previous successful check, and every earlier release passed an
earlier check. So every name has passed an access check under this person's
current session, membership tenure, grants and connections. A check that
fails stops the run, so a revocation that a check sees is never followed by
another name. The progress sink is a small typed callback. It is not the
diagnostics observer, which would replace a person's capture sink and copy
full prompts. What the sink throws is ignored, and nothing is emitted after
the run settles.

**The receipt.** The final event carries the released V6 answer, byte for
byte the response today's JSON route returns, together with a receipt. The
receipt is built after the release step has passed: the full final check,
the audit write, and the check after the audit. It comes from the run's own
record and holds:

- `looked_through`, the number of distinct items read in full;
- `elapsed_ms`, the Authority's time from the start of the run to release,
  kept for audit and diagnostics (a client shows the wait it timed itself,
  which also counts the client and the network);
- the run's searched and read rows, merged.

Cancellation, the deadline, a refused check or any other failure sends no
receipt and no further event. Desktop clients remove the names already shown.

**Audit.** Every named item was already audited when the evidence desk
released it, before any of its bytes left the Authority. The request's one
audit record (`echo-agentic-ask-audit-v1`, stored as
`echo-person-agentic-ask-audit-v1`) gains `named_citation_digests` when the
request streamed. It holds the `canonicalSha256` of each named item's
citation, in naming order, each once. That is the same content-free citation
commitment the live-evidence release audit writes. The field appears on
released, cancelled and timed-out records alike, and it is empty when nothing
was named. A request that did not stream omits it, so today's records are
unchanged. There is no extra durable write per step and no label in any
audit.

A run that fails any other way, such as a refused final check or a provider
failure, writes no request record today, and this decision adds none. Its
names are covered only by their desk release audits.

**Security trade-off.** An item is not checked again after the check that
first covered it (ADR-0038). If the person loses access to that one item
mid-run, its name may stay on screen for the rest of the run. It may also be
named for the first time later in the run, if it first reaches a research
prompt after the revocation but before any check has seen it. What is
exposed is the item's name and open reference, never its body, and only to
the same person in the same request, who could open the item when it was
released. The item never reaches the answer or the receipt, because the
final full check refuses the answer, and the desktop removes what it showed.
This widens ADR-0038's model-only exposure to the person's own screen. The
founder accepted it with the design.

**Transport.**

- The route is `POST /v5/person/ask` with the request header
  `x-echo-ask-progress: 1`. Any other value, or no header, gets today's JSON
  response.
- The Authority starts the stream only after the request is authenticated
  and validated. Failures before that remain ordinary JSON errors.
- The streamed response is `200` with `content-type: text/event-stream;
  charset=utf-8`, `cache-control: no-store`, and the route header
  `x-echo-person-ask-route: 5`. An error inside the stream therefore never
  triggers the `/v4` fallback.
- Each event is exactly one `data: <JSON>` line followed by a blank line.
  There are no `event`, `id` or `retry` fields.
- A `: keep-alive` comment is sent after about 10 s without an event.
- The one terminal event, `answer` or `error`, comes last, and nothing
  follows it. An error after the stream has started carries the status and
  body the JSON response would have had.
- A disconnect still aborts the request's signal and so cancels the Ask, and
  nothing more is written. The 90-second research deadline is unchanged.

The person client prints progress only for `person ask --live --progress`.
Each step event becomes its own `{ok: true, progress}` line, and the final
line keeps today's `{ok: true, result}` with `receipt` added when the
Authority streamed. Without the flag, output is unchanged.

Caddy 2.10.2 (`deploy/organization-authority/Caddyfile.clean-v1.ec2`)
flushes a `text/event-stream` response immediately, whatever its
`flush_interval`, so no setting is added. Setting `flush_interval -1` would
be harmful: in that mode Caddy no longer cancels the backend request when
the client disconnects. Whether the Cloudflare tunnel buffers the stream is
unverified. An operator checks this on staging after merge. If buffering
cannot be avoided, the fallback is start-then-read (B) behind the same
screen.

**Compatibility.**

- **Old clients** never send the header and get exactly today's responses.
- **A new client on an older Authority** gets JSON. It shows no progress, and
  its CLI prints today's final line without a receipt.
- **An Authority without `/v5`** answers 404 without the route header. The
  client then falls back to `/v4` without progress.
- **The V6 answer and its validators are unchanged.** The receipt travels
  only in the answer event and in the `--progress` final line.
- **Ship order.** Either order works; the design deploys the Authority first.
- **New kinds.** Adding a kind of item or source, such as follow-ups as an Ask
  source, is a new header value with its own validators, and a v1 client
  keeps receiving v1 events.

This record delivers the progress streaming that RFC-0002 deferred. It
updates ADR-0038's statement of who an already-checked item is exposed to,
and it is the release path
[INV-PERMISSIONS-015](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md)
now names. Nothing else in those records changes.

## Migration, rollback, and evidence

There is no schema change and no data migration. The audit body gains an
optional field in the existing immutable table, and existing rows are
unchanged. Rollback is a code revert. Rows written meanwhile stay readable,
and clients fall back to JSON because the Authority no longer streams.

The shared validators and stream framing are tested in
`packages/organization-api/test/person-ask-progress-v1.test.ts`. The tests
cover exact keys, the closed stage, source and status sets, the bounds, the
receipt's merge and coverage rules, chunked decoding, and the fail-closed
cases. The negative disclosure tests are:

- **A revoked item is never named after a check has seen the revocation:**
  `packages/organization-authority-kernel/test/answer-composition/agentic-ask-progress-v1.test.ts`.
- **No count includes an item the person cannot see:** the same kernel test,
  and `tests/architecture/ask-progress-roundtrip.test.ts`. In the round trip,
  a private document, a hidden meeting and an unapproved one all match the
  search, and the count is exactly the items named.
- **No note, need, plan, model-written query, provider query or body is ever
  sent:** the kernel test,
  `services/organization-authority/test/person-ask-progress-http.test.ts`,
  and the round trip, which checks every line the Person client prints.
- **A cancelled or timed-out run sends nothing further, and its audit lists
  what was named:** the kernel test (cancel and deadline), the HTTP test (a
  client disconnect), and the round trip (Cancel on the desktop page,
  through the client to the Authority's audit record).
- **A refused answer sends no receipt:** the kernel test, and the HTTP test
  (an in-stream error event, with no request audit record).
- **A client drops progress from an earlier Ask or another account:**
  `product/echo-desktop/test/unit/ask-progress.test.ts` for the page.
  `tests/person-client/person-ask-progress.test.ts` covers the Person client,
  which stops on an account switch and withholds a step while no session can
  be read. The desktop pins its streamed Ask to the account the page shows
  (`--expected-membership-id`, `--expected-authority`), so a client signed in
  as another by the time it starts asks nothing and prints no step; the
  page's own account check then compares what the client already checked
  (`product/echo-desktop/test/unit/ask-host.test.ts` and the Person client
  test).

The round trip runs the real Authority runtime, the real Person client with
`--progress`, the desktop host's own command builder, line reader and views,
and the desktop's store in one process. Step lines reach the page while the
Authority is still inside the writer's model call. The receipt names exactly
what was named. The audit lists the same citation commitments in the same
order. A named decision opens its meeting with that item lit, and a named
document opens its cited passage. The desktop's own end-to-end proof, against
its fixture Authority, is `product/echo-desktop/test/e2e/ask.spec.ts`.

Staging delivery through Cloudflare and Caddy is a manual operator check
after merge. Live qualification is separate.
