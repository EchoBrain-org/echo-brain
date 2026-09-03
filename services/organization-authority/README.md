# Organization Authority V1 runbook

`organization-authority` is the Organization Authority service. It owns state
initialization, Person OIDC sessions, initial-owner Slack identity linking,
admitted meeting processing, approval finalization, immutable V4 records, and
permission-aware Person reads and answer composition. It has no compatibility runtime for a prior
Authority state: start with a new state directory and do not reuse legacy
state, credentials, or volumes.

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
  `approval-workflow-bundle-v1.ts` define provider-neutral composition seams.
- `providers/granola/granola-meeting-source-bundle-v1.ts`,
  `providers/openrouter/openrouter-decision-processor-bundle-v1.ts`, and
  `providers/slack/private-approval/private-slack-approval-workflow-bundle-v1.ts`
  own the selected providers. Slack Person identity composition is under
  `providers/slack/person-identity/`; the Slack private-DM staging canary is
  under `staging/slack-private-approval/`.
- Private Slack interactions are separated into protocol, handler, HTTP adapter,
  and presentation-port components.

Existing `clean-*` binaries and `clean-founder` files and wire values are
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
- `echo-organization-authority-person-admin`
- `echo-organization-authority-serve`
- `echo-organization-authority-synthetic-meeting-quality`
- `echo-organization-authority-admit-granola-meeting-source`

The older `echo-organization-authority-init-clean-state`, `-clean-founder`,
`-clean-person`, `-clean-live`, `-synthetic-quality`, and
`-admit-clean-granola-source` binaries remain compatibility commands. Existing
automation may retain them; new docs and scripts should use the names above.

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
Slack connection, and initial-owner invitation. Do not run reset into a directory
that already contains state.

## Initial-owner setup internals

For deployed staging, use the resumable wrapper in the
[deployment runbook](../../deploy/organization-authority/README.md). The
numbered commands below are lower-level composition reference for local
development and custom deployments; they are not the staging runbook.

Bootstrap and finalization are stopped-state operations. The path is:

1. Bootstrap the clean lineage, initialize Person credentials, verify the Slack
   bot and temporary public initial-owner identity-link channel, and issue the
   initial-owner invitation. That channel never receives an approval card.
2. Start the Organization Authority service, complete the initial owner's browser OIDC sign-in, and link the
   signed-in person to Slack.
3. Stop the Organization Authority service, install the three provider credentials, then finalize.
4. Restart the Organization Authority service and complete the post-admission canary.

The OIDC JSON must be readable JSON with exactly `issuer`, `client_id`,
`redirect_uri`, `tenant`, `id_token_algorithms`, and `client_authentication`.
Its redirect URI must equal
`https://<authority-host>/v2/session/oidc/callback`. The owner email must be
canonical lowercase.

### 1. Bootstrap while stopped

Pass the Slack bot token through standard input. The token file contains the
token with at most one trailing newline; it is never recorded in the setup
manifest or command output. `--slack-approval-channel-id` is a transitional
legacy name: it supplies only the temporary public channel used to complete the
initial owner's Slack identity-link challenge. It is not an approval destination or
approval-readiness gate.

```sh
echo-organization-authority-setup bootstrap \
  --state-dir /absolute/clean-state \
  --organization-name 'Example Organization' \
  --owner-display-name 'Initial Owner' \
  --owner-email owner@example.com \
  --authority-url https://authority.example.com \
  --oidc-config /absolute/private/oidc-config.json \
  --slack-approval-channel-id C0123456789 \
  < /absolute/private/slack-bot-token
```

`--artifact-revision <revision>` is optional and defaults to `clean-founder-v1`.
The private, non-secret setup plan is
`/absolute/clean-state/onboarding/clean-founder-v1.json`; do not edit or move
it. If the command stops or its response is lost, resume from that plan without
repeating the organization, owner, OIDC, origin, channel, or revision inputs:

```sh
echo-organization-authority-setup resume \
  --state-dir /absolute/clean-state \
  < /absolute/private/slack-bot-token
```

When Slack is already connected, `resume` does not read standard input, so the
redirection may be omitted. If Slack was not yet connected, it still requires
the token on standard input and performs the same verification. If the setup
plan is missing, restore that exact plan or start with a new clean state
directory; do not try to recreate it around existing state. Use this safe
status view at any time:

```sh
echo-organization-authority-setup status \
  --state-dir /absolute/clean-state
```

It reports the next step and durable readiness facts, but not credentials,
grants, bearer values, generated internal IDs, or note content.

### Slack re-onboarding checklist for private approval V1

Use one Slack app for the connection token and interactive signing secret.
Before bootstrap, update that app's scopes, then reinstall it to the staging
workspace:

1. Grant the exact required bot scopes:
   `channels:history`, `channels:read`, `chat:write`, `im:history`,
   `im:write`, `reactions:read`, and `users:read`. The `im:*` scopes are
   required for the meeting-owner DM lane.
2. Reinstall the app after the scope change, then use the new bot token from
   that same installation.
3. Put the signing secret from that same Slack app in a separate current-user
   `0600` regular file containing one value with no trailing newline. Do not
   reuse a signing secret from another Slack app.
4. Use a wholly fresh provider-neutral V4 staging lineage. Do not upgrade or
   reuse an earlier V3 or shared-channel rehearsal database, state directory, or
   approval binding.

Complete bootstrap, the initial-owner identity link, credential installation, and
finalization first, then start the active runtime. Only after that runtime is
healthy, enable **Interactivity & Shortcuts** and save this Request URL before
running the release-bound synthetic staging canary:

```text
https://<staging-authority-host>/v2/integrations/slack/interactions
```

The callback deliberately returns `503` before finalization, so do not try to
validate or save that URL against a pre-finalize runtime. Event Subscriptions,
Socket Mode, and a Slack OAuth redirect are not required for this V1.

The temporary public identity-link channel is still required only until the
linking transport is moved to a private surface. It receives the initial owner's
challenge thread, never shared approval cards.

### 2. Start Person service, sign in, and link Slack

Before finalization, the compatibility-named `clean-live` command exposes the Person surface with an inert
processing worker. The manifest supplies the Authority URL, OIDC configuration,
PKCE key, and Slack channel, so they are not repeated here.

```sh
echo-organization-authority-serve serve \
  --state-dir /absolute/clean-state \
  --host 127.0.0.1 \
  --port 39479 \
  --slack-signing-secret-file /absolute/private/slack-signing-secret
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
echo-brain person slack-link
```

`person login` opens the OIDC authorization URL and receives the one-use
session at a local loopback handoff; do not paste callback data. `person
slack-link` prints a challenge code to reply with in its Slack thread, then
waits for an empty Enter acknowledgement. The Slack link is required for the
initial owner to finalize; it is not required for a read-only employee.

The Person session surface also supports refresh and logout. The packaged
client owns those details:

```sh
echo-brain person status
echo-brain person session-refresh
echo-brain person logout
```

### Person administration developer commands

`clean-live serve` is the legacy name of the normal runtime entrypoint. For focused local
development, the lower-level Person administration entrypoint has only these forms:

```sh
echo-organization-authority-person-admin credentials-init \
  --state-dir /absolute/clean-state

echo-organization-authority-person-admin invite \
  --state-dir /absolute/clean-state \
  --oidc-config /absolute/private/oidc-config.json \
  --pkce-key-file /absolute/private/person-session-pkce-sealing-key \
  --membership-id mem_<id> \
  --expected-email person@example.com \
  --authority-url https://authority.example.com \
  --out /absolute/private/invitation.json

echo-organization-authority-person-admin serve \
  --state-dir /absolute/clean-state \
  --host 127.0.0.1 \
  --port 39479 \
  --authority-url https://authority.example.com \
  --oidc-config /absolute/private/oidc-config.json \
  --pkce-key-file /absolute/private/person-session-pkce-sealing-key
```

The Person `serve` form additionally accepts
`--client-secret-file <absolute-path>` when its OIDC configuration uses a
client-secret authentication method, and an optional
`--slack-approval-channel-id <channel-id>` to expose the temporary public
initial-owner identity-link channel. Do not use
the low-level invitation form for the initial-owner or employee product flow:
initial-owner setup and the owner-facing Person client keep membership IDs
internal.

### 3. Install credentials and finalize while stopped

Stop the Organization Authority service. Each source file must contain exactly its value, without
trailing whitespace. The Granola owner-email file must contain the same
canonical lowercase email given to bootstrap and proved by OIDC.

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
owner or employee in the organization to read it. The selected policy freezes
with the approved record.

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

The provider-neutral fresh lineage uses schema version 4 for Authority. It
retains the frozen V3 meeting-processing schema and adds one immutable
approval-delivery quarantine table. A meeting whose complete approval package
cannot be represented is fenced before any provider post, retained for audit,
and no longer blocks later source meetings. A temporarily missing reviewer
identity is not quarantined; its existing durable outbox stays queued for
reconciliation.
Control-plane and record-log remain at schema version 2, while record-derived
and the three Layer-2 planes (`facts`, `lexical`, and `content`) remain at
schema version 1. Each baseline applies only to a completely empty database.
Authority V1-V3 and any other mismatched lineage are refused rather than
upgraded in place. Do not modify SQLite files, copy one state directory into
another, or introduce a schema migration under this runbook. After the first
user release, use only
baseline-preserving image replacements through the
[release procedure](../../deploy/release/README.md).

The V4 approval-quarantine candidate changes the Authority baseline bytes and
replaces earlier V3 rehearsal state through clean re-onboarding. It is not a
compatible image update for that discarded rehearsal lineage. While there are
still no live users, use the supported `replace-rehearsal` onboarding path; do
not deploy the V4 runtime as an ordinary replacement over V3 state.

## Verification

Run the focused Authority test suite after a code change:

```sh
npm run test:authority
```

Run the repository documentation check after editing this runbook:

```sh
npm run check:docs
```
