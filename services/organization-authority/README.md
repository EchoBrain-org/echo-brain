# Organization Authority: clean V1 runbook

`organization-authority` is the clean-V1 Authority runtime. It owns clean
genesis, Person OIDC sessions, the founder Slack identity link, live-only
Granola processing, approval finalization, immutable V4 records, and
permission-aware Person reads. It has no compatibility runtime for a prior
Authority state: start with a new state directory and do not reuse legacy
state, credentials, or volumes.

For the production Compose profile and host preparation, use the
[deployment README](../../deploy/organization-authority/README.md). The
[organization onboarding and employee rollout](../../docs/product/2026-08-22-organization-onboarding-and-employee-rollout-v1.md)
defines the supported operator and employee flow.

## Build and commands

Build the workspace before using the local `dist/` entrypoints:

```sh
npm run build --workspace @echo-brain/organization-authority
```

The package exposes these clean commands:

- `echo-organization-authority-init-clean-state`
- `echo-organization-authority-clean-founder`
- `echo-organization-authority-clean-person`
- `echo-organization-authority-clean-live`

Use absolute canonical paths. Private credential and invitation directories
must be current-user `0700`; private input and invitation files must be
current-user `0600` regular files. Never place token or credential bytes on a
command line.

## Fresh clean state

The standalone reset command creates a new clean lineage from an absent state
directory. It applies the frozen baselines, creates the Authority descriptor
and owner, and prints only its JSON result.

```sh
echo-organization-authority-init-clean-state \
  --state-dir /absolute/clean-state \
  --organization-name 'Example Organization' \
  --owner-display-name 'Founder Name' \
  --created-at '2026-08-23T00:00:00.000Z' \
  --artifact-revision clean-v1
```

Normally use the founder bootstrap below instead: it creates this same clean
state with a durable setup plan, generated internal IDs, Person credentials,
Slack connection, and founder invitation. Do not run reset into a directory
that already contains state.

## Founder onboarding

Bootstrap and finalization are stopped-state operations. The path is:

1. Bootstrap the clean lineage, initialize Person credentials, verify the Slack
   bot and temporary public founder identity-link channel, and issue the
   founder invitation. That channel never receives an approval card.
2. Start clean live, complete the founder's browser OIDC sign-in, and link the
   signed-in founder to Slack.
3. Stop clean live, install the three provider credentials, then finalize.
4. Restart clean live and complete the live-only canary.

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
founder's Slack identity-link challenge. It is not an approval destination or
approval-readiness gate.

```sh
echo-organization-authority-clean-founder bootstrap \
  --state-dir /absolute/clean-state \
  --organization-name 'Example Organization' \
  --owner-display-name 'Founder Name' \
  --owner-email founder@example.com \
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
echo-organization-authority-clean-founder resume \
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
echo-organization-authority-clean-founder status \
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
4. Use a wholly fresh provider-neutral V3 staging lineage. Do not upgrade or
   reuse an earlier shared-channel rehearsal database, state directory, or
   approval binding.

Complete bootstrap, the founder identity link, credential installation, and
finalization first, then start the active runtime. Only after that runtime is
healthy, enable **Interactivity & Shortcuts** and save this Request URL before
creating the first post-cutoff canary meeting:

```text
https://<staging-authority-host>/v2/integrations/slack/interactions
```

The callback deliberately returns `503` before finalization, so do not try to
validate or save that URL against a pre-finalize runtime. Event Subscriptions,
Socket Mode, and a Slack OAuth redirect are not required for this V1.

The temporary public identity-link channel is still required only until the
linking transport is moved to a private surface. It receives the founder's
challenge thread, never shared approval cards.

### 2. Start Person service, sign in, and link Slack

Before finalization, clean live exposes the Person surface with an inert
processing worker. The manifest supplies the Authority URL, OIDC configuration,
PKCE key, and Slack channel, so they are not repeated here.

```sh
echo-organization-authority-clean-live serve \
  --state-dir /absolute/clean-state \
  --host 127.0.0.1 \
  --port 39479 \
  --slack-signing-secret-file /absolute/private/slack-signing-secret
```

For `client_secret_basic` or `client_secret_post`, append
`--client-secret-file /absolute/private/oidc-client-secret`. The listener only
accepts `127.0.0.1` or `::1`; put the configured HTTPS Authority origin behind
the deployment proxy or tunnel.

On the founder's current-user machine, use the private invitation produced by
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
founder to finalize; it is not required for a read-only employee.

The Person session surface also supports refresh and logout. The packaged
client owns those details:

```sh
echo-brain person status
echo-brain person session-refresh
echo-brain person logout
```

### Clean Person developer commands

`clean-live serve` is the normal runtime entrypoint. For focused local
development, the lower-level clean Person entrypoint has only these forms:

```sh
echo-organization-authority-clean-person credentials-init \
  --state-dir /absolute/clean-state

echo-organization-authority-clean-person invite \
  --state-dir /absolute/clean-state \
  --oidc-config /absolute/private/oidc-config.json \
  --pkce-key-file /absolute/private/person-session-pkce-sealing-key \
  --membership-id mem_<id> \
  --expected-email person@example.com \
  --authority-url https://authority.example.com \
  --out /absolute/private/invitation.json

echo-organization-authority-clean-person serve \
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
founder identity-link channel. Do not use
the low-level invitation form for the founder or employee product flow: clean
founder onboarding and the owner-facing Person client keep membership IDs
internal.

### 3. Install credentials and finalize while stopped

Stop clean live. Each source file must contain exactly its value, without
trailing whitespace. The Granola owner-email file must contain the same
canonical lowercase email given to bootstrap and proved by OIDC.

```sh
echo-organization-authority-clean-founder credentials-install \
  --state-dir /absolute/clean-state \
  --granola-credential-file /absolute/private/granola-organization-key \
  --granola-owner-email-file /absolute/private/granola-owner-email \
  --llm-credential-file /absolute/private/llm-provider-credential

echo-organization-authority-clean-founder finalize \
  --state-dir /absolute/clean-state
```

Credential installation validates all three inputs before replacing any fixed
destination. Finalization requires the clean genesis, an exact active Slack
connection, the founder's active OIDC binding and Slack identity link, and
valid provider credentials. It creates no shared-channel/reaction approval
binding; it only admits Granola at a fresh live-only cutoff. Existing notes are
not imported.

### 4. Restart live runtime and canary

Restart the same `clean-live serve` command. Optional
`--worker-interval-ms <positive-integer>` changes the worker interval. At
startup, the runtime reconciles Layer 2 once, then each cycle recovers pending
V4 appends, polls the admitted live-only source, finalizes approvals, appends
approved records, and reconciles Layer 2 again.

Create one new post-finalization Granola note with a unique marker, approve its
private meeting-owner Slack DM card, then check both read paths:

```sh
echo-brain person records --limit 20
echo-brain person records --query 'known marker'
```

Rerun `echo-organization-authority-clean-founder resume --state-dir
/absolute/clean-state`, then `status`. The one-note canary is complete only
when durable state proves source progress, an approved record, an exact-head
Layer 2 generation, and positive owner Layer 1 and Layer 2 reads after that
head and generation. The status output contains only boolean or enum evidence;
it never prints record, reader, query, or timestamp data.

## Person reads and permissions

Both paths require a current bearer-backed Person session. Caller identity is
never accepted from a request body, and the Authority proves the same session,
identity binding, membership tenure, and person state again immediately before
releasing results.

| Path | Client command | Behavior |
| --- | --- | --- |
| Layer 1 list | `echo-brain person records --limit 20` | Returns released immutable V4 record envelopes. It remains available while Layer 2 catches up. |
| Layer 2 search | `echo-brain person records --query 'text'` | Searches the current immutable generation and returns its generation/head metadata plus per-item atom, record, and policy identity. It is unavailable until the active generation matches the exact Layer-1 head. |

Layer 2 is rebuilt at startup and after a coalesced approved-record append; a
query never triggers a build. If the head advances or a generation build fails,
the existing pointer is not used for the new head. The Person client reports
that search is catching up; wait for the next worker cycle and retry.

Approved content is selected at the frozen Granola source snapshot:

- By default, `organization-member-readable-person-v2` allows every current
  active owner or employee in the organization to read the record.
- A note in a folder named exactly `echo-restricted` selects
  `restricted-reviewer-person-v2`; only the exact approving owner and that
  owner's current membership tenure may read it.

A later folder move does not reinterpret a posted card or approved record.
Revoking a membership denies both list and search for that tenure. A newly
invited employee gets a new membership tenure and may read only content allowed
to that membership. The owner sees the current roster with
`echo-brain person employee list`; invite, list, reissue, and revoke commands
are documented in the [product onboarding flow](../../docs/product/2026-08-22-organization-onboarding-and-employee-rollout-v1.md#employee-rehearsal-commands).

## State and baselines

Clean V1 is a new lineage, not an upgrade mechanism. Reset creates the state
directory atomically and records a lineage root plus role-specific manifests.
Startup verifies the root and every persisted database identity, schema
version, and baseline digest before opening the live runtime.

The provider-neutral fresh lineage uses schema version 3 for Authority.
Control-plane and record-log remain at schema version 2, while record-derived
and the three Layer-2 planes (`facts`, `lexical`, and `content`) remain at
schema version 1. Each baseline
applies only to a completely empty database. A V1 Authority, control-plane, or
record-log lineage is refused rather than upgraded in place. Do not modify
SQLite files, copy one state directory into another, or introduce a schema
migration under this runbook. After the first live-user release, use only
baseline-preserving image replacements through the
[release procedure](../../deploy/release/README.md).

The pre-live roster candidate changes the Authority baseline bytes and replaces
earlier rehearsal state through clean re-onboarding. It is not a compatible
image update for that discarded rehearsal lineage.

## Verification

Run the focused Authority test suite after a code change:

```sh
npm run test:authority
```

Run the repository documentation check after editing this runbook:

```sh
npm run check:docs
```
