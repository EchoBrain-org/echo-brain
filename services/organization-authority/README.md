# Organization Authority V1 runbook

`organization-authority` is the Organization Authority service. It owns state
initialization, Person OIDC sessions, initial-owner Slack identity linking,
admitted meeting processing, approval finalization, immutable V4 records, and
permission-aware Person reads and answer composition. It also owns durable
Person document and upload custody, projects with their association and
audience, audited read/search, and optional search enrichment. Uploads do not
require Slack approval. The current artifact is Authority V10, with project
settings and project-scoped meeting approvals. Runtime opening never migrates
state. This release requires fresh databases; existing disposable rehearsal
state uses the [authorized reset](../../deploy/organization-authority/README.md#replace-unreleased-rehearsal-state).

For any deployed staging initial-owner setup, do not run the lower-level setup
commands in this service reference. Start with the
[deployment README](../../deploy/organization-authority/README.md) and its
`onboard-clean-v1.sh doctor`, `prepare`, then `resume` flow. The
[organization onboarding and employee rollout](../../docs/product/2026-08-22-organization-onboarding-and-employee-rollout-v1.md)
defines the supported operator and employee flow.

## Runtime component map

- `organization-authority-composition-root.ts` selects deployable providers.
- `organization-authority-runtime.ts` composes the provider-neutral runtime.
- `organization-authority-service-lifecycle.ts` owns worker and API lifecycle.
- `organization-authority-api-runtime.ts` owns request-serving resources.
- `organization-authority-http-server.ts` owns HTTP mechanics and dispatch.
- `organization-authority-setup-cli.ts` coordinates organization setup.
- `organization-authority-state-bootstrap.ts` bootstraps a new absent-state lineage.
- `meeting-source-bundle-v1.ts`, `decision-processor-bundle-v1.ts`, and
  `approval-workflow-bundle-v1.ts` in `packages/organization-processing/src/ports/`
  define provider-neutral composition seams.
- `providers/granola/src/granola-meeting-source-bundle-v1.ts`,
  `providers/openrouter/src/openrouter-decision-processor-bundle-v1.ts`, and
  `providers/slack/server/src/private-approval/private-slack-approval-workflow-bundle-v1.ts`
  own the selected providers. Slack Person identity composition is under
  `providers/slack/server/src/person-identity/`; the Slack private-DM staging
  canary is under `providers/slack/server/src/composition/staging/slack-private-approval/`.
- Private Slack interactions are separated into protocol, handler, HTTP adapter,
  and presentation-port components.
- Identity and approval callbacks share the application-owned
  `provider-http-application-v1.ts` contract in
  `packages/organization-authority-kernel/src/application/ports/`. The host mounts
  exact routes, preserves raw request bytes, permits queries only by opt-in,
  and owns response headers and limits: 64 KiB request/response bodies, 8 KiB
  query strings, and 16 KiB fixed HTML pages. Providers select JSON, bounded
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

The older `echo-organization-authority-init-clean-state`, `-clean-founder`,
`-clean-person`, `-clean-live`, `-synthetic-quality`, and
`-admit-clean-granola-source` alias binaries were retired on 2026-09-06. The
checked-in deploy scripts, container entrypoint, and harnesses already call the
names above; automation outside this repository must use them too. The
standalone `echo-organization-authority-person-admin` and
`echo-organization-authority-admit-granola-meeting-source` developer binaries
were retired later: `echo-organization-authority-setup` runs Person credential
setup, the initial-owner invitation and Granola source admission in-process.

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

## Disposable local connector preparation

Use the [operator router](../../docs/operations/PB-OPERATIONS-001-authority-operator-lane.md)
for actor and secret-handling rules. The local connector preparation command
creates a new private rehearsal directory with a nonsecret configuration
template, isolated Person directory, private input directory and receipts
directory. It reserves an absent Authority state path for later bootstrap.
It never reads installed Person sessions or copies staging inputs.

```sh
npm run authority:connector-rehearsal -- prepare --directory /absolute/new-rehearsal
npm run authority:connector-rehearsal -- preflight --directory /absolute/new-rehearsal
```

Fill the generated configuration with the rehearsal Authority's public HTTPS
origin, test owner, OIDC configuration path, Nango integration keys, and Jira
site/project. Private provider input paths are separate from their values.
Preflight checks configuration shape and private-file ownership/modes; it
prints missing field names, never credential contents. A configuration-ready
result does not prove provider credentials or permissions work.

The public HTTPS origin is this test Authority's URL. A local tunnel or proxy
must forward it to the Authority's loopback listener. Register its
`/v2/session/oidc/callback` in the test OIDC application. Slack's generated app
also points identity and interactive-card callbacks at this origin. The
existing staging Authority URL reaches staging, not the isolated local state.

Preparation and preflight are the only pre-bootstrap actions. They do not
create a tunnel, bootstrap state, start a listener, connect a provider, or
qualify anything. `preflight` is an overall profile check: its
`configuration_ready` result means every later private input is present, not
that bootstrap must wait for every provider input. Bootstrap needs the public
origin, organization/owner and OIDC configuration. Use this disposable local
sequence once those bootstrap inputs are ready:

```sh
npm run build
npm run authority:connector-rehearsal -- bootstrap --directory /absolute/new-rehearsal

# Terminal 1: loopback-only service. It reports 127.0.0.1:39489 when ready.
npm run authority:connector-rehearsal -- serve --directory /absolute/new-rehearsal

# Terminal 2: only the rehearsal's isolated Person home is used.
npm run authority:connector-rehearsal -- person --directory /absolute/new-rehearsal -- \
  login --invitation /absolute/new-rehearsal/state/onboarding/founder-person-invitation.json
npm run authority:connector-rehearsal -- person --directory /absolute/new-rehearsal -- tools setup --tool slack
npm run authority:connector-rehearsal -- person --directory /absolute/new-rehearsal -- tools connect --tool slack
npm run authority:connector-rehearsal -- person --directory /absolute/new-rehearsal -- tools connect --tool jira
```

The human completes OIDC and provider browser consent. The authority URL still
needs a dedicated public HTTPS test origin and matching test-OIDC callback even
though the local service listener is loopback-only. Do not use the installed
Person home, staging origin, or production credentials.

The first `serve` additionally needs the Nango secret and Jira cloud
configuration. Jira can connect and make a request-only capture before Granola
credential installation/finalization; the configured Jira project is required
when the capture runs. Granola and OpenRouter files become necessary for the
stopped `credentials-install` and `finalize` phase below. Run `preflight` again
when all of those later inputs are in place to verify the complete profile.

Stop `serve` before installing credentials and finalizing, then start it again:

```sh
npm run authority:connector-rehearsal -- credentials-install --directory /absolute/new-rehearsal
npm run authority:connector-rehearsal -- finalize --directory /absolute/new-rehearsal
npm run authority:connector-rehearsal -- serve --directory /absolute/new-rehearsal

# In another terminal, as the authenticated initial owner:
npm run authority:connector-rehearsal -- capture --directory /absolute/new-rehearsal --tool granola --limit 1
npm run authority:connector-rehearsal -- capture --directory /absolute/new-rehearsal --tool jira --limit 1
npm run authority:connector-rehearsal -- cycle-once --directory /absolute/new-rehearsal
```

`capture` and `cycle-once` obtain the access token from the isolated Person
session and send it only over the runner's private `control.sock` Unix socket;
it is never printed or placed in command arguments. Granola capture is an
owner-scoped, retained qualification observation under the shared context
foundation. It does not advance the meeting cursor. `cycle-once` is the
separate legacy meeting-and-approval processor and remains its cursor owner.
Jira capture is request-only and disappears after its receipt. No command
creates an automatic convergence loop or qualifies a provider. Jira remains
disabled in the normal service CLI. See the
[integration scope](../../docs/product/2026-10-01-connector-context-integration-v1.md).

Manual scheduling means source polling occurs only through the explicit capture
or `cycle-once` commands. It does not suppress existing derived approval,
presentation, or search-reconciliation wakes after a manual cycle.

## Staging connector rehearsal

This opt-in profile reuses the staging Authority's HTTPS endpoint and Google
sign-in. First deploy the matching server, host tooling and Person client through
the [operator playbook](../../docs/operations/PB-OPERATIONS-001-authority-operator-lane.md).
The [host guide](../../deploy/organization-authority/README.md) owns preparing
the nonsecret `staging_connector_rehearsal` onboarding field and its private
profile file. A checkout build alone does not enable a running Authority.

Save an exact copy of that profile object as a local nonsecret JSON file. Use
the release-matched Person client to sign in and run the ordinary shared
connection commands: `person tools setup --tool slack`,
`person tools connect --tool slack`, and `person tools connect --tool jira`.
The staging profile admits Jira connection commands only for its initial owner.
Granola continues to use the host's direct organization credential.

After `npm run build`, the owner Mac can run:

```sh
npm run authority:staging-connector-rehearsal -- status \
  --release-id clean-v1-your-release --profile /absolute/staging-connector-profile.json
npm run authority:staging-connector-rehearsal -- capture \
  --release-id clean-v1-your-release --profile /absolute/staging-connector-profile.json \
  --tool granola --limit 1
npm run authority:staging-connector-rehearsal -- capture \
  --release-id clean-v1-your-release --profile /absolute/staging-connector-profile.json \
  --tool jira --limit 1
```

The runner uses the installed Person session in the current user's home. That
session must name the staging Authority and an active initial owner. The
release ID and profile digest must match the running server. No token is accepted on the
command line or printed. A failed capture is not retried automatically: a lost
response may follow an already-committed observation.

Receipts contain hashes and counts, never source contents, cursors, provider
account IDs or credentials. A zero-item receipt is not a successful content
capture. Granola observations are retained under the separate owner policy;
Jira observations in V1 are request-only. Ordinary Granola polling owns the cursor
and continues running. Slack approval tests use the existing synthetic release
canary and human approval, with separate evidence. No Slack-message capture or
Jira Ask is enabled by this profile. See the
[scope and custody rules](../../docs/product/2026-10-01-connector-context-integration-v1.md#staging-connector-rehearsal-v1).

The separately selected [V2 profile](../../docs/product/2026-10-01-connector-context-integration-v1.md#staging-connector-rehearsal-v2)
retains Jira pointers and pointers from one public Slack channel. Follow the
host guide's reviewed `configure-connector-rehearsal` transition after deploying
an image that supports it. Keep the original V1 profile and connected Jira
sidecar; V2 must prove their predecessor binding. Save the exact V2 object as
the runner's local profile. The runner selects request and receipt version from
that object, using the same endpoint and staging session.

With V2 selected, run `person tools setup --tool slack` and complete human
consent to add public-channel read permissions to the existing app. Existing
approval cards and person links keep their connection state. Then the owner
can capture using the commands above with the V2 profile, plus:

```sh
npm run authority:staging-connector-rehearsal -- capture \
  --release-id clean-v1-your-release --profile /absolute/staging-connector-profile-v2.json \
  --tool slack --limit 1
```

V2 receipts report retained admission or duplicate for all three sources. Slack
and Jira retain pointers and selected metadata only; Slack message snapshots
remain a separate follow-up. No downstream retrieval or Ask behavior is enabled.

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
3. Stop the Organization Authority service, install the three provider credentials, then finalize.
4. Restart the Organization Authority service and complete the post-admission canary.

The OIDC JSON must be readable JSON with exactly `issuer`, `client_id`,
`redirect_uri`, `tenant`, `id_token_algorithms`, and `client_authentication`.
Its redirect URI must equal
`https://<authority-host>/v2/session/oidc/callback`. The owner email must be
canonical lowercase.

### 1. Bootstrap while stopped

Bootstrap takes no Slack input. Slack is connected afterward, in the app
(see [Slack setup, in the app](#slack-setup-in-the-app) below).

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

### Slack setup, in the app

Slack setup has no host-side steps left. An owner creates and installs the
organization's Slack connection with the Person CLI's tools verbs (the ECHO
desktop app's Connected tools page shows status only for now), through Nango
([ADR-0025](../../docs/decisions/ADR-0025-nango-holds-slack-connection-credentials.md)):
there is no Slack app scope to grant by hand, no separate signing-secret file,
and no Interactivity Request URL to save — the app recipe sets all of that,
including the four required bot scopes (`chat:write`, `im:history`,
`im:write`, `users:read`) and the `openid` and `profile` user scopes that
only the person's browser sign-in requests. The `im:*` scopes are required for
the meeting-owner DM lane.

Re-onboarding a staging lineage uses the same in-app setup and connect as a
first connection; it does not reuse a Slack app's scopes or token by hand. Use
a wholly fresh Authority V10 staging lineage with the
[current storage baselines](#state-and-baselines); use the supported
rehearsal reset before preparing state from an earlier release.

### 2. Start Person service, sign in, set up and connect Slack

Before finalization, the compatibility-named `clean-live` command exposes the Person surface with an inert
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
session at a local loopback handoff; do not paste callback data. `person
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

### 3. Install credentials and finalize while stopped

Stop the Organization Authority service. Each source file must contain exactly its value, without
trailing whitespace. The Granola owner-email file must contain the same
canonical lowercase email given to bootstrap and proved by OIDC.
This installs the single organization-owned Granola export/admission bridge;
it does not create a Person Granola connection or accept a per-person key.

```sh
echo-organization-authority-setup credentials-install \
  --state-dir /absolute/clean-state \
  --granola-credential-file /absolute/private/granola-organization-key \
  --granola-owner-email-file /absolute/private/granola-owner-email \
  --llm-credential-file /absolute/private/llm-provider-credential

echo-organization-authority-setup finalize \
  --state-dir /absolute/clean-state
```

Credential installation validates all three inputs before replacing any fixed
destination. Finalization requires the clean genesis, an exact active Slack
connection, the initial owner's active OIDC binding and Slack identity link, and
valid provider credentials. It creates no shared-channel/reaction approval
binding; it admits only Granola notes created after a fresh cutoff. Existing
notes are not imported.

### 4. Restart the Authority service and run the canary

Restart the same `clean-live serve` compatibility command. Optional
`--worker-interval-ms <positive-integer>` changes the worker interval. At
startup, the runtime reconciles the search index once, then each cycle recovers pending
V4 appends, polls the admitted meeting source, finalizes approvals, appends
approved records, and reconciles the search index again.

The deployment wrapper's `resume` output is the single source for staging's
actor-scoped host, Slack, and release-matched Person-client actions. A staging
terminal result accepts only the durable synthetic candidate tied to the
running release; every other origin still requires newly admitted live-source
progress. Both paths require an approved record, an exact-head search
generation, and positive owner list and search reads after that head and
generation. Status emits only boolean or enum evidence, never record, reader,
query, or timestamp data.

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
query never triggers a build. If the head advances or a generation build fails,
the existing pointer is not used for the new head. The Person client reports
that search is catching up; wait for the next worker cycle and retry.

The private owner-approval card chooses approved-content visibility. It defaults
to **Only me** (`restricted-reviewer-person-v2`), which allows only the exact
approving owner and that owner's current membership tenure to read the record.
Before approving, the owner may select **Team**
(`organization-member-readable-person-v2`), which allows every current active
owner or employee in the organization to read it, or, when the owner has an
active project, **Projects** (`project-members-readable-person-v1`) with one to
twenty of the owner's projects. Projects lets current members of any selected
project read the record and associates it with those projects for project Ask;
Only me and Team records carry no project association. The selected policy and
project IDs freeze with the approved record; project readers are resolved at
read time.

The separate **Share transcript with the selected audience** checkbox defaults
off. When checked, the same approval releases the exact retained transcript
revision to the record's audience through `echo-brain person transcript`
(`POST /v1/person/meeting-transcripts/read`). Ask does not search transcripts.

A later source-folder move does not reinterpret a posted card or approved
record.
Revoking a membership denies both list and search for that tenure. A newly
invited employee gets a new membership tenure and may read only content allowed
to that membership. The owner sees the current roster with
`echo-brain person employee list`; invite, list, reissue, and revoke commands
are documented in the [product onboarding flow](../../docs/product/2026-08-22-organization-onboarding-and-employee-rollout-v1.md#employee-rehearsal-commands).

## State and baselines

Clean V1 is a new lineage, not an upgrade mechanism. Reset creates the state
directory atomically and records a lineage root plus role-specific manifests.
Startup verifies the root and every persisted database identity, schema
version, and baseline digest before opening the Authority runtime.

Current state uses Authority V10, control-plane V3, record-log V4, retrieval
facts V3, and retrieval lexical/content V2. The V2 root binds exactly these six
roles. Per-database manifests remain V1; schema versions and digests identify
each role's current baseline. Each baseline applies only to a completely empty
database. Old roots, retired databases, and mismatched schemas refuse before
writable opening.

The immutable approval-delivery quarantine fences unrepresentable approval
packages before any provider post and retains them for audit. A temporarily
missing reviewer identity leaves its durable outbox queued for reconciliation.

The checkout carries only the current V10 baseline. Earlier Authority
baselines and their offline converters remain in Git history.

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
