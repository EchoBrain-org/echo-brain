# Organization Authority V1 runbook

`organization-authority` is the Organization Authority service. It owns state
initialization, Person OIDC sessions, initial-owner Slack identity linking,
admitted meeting processing, approval finalization, immutable V4 records, and
permission-aware Person reads and answer composition. It also owns durable
Person document and upload custody, projects with their association and
audience, audited read/search, and optional search enrichment. Uploads need
no approval. Meetings go through one approval core (one proposal per meeting,
multi-project audiences, confirmed owners). Runtime opening never migrates
state; it requires the [current baselines](#state-and-baselines), and existing
disposable rehearsal state uses the
[authorized reset](../../deploy/organization-authority/README.md#replace-unreleased-rehearsal-state).

For any deployed staging initial-owner setup, do not run the lower-level setup
commands in this service reference. Start with the
[operator playbook](../../docs/operations/PB-OPERATIONS-001-authority-operator-lane.md)
and the [deployment README](../../deploy/organization-authority/README.md)'s
`onboard-clean-v1.sh doctor`, `prepare`, then `resume` flow.

## Runtime component map

The [composition README](src/composition/README.md) maps the runtime
components, provider bundles and Person services. Two host rules sit here:

- Private Slack interactions are separated into protocol, handler, HTTP adapter,
  and presentation-port components.
- Identity and approval callbacks share the application-owned
  `provider-http-application-v1.ts` contract in
  `packages/organization-authority-kernel/src/application/ports/`. The host mounts
  exact routes, preserves raw request bytes, permits queries only by opt-in,
  and owns response headers and limits: 64 KiB request bodies and raw response
  bytes, 128 KiB JSON responses, 8 KiB query strings, and 16 KiB fixed HTML
  pages. Providers select JSON, bounded
  response bytes, or an empty acknowledgment and retain verification and
  durable acceptance. HTML pages never reflect request fields; query-token
  reflection is not a supported callback mode.

Existing `clean-*` entrypoint filenames and `clean-founder` wire values are
versioned compatibility names. They are not component boundaries and do not
limit the service to a particular initial owner.

## Build and commands

Build the workspace before using the local `dist/` entrypoints:

```sh
npm run build --workspace @echo-brain/organization-authority
```

Use these responsibility-named commands for new automation:

- `echo-organization-authority-state-bootstrap`
- `echo-organization-authority-setup`
- `echo-organization-authority-serve`

The older `clean-*` alias binaries are retired; automation outside this
repository must use the names above. `echo-organization-authority-setup` runs
Person credential setup and the initial-owner invitation.

Use absolute canonical paths. Private credential and invitation directories
must be current-user `0700`; private input and invitation files must be
current-user `0600` regular files. Never place token or credential bytes on a
command line.

## Fresh Authority state

The standalone initializer command creates a new lineage from an absent state
directory. It applies the frozen baselines, creates the Authority descriptor
and owner, and prints only its JSON result.

```sh
echo-organization-authority-state-bootstrap \
  --state-dir /absolute/clean-state \
  --organization-name 'Example Organization' \
  --owner-display-name 'Initial Owner' \
  --created-at '2026-08-23T00:00:00.000Z' \
  --artifact-revision clean-v1
```

Normally use the initial-owner setup below instead: it creates this same clean
state with a durable setup plan, generated internal IDs, Person credentials,
and initial-owner invitation; Slack is connected afterward, in the app. Do not
run reset into a directory that already contains state.

## Staging connector rehearsal

This opt-in profile reuses the staging Authority's HTTPS endpoint and Google
sign-in. First deploy the matching server, host tooling and Person client through
the [operator playbook](../../docs/operations/PB-OPERATIONS-001-authority-operator-lane.md).
The [host guide](../../deploy/organization-authority/README.md#optional-staging-connector-rehearsal)
owns preparing the nonsecret `staging_connector_rehearsal` onboarding field and
its private profile file. A checkout build alone does not enable a running
Authority.

Save an exact copy of that profile object as a local nonsecret JSON file. Use
the release-matched Person client to sign in. The runner reads only Jira: run
`person tools connect --tool jira` when the owner's Jira connection is absent.
Organization Slack setup belongs to onboarding, not to this runner. If the
organization Slack connection is absent after a staging reset, follow the host
`resume --existing-slack-app <app-id>` handoff and the
[existing-app procedure](../../deploy/organization-authority/README.md#use-an-existing-slack-app-before-the-first-connection):
`person tools setup --tool slack --existing-app <app-id>`, or `--reconnect`
when that app's credentials are already saved (never both). Then run
`person tools connect --tool slack`.
Slack setup asks only for the bot's four delivery scopes; human Slack consent is still required. Without live Jira Ask enabled, the diagnostic profile admits Jira connection commands only for its initial owner. Enabling live Jira Ask lets each Person connect their own account. Organization Granola capture is retired.

After `npm run build`, the owner Mac can run:

```sh
npm run authority:staging-connector-rehearsal -- status \
  --release-id clean-v1-your-release --profile /absolute/staging-connector-profile.json
npm run authority:staging-connector-rehearsal -- verify-read \
  --release-id clean-v1-your-release --profile /absolute/staging-connector-profile.json \
  --tool jira
```

The runner uses the installed Person session in the current user's home. That
session must name the staging Authority and an active initial owner. The
release ID and profile digest must match the running server. No token is accepted on the
command line or printed. The diagnostic makes one bounded attempt and does not
retry provider work automatically.

`verify-read` is a separate, manually selected read proof: one inventory item,
one exact open, and final provider and local authorization checks within 15
seconds. It follows no cursor, retries nothing, calls no model, and retains no
body. Only Jira supports it: the Slack bot delivers approvals and reads no
channel. Jira reads
normalized issue text (key, summary and available description); it does not
claim a nonempty description. A verified receipt contains only source-coordinate
and text hashes plus a positive UTF-8 byte count, bounded to 3 KiB. Empty results
refuse. Refused receipts contain a finite phase/reason and the runner exits 1.
`connection_absent` means the local connection is absent; `unauthorized` or
`stale_access_state` does not mean reconnect is required. Inspect the refusal
before initiating a new consent flow, which can replace an existing connection.

Receipts contain hashes and counts, never source contents, cursors, provider
account IDs or credentials. The V3 protocol supports status and Jira
`verify-read` only. All capture requests are rejected before provider I/O, and no
tool pointers, metadata or bodies enter Layer 1. Organization Granola polling is
removed. Approval tests use the existing synthetic release canary and
human approval, with separate evidence. The diagnostic profile alone does not
enable Ask. See the
[scope and custody rules](../../docs/product/2026-10-01-connector-context-integration-v1.md#staging-connector-rehearsal).
Connection bindings remain stable across ordinary restarts with the same
profile.

The EC2 Compose overlay additionally selects `ECHO_STAGING_JIRA_ASK_V1=true`
when the fixed connector profile is present. The CLI validates that profile and
reuses the existing connection sidecar for each Person's own Jira grant. Global
Ask follows that person's Jira permissions across the connected site, without a
fixed-project or initial-owner restriction. The profile digest and sidecar remain
unchanged. Without that switch, the diagnostic-only behavior remains available.
Explicit Jira flags must match the selected profile's site and integration.
ECHO project Ask requires a lead-configured Jira mapping and the asker's own
connection. The mapping filters discovery before tickets are read and remains
checked on open and revalidation. The rehearsal's fixed project applies only to
its diagnostic reads. Mine and unmapped projects exclude Jira.

The same EC2 overlay selects `ECHO_STAGING_CONFLUENCE_ASK_V1=true` when the
fixed connector profile is present. Confluence uses only that profile's
Atlassian Cloud ID, with a separately configured Nango Cloud integration named
`confluence`. It uses each Person's own Confluence grant and no Jira project
restriction. Global Ask follows the person's Confluence access;
project Ask filters discovery through the project's Confluence space mapping.
Conflicting explicit Confluence flags refuse startup. Without the staging switch
or both explicit Confluence flags, the Confluence source remains unconfigured.
Configure the `confluence` integration and its documented OAuth scopes before
staging the release, then connect Confluence through Tools with browser consent.
No existing Jira connection or fixed profile needs to be rewritten.

## Initial-owner setup internals

For deployed staging, use the resumable wrapper in the
[deployment runbook](../../deploy/organization-authority/README.md). The
numbered commands below are lower-level composition reference for local
development and custom deployments; they are not the staging runbook.

Bootstrap and finalization are stopped-state operations. The path is:

1. Bootstrap the clean lineage, initialize Person credentials, and issue the
   initial-owner invitation. Bootstrap takes no Slack input.
2. Start the Organization Authority service, complete the initial owner's
   browser OIDC sign-in, set up the organization's Slack connection in the
   app, and connect the signed-in person's own Slack.
3. Stop the Organization Authority service, install the LLM credential, then finalize.
4. Restart the Organization Authority service and complete the staging canary.

The OIDC JSON must be readable JSON with exactly `issuer`, `client_id`,
`redirect_uri`, `tenant`, `id_token_algorithms`, and `client_authentication`.
Its redirect URI must equal
`https://<authority-host>/v2/session/oidc/callback`. The owner email must be
canonical lowercase.

### 1. Bootstrap while stopped

Bootstrap takes no Slack input. Slack is connected afterward, in the app
(see [Slack setup, in the app](../../deploy/organization-authority/README.md#slack-setup-in-the-app)).

```sh
echo-organization-authority-setup bootstrap \
  --state-dir /absolute/clean-state \
  --organization-name 'Example Organization' \
  --owner-display-name 'Initial Owner' \
  --owner-email owner@example.com \
  --authority-url https://authority.example.com \
  --oidc-config /absolute/private/oidc-config.json
```

`--artifact-revision <revision>` is optional and defaults to `clean-founder-v1`.
The private, non-secret setup plan is
`/absolute/clean-state/onboarding/clean-founder-v1.json`; do not edit or move
it. If the command stops or its response is lost, resume from that plan
without repeating the organization, owner, OIDC, origin, or revision inputs:

```sh
echo-organization-authority-setup resume \
  --state-dir /absolute/clean-state
```

`resume` reads no standard input. A manifest from before this change is
refused: "organization setup manifest predates in-app Slack setup; install
this release's host tooling, then run replace-rehearsal" (the
[deployment runbook](../../deploy/organization-authority/README.md#replace-unreleased-rehearsal-state)
gives the order). If the setup plan is missing, restore that exact plan or
start with a new clean state directory; do not try to recreate it around
existing state. Use this safe status view at any time:

```sh
echo-organization-authority-setup status \
  --state-dir /absolute/clean-state
```

It reports the next step and durable readiness facts, but not credentials,
grants, bearer values, generated internal IDs, or note content.

### 2. Start Person service, sign in, set up and connect Slack

Before finalization, the `echo-organization-authority-serve serve` command exposes the Person surface with an inert
processing worker. The manifest supplies the Authority URL and OIDC
configuration, so they are not repeated here.

```sh
echo-organization-authority-serve serve \
  --state-dir /absolute/clean-state \
  --host 127.0.0.1 \
  --port 39479 \
  --nango-secret-key-file /absolute/private/nango-secret-key \
  --nango-integration slack
```

For `client_secret_basic` or `client_secret_post`, append
`--client-secret-file /absolute/private/oidc-client-secret`. The listener only
accepts `127.0.0.1` or `::1`; put the configured HTTPS Authority origin behind
the deployment proxy or tunnel.

On the initial owner's current-user machine, use the private invitation produced by
bootstrap:

```sh
echo-brain person login \
  --invitation /absolute/clean-state/onboarding/founder-person-invitation.json
pbpaste | echo-brain person tools setup --tool slack
echo-brain person tools connect --tool slack
```

`person login` opens the OIDC authorization URL and receives the one-use
session at a local loopback handoff; do not paste callback data. Only the
Person CLI sets up the organization's Slack app; the desktop Tools page
connects each person's own tools. `person
tools setup --tool slack` reads a Slack app configuration token from standard
input — piped in, as above, or pasted at its hidden prompt — creates and
installs the organization's private Slack app through Nango, and waits for
the owner to finish in the browser. Add `--reconnect` to resume an unfinished
install, or reconnect after Slack was uninstalled, after Nango lost the connection, or
after an install landed in another workspace, without a new setup token. `person
tools connect --tool slack` then opens the
owner's own Slack sign-in and waits the same way; on a machine without a
browser, use `person tools connect --tool slack --method dm-code --slack-user U…`,
which prints a challenge code to reply with in its Slack thread, then waits
for an empty Enter acknowledgement. Both the organization's Slack connection
and the owner's own link are required for the initial owner to finalize;
neither is required for a read-only employee.

The Person session surface also supports refresh and logout. The packaged
client owns those details:

```sh
echo-brain person status
echo-brain person session-refresh
echo-brain person logout
```

### 3. Install the LLM credential and finalize while stopped

Stop the Organization Authority service. The source file must contain exactly its value without trailing whitespace.

```sh
echo-organization-authority-setup credentials-install \
  --state-dir /absolute/clean-state \
  --llm-credential-file /absolute/private/llm-provider-credential

echo-organization-authority-setup finalize --state-dir /absolute/clean-state
```

Finalization requires clean genesis, the organization Slack connection, the
initial owner's OIDC binding and Slack identity link, and the LLM credential.
Ordinary deployments admit no meeting source and start with intake idle;
meetings enter only through a person's own sources. On the exact staging origin,
finalization ensures the owner's synthetic personal source with no fixture
notes; only an explicit release-bound canary request supplies content. The
existing four-meeting fixture selector instead queues its fixed synthetic corpus
into that source. Neither staging mode needs a Granola account or credential.

### 4. Restart the Authority service and run the canary

Restart the same `echo-organization-authority-serve serve` command. Optional
`--worker-interval-ms <positive-integer>` changes the worker interval. At
startup, the runtime reconciles the search index once, then each cycle recovers
decided approvals whose record was not appended, polls the personal meeting
sources and freezes one proposal per meeting, publishes the decisions made since
(one V4 record per approval, then the after-record hooks), and reconciles the
search index again. Only recovery, approval publication and bounded operator
mutations hold the writer gate. Up to three personal sources run their meeting
pass at once, in lanes that outlive the cycle; a meeting whose extraction fails
is parked and its source moves on, except for one free retry after an unbilled
429 or 5xx (see the [meeting processing architecture](../../docs/architecture/meeting-processing-core-and-adapters.md#held-meetings-lanes-and-the-writer-gate)).

The deployment wrapper's `resume` output is the single source for staging's
actor-scoped host, Slack, and release-matched Person-client actions. A staging
terminal result accepts only the durable synthetic candidate tied to the
running release. Staging still requires an approved record, a search generation
at the current record head, and positive owner list and search reads after that
head and generation. A source-free ordinary deployment completes setup without
meeting qualification; its status reports `not_required` and keeps absent
canary evidence false. Status emits only boolean or enum evidence, never record,
reader, query, or timestamp data.

Setup manifests use V3 and setup status uses V2. Earlier manifests require
fresh setup; pinned Authority baseline SQL remains unchanged. The host release
health reader accepts matched V1 or V2 status envelopes so rollback to an older
accepted image can still be checked; this does not select a legacy connector.

## Person reads and permissions

Both paths require a current bearer-backed Person session. Caller identity is
never accepted from a request body, and the Authority proves the same session,
identity binding, membership tenure, and person state again immediately before
releasing results.

| Path | Client command | Behavior |
| --- | --- | --- |
| Record list | `echo-brain person records --limit 20` | Returns released immutable V4 record envelopes. It remains available while the search index catches up. |
| Indexed search | `echo-brain person records --query 'text'` | Searches the current immutable generation and returns its generation/head metadata plus per-item atom, record, and policy identity. It is unavailable until the active generation matches the exact record head. |

The search index is rebuilt at startup and after a coalesced approved-record append; a
query never triggers a build. A wake whose active generation is unchanged and
already validated in this process skips re-reading its files; startup always
validates. If the head advances or a generation build fails,
the existing pointer is not used for the new head. The Person client reports
that search is catching up; wait for the next worker cycle and retry.

The meeting card chooses approved-content visibility. It is the same on the
desktop and in the Slack DM copy that a reviewer who linked Slack also gets, and
the first decision wins. **Who can read it** defaults to **Only me**
(`restricted-reviewer-person-v2`), which allows only the exact approving person
and that person's current membership tenure to read the record. Instead, the
reviewer may pick **Projects** (`project-members-readable-person-v1`): one to
twenty of their own active projects, with the projects chosen at import or watch
already ticked. Current members of any selected project can read the record, and
it is associated with those projects for project Ask. Only me records carry no
project association. There is no organization-wide (Team) choice. Each action
with an owner proposed by extraction shows an owner field, pre-filled; only the
owners the approver confirms are recorded. The selected policy and project IDs
freeze with the approved record; project readers are resolved at read time.

The separate **Share transcript with the selected audience** checkbox defaults
off. When checked, the same approval releases the exact retained transcript
revision to the record's audience through `echo-brain person transcript`
(`POST /v1/person/meeting-transcripts/read`). Ask does not search transcripts.

Each approved record also enqueues one impact check (`authority_trigger_runs_v1`),
written in the same transaction as the approval's receipt. The check runs as
the approver. A stored run keeps pointers and ECHO's own judgments only, and
every view re-releases the items through a fresh desk
([ADR-0032](../../docs/decisions/ADR-0032-stored-trigger-runs.md)). A
finished check writes, in the same transaction, one shared open item per
affected item a model found `conflicts` or `needs_updating` (a `confirms` row
and every row of the fallback card no model assessed make none, and the
meeting's own record or the transcript its approver shared is never one) and
one per action the approved
meeting decided (kind `action`, at most 20, the first in the brief that have
text; its line is the action's text and its owner the one the approver
confirmed, matched to the one active member with the same display name,
ignoring case and spacing, else the approver). A meeting action is ECHO's own
data: it is never read live or swept, and is closed by hand. A failed or
timed-out check writes none of these until Try again succeeds. One access
policy answers every see and act question about open items, and each item's
outside words are read live as the viewer
([ADR-0033](../../docs/decisions/ADR-0033-shared-open-items.md)).

`POST /v1/person/runs` (`echo-brain person runs --request <json>`) serves these
operations:

| Operation | What it does |
| --- | --- |
| `list` | The caller's own runs, newest first, at most 100: up to the 20 newest sweeps, and impact runs for the rest. A running run whose lease has lapsed is listed as pending. |
| `start` | Claims a pending run (or one whose lease expired) and runs it as its actor. While the search index has not caught up with the record log (an impact run's decision is not yet searchable, or a sweep would read ECHO records through it), a pending run is held instead: `start` answers `pending` with no claim, attempt or trace, and the desktop starts it again at its next look. A person has one live run, and a sweep waits while one of their impact runs is pending or running; a start that must wait answers `busy`, as does any start while four runs are already running in this Authority process. A run that hits `unauthorized` while its actor's membership is still active (for example, after a token rotation) goes back to pending without counting an attempt; once the membership is revoked it fails as `no_access`. |
| `retry` | Puts the caller's failed impact run back to pending. A failed sweep stays failed; the next sweep replaces it. |
| `view` | A finished impact run's card, for its approver and anyone who can read its decision, rebuilt with the viewer's access. A sweep has no card (`not_found`). |
| `home` | What waits on the caller: Send rows, the open items to update or check, the counts under Home, and `sweep_due`. With `read: "rows"`, the same answer with no live read (every item `not_read`) and `sweep_due` always false, without starting a sweep. Its items (at most 20) come newest first by handoff time (the latest of when it was sent, its owner set, or its state set by a reopen), with changed items breaking ties. Desktop notifications come from the change check (ADR-0036) and a rows-only read of `items` `involved`, independent of this limit. |
| `items` | The items the caller can see (unsent, open and closed) for `mine`, `involved` (`mine` plus the items the caller last handed on, `owner_set_by`), a run, a record or a project, oldest first, 50 a page (`mine` and `involved` read every row the caller is in, a page at a time, before the policy pass; a run, record or project at most 5000 rows), with a summary of the whole scope (counts by state; counts by last check among open items; and, for each decision the caller can read, up to 100 and most recent first, its unsent, open, landed and unreadable counts) and each decision's stage. A check whose lease has lapsed is a pending stage, as in `list`. `states` (a non-empty subset of `unsent`, `open`, `done` and `not_relevant`) pages over the items in those states only, its cursor included, while the summary and stages still cover the whole scope. `changed_since` (`mine` and `involved` only, never with `counts`) does the same for the items whose latest send, handoff or state change is at or after that time, so the desktop finds what was sent and closed between two checks without paging through every closed item (the Authority still reads the whole scope to count it). `read` says how much to read: `rows` answers the same page, cursor, summary and stages with no live read and no desk bound, every item `not_read`; `counts` (never beside a cursor or `states`) answers the summary and stages alone. The desktop reads a list's current work (`unsent`, `open`) before its closed items, so current work is never behind a More; it shows each page from a rows read at once and reads live only the rows it shows, and after a change to one item reads that item as rows and the counts again. |
| `item` | One open item, rebuilt for the caller; with `read: "rows"`, with no live read. |
| `send` | The approver sends any of a run's unsent items to their owners, once per command id: a ticked item opens for its owner, an unticked one is dismissed (not relevant), and an unsent item the request does not list stays unsent. A listed item that is no longer unsent makes the whole send a conflict, as does a command id already sent that now lists other items; a retry listing the same items answers what it did. |
| `set_state` | The approver or the owner sets a sent item to open, done or not relevant. |
| `assign` | Changes an item's owner to another active member, stored at once with who set it and when. Before Send only the approver may, while they can send it (`picked`); once sent, the approver, the owner or a lead of one of the decision's active projects (`reassigned`). Its current owner again writes nothing, except the approver taking on an item ECHO gave them for want of a match, which is stored as chosen. A pick at `send` does the same. |
| `sweep` | Queues a re-check of the open items the caller can see in `mine` (what they sent or own), a record or a project, or answers `nothing_to_check` when there is none a sweep covers. Asked again while that scope's sweep is pending or running, it answers the same run. |

`GET /v1/person/changes` (`echo-brain person changes`) is the change check
([ADR-0036](../../docs/decisions/ADR-0036-person-change-check.md)): one
fingerprint each for the caller's `projects`, `follow_ups` (what `items`
`involved` lists) and `reviews`, built under the same policy as those reads,
plus `check_again_after_seconds`. It reads in one Authority read transaction
with no live tool read and no audit row. Reviews that cannot be read just now
count as none, and the other areas still answer.

A sweep acts as the person who asked, with their access, and stores only
verdicts and which items it could not read. It covers items on a Jira ticket
or a page in a tool the caller has connected (a live source a desk binds is for
that tool and the caller's link to it is live, read locally, never from the
provider), or on an ECHO record or document. At start it takes
up to 20 of the items the caller still sees, never checked first, then the
oldest last check; an item one of their sweeps that finished in the last day
could not read goes after all the others. It names the decision to research
only when the caller can read the decision. It runs no planner: research
re-reads each finding's items in full and the sweep renderer's one judge call
decides the verdicts. Its run keeps the counts by verdict and the ECHO ids of
the items it could not read. Each item it judged keeps that verdict as its
shared last check, replaced only by a newer one, and only when the person still
sees the item as the sweep finishes. An `unreadable` verdict never replaces a
judged one (`landed`, `still_open` or `changed`) from anyone: it is recorded
only while the item has no judged check. A judged verdict replaces an
`unreadable` one whenever that was made; since a last check only moves
forward, one that replaces a later unreadable check is stamped 1 ms after it.
A sweep never changes an item's state.
`sweep_due` is true when the caller has an open item they sent or own, of a
kind a sweep covers, that was last checked over 24 hours ago or never and that
none of their sweeps that finished in the last day found unreadable; no sweep
of theirs is running; and they asked for no sweep in the last hour. A
sweep left pending for longer than that does not block it; asking again for
its scope returns that run. The hour limits only `sweep_due`; `sweep` itself,
as the desktop's Check now asks for it, is never limited.

A later source-folder move does not reinterpret a frozen proposal or an approved
record.
Revoking a membership denies both list and search for that tenure. A newly
invited employee gets a new membership tenure and may read only content allowed
to that membership. The owner sees the current roster with
`echo-brain person employee list`; invite, list, reissue, and revoke commands
are documented with the
[employee handoff](../../deploy/release/README.md#employee-machine-requirements-and-handoff).

## State and baselines

Clean V1 is a new lineage, not an upgrade mechanism. Reset creates the state
directory atomically and records a lineage root plus role-specific manifests.
Startup verifies the root and every persisted database identity, schema
version, and baseline digest before opening the Authority runtime.

Current state uses six byte-pinned baselines, one per role: Authority V14,
control-plane V4, record-log V4, retrieval facts V3, retrieval lexical V2 and
retrieval content V2. The V2 root binds exactly these six roles. Per-database manifests remain V1; schema versions and digests identify
each role's current baseline. Each baseline applies only to a completely empty
database. Old roots, retired databases, and mismatched schemas refuse before
writable opening.

A proposal is frozen once, when it is staged, and one row in
`authority_approval_decisions_v1` records the first decision. A card that cannot
fit Slack's limits is marked unrepresentable in
`authority_approval_presentations_v1` and not retried; the desktop still shows
the proposal. A temporarily missing reviewer identity leaves the proposal queued
for reconciliation.

The checkout carries only each role's current baseline. Earlier baselines and
their offline converters remain in Git history.

Routine releases use baseline-preserving image replacements through the
[release procedure](../../deploy/release/README.md); that updater refuses
schema changes and never migrates state.

## Verification

Run the focused Authority test suite after a code change:

```sh
npm run test:authority
```

Run the repository documentation check after editing this runbook:

```sh
npm run check:docs
```
