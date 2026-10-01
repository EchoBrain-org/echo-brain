# Tool onboarding v1: Slack set up and connected from the ECHO app (2026-09-30)

Status: design approved in conversation on 2026-09-30, section by section.
This file is the written spec; it awaits founder review before an
implementation plan is written. It is a new dated doc. Older docs stay as
they are; where this doc and an accepted ADR disagree, the ADR wins until an
ADR records this change.

## 1. Why

Slack is the only tool ECHO supports today, and onboarding it is the slowest
part of bringing up an organization:

- **Organization level:** an operator performs about eight manual steps on the
  host. They create a Slack app by hand, pick seven permissions, install it,
  copy the bot token and signing secret into private files, create a public
  channel and invite the bot, set the Interactivity URL after the Authority
  starts, and optionally add a redirect URL plus a client secret and run
  `configure-slack-browser`. See the
  [deploy README](../../deploy/organization-authority/README.md) and
  [`onboard-clean-v1.sh`](../../deploy/organization-authority/onboard-clean-v1.sh).
- **Person level:** each person finds their Slack member ID, runs
  `person slack-link --slack-user U…`, copies a code from the terminal,
  replies with it in a DM from the bot, and presses Enter. The one-click
  browser flow exists on the server but is disabled on staging, is CLI-only,
  and never commits unless someone runs `slack-connect-status` within five
  minutes.

The founder is using Slack to learn how ECHO should onboard any tool. This doc
fixes Slack and records the general pattern later tools reuse.

## 2. The general model

A tool can need up to three things. Each is one button that opens the tool's
own approval page.

| Level | Meaning | Who | Slack |
|---|---|---|---|
| Organization connection | "ECHO may act in our workspace" | An owner, once | Yes: the bot sends approval cards |
| Person link | "This ECHO person is that account" | Each person, once | Yes: cards reach the right DM |
| Person access | "ECHO may read my things there" | Each person, once | Not yet (only if Ask reads Slack, RFC-0003) |

Rules:

1. One button per level, then the tool's own approval page. No copying IDs,
   codes or tokens by default. Where a tool allows it, person link and person
   access are the same click.
2. The organization step happens in the ECHO app, done by an owner, not on a
   server by an operator.
3. ECHO supplies each tool's app ready-configured. Nobody chooses permissions
   or URLs by hand.
4. The person step is offered when it is needed, and lives on one Connected
   tools page with the same states for every tool.
5. Pasting a key or a code remains a fallback, never the default.

## 3. Decisions

- **Organization Slack app: a private copy per organization, created by ECHO
  from its recipe** (founder chose option b on 2026-09-30). Rejected for now:
  one shared ECHO Slack app with "Add to Slack". It needs a routing front door
  for interaction callbacks and, without a Slack Marketplace listing, Slack
  limits `conversations.history`/`conversations.replies` to one request per
  minute and 15 objects for new installs of non-Marketplace distributed apps
  ([Slack changelog, 2025-05-29](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/)).
  Internal customer-built apps are not affected. Revisit when ECHO has enough
  organizations to justify a Marketplace listing.
- **ECHO creates the private app through Slack's Manifest API**
  ([`apps.manifest.create`](https://docs.slack.dev/reference/methods/apps.manifest.create/)).
  The owner pastes one app configuration token (generated in Slack, expires
  after 12 hours). Slack returns the app's client ID, client secret and
  signing secret, so the owner copies nothing else.
- **Person link uses "Sign in with Slack"**, the existing browser identity flow.
  The DM code exchange stays as a CLI fallback for machines without a browser.
- **The public identity-link channel and the reaction-era permissions are
  removed.**

## 4. What people experience

### Organization setup (owner, once, in the ECHO app)

Account → Connected tools → Slack → **Set up**:

1. "Generate a setup token in Slack" with an [Open Slack] button to the app
   settings page, where the owner clicks **Generate Token** under "Your App
   Configuration Tokens" and copies it.
2. The owner pastes it. ECHO creates the private "ECHO" app in that workspace.
3. **Install to Slack** opens Slack's install page; the owner approves. The
   app shows "Finish in your browser…" with [Cancel] and ends on
   "Connected to *Workspace*".

The owner must be allowed to install apps in that Slack workspace. Steps can be
repeated safely; nothing is left half-configured.

### Person connect (everyone, once)

Connected tools shows one row per tool:

```
Slack
  Organization   Not set up                [Set up]      ← owners only
  You            Not connected             [Connect]
```

**Connect** opens Slack's Allow page and ends on "Connected as @name".
Disconnect is in a ⋯ menu. Before setup, non-owners see "Not set up by your
organization. Ask an owner." A one-line Home nudge, "Connect Slack to get your
approval cards", appears only when the organization is connected and you are
not.

### CLI (same verbs for every future tool)

| Command | Purpose |
|---|---|
| `person tools` | List tools; owners also see the organization line |
| `person tools setup --tool slack` | Owner only. Reads the setup token from standard input, creates the app, opens Install, waits |
| `person tools connect --tool slack` | Opens Slack, waits up to 5 minutes, prints `connected` |
| `person tools connect --tool slack --method dm-code --slack-user U…` | Today's DM code exchange, for machines without a browser |
| `person tools disconnect --tool slack` | Disconnect |
| `person tools setup --tool slack --print-recipe` / `--app-credentials-stdin` | Fallback: print the recipe for manual creation in Slack, then accept the created app's client ID, client secret and signing secret as JSON on standard input |

Retired: `slack-connect-begin`, `slack-connect-status`, `slack-disconnect`,
and `slack-link` (folded into `--method dm-code`). Retired commands are
refused as unknown, following PR #247's pattern.

## 5. Authority changes

### 5.1 The recipe

Built from the Authority URL; no organization-specific secrets.

- Display name and bot user "ECHO".
- Bot permissions, exactly four: `chat:write`, `im:write`, `im:history`,
  `users:read`. (Today's seven in
  [`slack-integration-contracts.ts`](../../providers/slack/server/src/organization-control-plane/application/slack-integration-contracts.ts)
  lose `channels:read`, `channels:history` and `reactions:read`. The
  implementation must confirm no remaining call needs them.)
- Redirect URLs: the install callback (5.2) and the existing person browser
  callback `/v2/person/external-identities/slack/browser/callback`.
- Interactivity on, Request URL `/v2/integrations/slack/interactions`.
- No Socket Mode, no Event Subscriptions, no token rotation, no org-wide
  (Enterprise Grid) deployment.

### 5.2 Owner setup routes (Slack provider-owned)

Routes live in the Slack provider package, like today's identity routes, so
provider semantics stay at the boundary
([INV-ADAPTERS-005](../invariants/INV-ADAPTERS-005-provider-semantics-at-boundary.md)).
Every authenticated route re-checks that the caller's current membership is an
owner.

1. **Setup** (owner, Bearer). Body: request ID plus the configuration token.
   The Authority calls `apps.manifest.create` (or `apps.manifest.update` when
   an ECHO app already exists for this organization), stores the returned
   client ID, client secret and signing secret in the private file secret store,
   records the app ID, and returns an install attempt. The configuration token
   is used in memory once and never stored, logged or echoed.
2. **Install begin** (owner, Bearer). Returns a Slack OAuth v2 authorize URL with
   the four bot permissions, the install redirect URL and a one-shot `state`
   (32 random bytes, 5-minute life). Resumable at any time after setup.
3. **Install callback** (no authentication, like the existing browser callback).
   Records the returned code against the attempt only and returns a static
   "Return to ECHO" page. It cannot connect anything by itself.
4. **Install status** (owner, Bearer, same session family as begin). Exchanges
   the code with `oauth.v2.access`, re-runs the existing workspace and bot checks
   ([`slack-web-identity-provider-v1.ts`](../../providers/slack/server/src/organization-control-plane/adapters/slack/slack-web-identity-provider-v1.ts)),
   stores the bot token, and activates the connection through the existing
   coordinator
   ([`sqlite-slack-connection-coordinator-v1.ts`](../../providers/slack/server/src/organization-control-plane/persistence/sqlite-slack-connection-coordinator-v1.ts)).
5. **Install cancel** (owner, Bearer).

Only one setup or install attempt is in flight per organization; a second owner
gets "Already set up" or "Setup in progress".

### 5.3 Slack switches on without a restart

Today the service reads three Slack inputs once at startup
([`organization-authority-service-cli.ts`](../../services/organization-authority/src/composition/organization-authority-service-cli.ts),
[`organization-authority-composition-root.ts`](../../services/organization-authority/src/composition/organization-authority-composition-root.ts)):
`--slack-signing-secret-file`, the manifest's `slack_connection_id` and
`slack_approval_channel_id`, and the optional browser OAuth file. These become
lookups of the single active connection and its stored secrets, cached per
connection revision:

- The approval workflow
  ([`private-slack-approval-workflow-bundle-v1.ts`](../../providers/slack/server/src/private-approval/private-slack-approval-workflow-bundle-v1.ts))
  resolves the active connection instead of a pinned ID, and verifies
  interaction signatures with the stored signing secret.
- The identity runtime
  ([`slack-person-external-identity-runtime-bundle-v1.ts`](../../providers/slack/server/src/person-identity/slack-person-external-identity-runtime-bundle-v1.ts))
  builds the browser sign-in provider from the stored client ID and secret.
  The browser flow is therefore on whenever Slack is connected.
- Before setup, Slack features answer "not set up by your organization"
  instead of failing.

### 5.4 Connection record

Adjusted 2026-09-30 after mapping the code (founder approved). No
control-plane DDL changes, so baseline V3
([`organization-control-plane-baseline-v3.sql`](../../packages/organization-control-plane/baselines/organization-control-plane-baseline-v3.sql))
stays as it is.

- **Contract shape unchanged.** The contract keeps `echo-organization-tool-connection-v2`.
  `required_provider_scopes` becomes the four recipe permissions.
  `public_connection_configuration_sha256` hashes a new channel-free
  configuration kind, `echo-slack-private-app-public-configuration-v1`,
  instead of the channel and reaction configuration.
- **Credential.** The state's single `credential_reference_sha256` points at
  one private secret holding the app credential bundle: bot token, client ID,
  client secret and signing secret. SQLite keeps only the reference hash, as
  today.
- **Health is not stored.** "Needs reinstall" is detected live (5.5). Storing it
  would need a DDL change.
- **Compatibility gate.** Connections made by the old bot-token-and-channel
  path no longer validate. The gate is the new setup manifest version (section
  7), so staging needs a fresh setup through `replace-rehearsal`.

The DM code fallback stops re-verifying a channel.

### 5.5 Replacing or losing the connection

Adjusted 2026-09-30 (founder approved). Pending approval records in both the
Authority and control-plane databases are immutable and bound to the exact
connection state they were sent under. The private-approval runtime refuses to
start if an outstanding card belongs to a connection that is no longer current.
Re-sending cards would need a new mechanism across both databases, so this
version avoids needing it:

- **Same app, updated or reinstalled**, including after an uninstall in Slack:
  the Authority replaces the stored credential bundle in place, under the same
  secret reference. The connection, its state hash and waiting cards are
  unchanged, so nothing needs re-sending.
- **Different app or workspace:**
  - allowed only while no approval card is outstanding under the current
    connection, and only with an explicit confirmation;
  - the old connection is revoked;
  - a different workspace also revokes every person link, and people reconnect
    with one click;
  - if cards are waiting, the refusal says how many.
- **Uninstalled or revoked in Slack:** a Slack call failing with an
  authentication-class error marks the connection "needs reinstall" in memory,
  and the tools status shows it. After a restart it is detected again on the
  next failing call. Cards wait and go out after the same-app reinstall.

### 5.6 Person tools contract

`/v3/person/tools` has exact keys, so the organization line ships as a v4
contract at `/v4/person/tools`. It adds an `organization_setup` field to each
tool:
- `not_set_up`, `app_created`, `connected` or `needs_reinstall` for owners;
- `null` for everyone else.

The v3 route keeps serving older clients until the matched client ships, then
is retired. See
[`person-tools-v3.ts`](../../packages/organization-api/src/person-tools-v3.ts).

## 6. Client changes

- **Desktop**
  ([`account.tsx`](../../product/echo-desktop/src/renderer/screens/account.tsx),
  [`host.ts`](../../product/echo-desktop/src/host/host.ts)):
  Connected tools gains the rows and sheets in section 4. The host runs the new
  `person tools` verbs in process. The setup token is handed over through an
  in-process input channel, never as an argument; `read_input` throws today.
  Browser waits poll every ~2 seconds for up to 5 minutes, and Cancel calls the
  cancel route. Adds the Home nudge.
- **CLI**
  ([`slack-commands.ts`](../../providers/slack/client/src/person/slack-commands.ts)
  and the person-client command table): the `person tools` verbs in section 4.
  Browser waits print JSON phases (`open-browser`, `waiting`, `connected`).
  Unknown-outcome rules follow the existing session fences.

## 7. Host setup changes

- The onboarding input directory drops `slack-bot-token` and
  `slack-signing-secret` (nine files become seven). The onboarding JSON drops
  `slack_approval_channel_id`, and the manifest version is bumped.
- `bootstrap` no longer connects Slack. The setup CLI's next steps
  ([`organization-authority-setup-cli.ts`](../../services/organization-authority/src/composition/organization-authority-setup-cli.ts))
  become:
  1. create Authority
  2. owner signs in
  3. **owner sets up Slack in the app** (new `connect_slack_in_app`)
  4. owner connects themselves
  5. provider credentials
  6. finalize
  7. canary

  `finalize` still requires an active connection and the owner's link.
- Removed: the stopped-state
  [`slack-connection-setup-cli.ts`](../../providers/slack/server/src/organization-control-plane/composition/slack-connection-setup-cli.ts)
  and
  [`initial-owner-slack-setup-v1.ts`](../../providers/slack/server/src/setup/initial-owner-slack-setup-v1.ts)
  path, `configure-slack-browser`, and the "set the Interactivity URL" step,
  since the recipe sets it.
- Docs updated in the same change:
  - [identity and onboarding](../architecture/identity-and-onboarding.md)
  - [person client architecture](../architecture/person-client-architecture.md)
  - [organization control plane](../architecture/organization-control-plane.md)
  - the deploy README
  - [PB-OPERATIONS-001](../operations/PB-OPERATIONS-001-authority-operator-lane.md)

## 8. Errors and edge cases

| Situation | Behaviour |
|---|---|
| Setup token invalid, expired or lacking permission | "That token didn't work. Generate a new one in Slack." |
| App created, install never finished | Row shows "App created" with [Install]; resumable without a new token |
| New token while an ECHO app exists | Updates the same app; no duplicate |
| Workspace requires admin approval for apps | "Waiting for your Slack admin to approve"; Install works after approval |
| Two owners at once | One wins; the other sees "Already set up" or "Setup in progress" |
| Browser on the wrong workspace (person) | "Sign in to the *Workspace* Slack workspace, then try again." |
| Slack account linked to another ECHO person | "This Slack account is connected to another ECHO person." |
| Over 5 minutes, or the Authority restarted | "That took too long. Try again." (attempts are in memory) |
| Person leaves the organization | Link stops working, as today |
| Owner who set up leaves | Connection stays; it belongs to the organization |

Known weaknesses kept for this version:
- the browser identity flow does not tie the Slack sign-in to the connected
  app's ID beyond the workspace;
- Enterprise Grid is unsupported;
- pending attempts are lost on restart.

## 9. Proof

- **Fake-Slack automated tests:**
  - owner-only routes;
  - the configuration token never reaches SQLite, logs or output;
  - the recipe has exactly four permissions and Authority-derived URLs;
  - the callback alone cannot connect;
  - only the same owner session commits;
  - single in-flight setup;
  - same-app reinstall replaces the credential in place and a waiting card still
    resolves;
  - different app or workspace refused while a card is outstanding, allowed
    with confirmation otherwise;
  - a different workspace revokes person links;
  - live needs-reinstall detection;
  - connect-then-card-posts without a restart, with the interaction signature
    verified by the stored signing secret.
- **CLI:** setup token accepted only on standard input; retired commands
  refused as unknown; DM-code fallback still works.
- **Desktop end-to-end:** owner and non-owner rows, Set up sheet, Connect wait,
  Cancel, Home nudge.
- **Staging rehearsal on a fresh lineage**, using the human
  `replace-rehearsal` lane:
  1. the founder generates a real setup token, sets up Slack in the app and
     connects;
  2. the canary card is approved;
  3. the teammate connects with one click.
- **Test budget:** test lines roughly 1:1 with production lines; both reported.

## 10. Size

Revised 2026-09-30 after mapping: about 1,200–1,500 production lines changed
across the branch, much of it deletions, with tests at a similar scale.

- **Authority and Slack provider:** about 600–800 lines.
- **Desktop and CLI:** about 300–400 lines.
- **Host setup:** net deletions, from the stopped-state Slack CLI, the
  Slack inputs and `configure-slack-browser`.

## 11. Out of scope

- One shared ECHO Slack app, Marketplace listing, or a callback router.
- Signing in to ECHO itself with Slack.
- Enterprise Grid org-wide installs.
- Slack as an Ask source (RFC-0003).
- Meeting ingestion. That design was deferred on 2026-09-30 under the rule
  "ECHO takes in only what a person could export by hand".
- Any tool other than Slack. Later tools reuse section 2's model and section
  4's `person tools` verbs.
