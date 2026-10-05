# Tool onboarding v1: Slack set up and connected from the ECHO app (2026-09-30)

Status: **historical** (revision 3, 2026-09-30). Phase 1 shipped in #251
(`1d7e72b`), with the reconnect fix in #258 (`9bce5c1`). Phase 2, the desktop
setup and connect experience, is not built. The phase-0 spike in section 7 was
never recorded (ADR-0027, Spike-sensitive). The bot is delivery-only and asks
for exactly the four scopes in section 5.1.

Current records, which win where this doc disagrees:
- [ADR-0025](../decisions/ADR-0025-nango-holds-slack-connection-credentials.md):
  custody, options, migration and evidence;
- [ADR-0027](../decisions/ADR-0027-rebind-lost-nango-slack-connection.md) (proposed):
  rebind (exact-only);
- [organization control plane](../architecture/organization-control-plane.md):
  Slack connection onboarding gate and Person Slack identity link;
- [shared connector contracts](../architecture/connector-contracts.md): the
  `person tools` seam and personal access model.

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

| Part | Decision |
|---|---|
| Connected tools page, owner setup, person connect/disconnect | **Keep.** ECHO's product experience (section 4). |
| Custom OAuth install routes, code exchange, token lifecycle | **Replaced by Nango connections.** |
| ECHO person ↔ Slack workspace/user binding | **Keep in ECHO.** Nango never decides who an ECHO person is. |
| Private Slack app per organization and signed approval interactions | **Keep, reworked** to sit beside Nango. |
| Removing host onboarding and changing deployment manifests | **In scope** (revision 3): switch over on a fresh setup, with no legacy coexistence (section 7). |

- **Nango holds the organization's Slack connection.** It runs the OAuth
  install, keeps the bot token and handles reconnects. ECHO uses one Nango Slack
  integration with **per-connection OAuth client overrides**. These are
  `integrations_config_defaults.<integration>.connection_config.oauth_client_id_override`,
  `oauth_client_secret_override` and `oauth_scopes_override`, all set on
  `POST /connect/sessions`
  ([docs](https://nango.dev/docs/reference/api/connect/sessions/create)), so each
  organization keeps its own private app.
- **The private app per organization stays** (founder, option b). ECHO creates
  it from its recipe through Slack's Manifest API
  ([`apps.manifest.create`](https://docs.slack.dev/reference/methods/apps.manifest.create/)),
  and the owner pastes one app configuration token, which expires after 12
  hours. Rejected for now: one shared ECHO app. Without a Marketplace listing,
  Slack throttles `conversations.history` and `conversations.replies` for new
  installs of distributed apps
  ([changelog](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/)).
- **Signed approval interactions stay with ECHO.** Nango's Slack webhook support
  covers the Events API only
  ([docs](https://nango.dev/docs/api-integrations/slack/webhooks)), and
  interactivity payloads are not forwarded
  ([NangoHQ/nango#5434](https://github.com/NangoHQ/nango/issues/5434), closed
  as not planned). The recipe points Interactivity at the Authority, and the
  existing handler verifies Slack's signature.
- **The person link stays ECHO-owned.** It is "Sign in with Slack" (OpenID
  Connect) using the organization app's client credentials, with the DM code as
  fallback. Nango does not offer Slack's OpenID flow, and a person link needs
  no stored user token. When Ask later reads Slack (RFC-0003), that feature
  must use the asker's user token explicitly, because Nango's Slack proxy
  defaults to the bot token
  ([docs](https://nango.dev/docs/api-integrations/slack/slack-user-access-tokens)).
- **Credential custody changes.** Nango holds the Slack bot token and a copy of
  the organization app's client secret. The Authority keeps:
  - the app's client ID and client secret, for connect sessions and person
    sign-in;
  - the signing secret, for interactions;
  - the Nango connection ID.

  This departs from "the Authority owns provider credentials"
  ([identity and onboarding](../architecture/identity-and-onboarding.md)), so an
  ADR records it before the cutover.
- **Hosting is open** (founder decision). Free self-hosted Nango offers auth and
  proxy only, with no webhooks
  ([docs](https://nango.dev/docs/guides/platform/self-hosting)). The proof uses
  Nango Cloud or an enterprise self-host. The Authority takes Nango's base URL
  as configuration, so the choice does not change code.
- **The public identity-link channel, the reaction-era permissions, the legacy
  bot-token path and the stopped-state Slack CLI all go** (revision 3).

## 4. What people experience

### Organization setup (owner, once, in the ECHO app)

Account → Connected tools → Slack → **Set up**:

1. "Generate a setup token in Slack" with an [Open Slack] button to the app
   settings page, where the owner clicks **Generate Token** under "Your App
   Configuration Tokens" and copies it.
2. The owner pastes it. ECHO creates the private "ECHO" app in that workspace.
3. **Install to Slack** opens the Connect page in the browser, which leads to
   Slack's install page; the owner approves. The app shows "Finish in your
   browser…" with [Cancel] and ends on "Connected to *Workspace*".

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
| `person tools connect --tool slack` | Opens Slack, waits, prints `connected` |
| `person tools connect --tool slack --method dm-code --slack-user U…` | Today's DM code exchange, for machines without a browser |
| `person tools disconnect --tool slack` | Disconnect |
| `person tools status` / `person tools cancel --tool slack --attempt-id …` | Check or cancel a browser step started with `--no-wait` |

Retired with phase 1 (revision 3):
- `slack-connect-begin`, `slack-connect-status` and `slack-disconnect`;
- `slack-link`, which becomes `--method dm-code`.

Retired commands are refused as unknown, following PR #247's pattern. There is
no hand-entered app-credentials fallback. If a setup token fails, the owner
generates a new one.

## 5. Authority changes

### 5.1 The recipe

Built from the Authority URL and the Nango callback URL. It contains no
organization-specific secrets.

- Display name and bot user "ECHO".
- Bot permissions, exactly four: `chat:write`, `im:history`, `im:write`,
  `users:read`.
- Redirect URLs:
  - Nango's OAuth callback (configured). For Nango Cloud this is expected to be
    `https://api.nango.dev/oauth/callback`, confirmed by the spike.
  - The person browser callback `/v2/person/external-identities/slack/browser/callback`.
- Interactivity on, with Request URL `/v2/integrations/slack/interactions` on
  the Authority.
- The app's Messages tab on and writable, so a person can reply to ECHO's DM.
- No Socket Mode, no Event Subscriptions, no token rotation, no Enterprise Grid
  deployment.

### 5.2 Nango access

- **Configuration:** the Nango base URL, the Nango Slack integration key, and
  the environment secret key. The key is read from a private credential file
  and never logged.
- **Calls:**
  - `POST /connect/sessions`;
  - `POST /connect/sessions/reconnect`, which keeps the connection ID;
  - `GET /connections/{id}?provider_config_key=…`.
- **Finding the connection a Connect flow created:** the session carries `tags`
  (organization, membership and attempt IDs). The spike decides how the
  Authority finds the new connection: by listing connections filtered by those
  tags, which needs no webhook, or by receiving Nango's signed auth webhook
  (`X-Nango-Hmac-Sha256`). Prefer the poll if Nango supports it, because it
  adds no public route.
- **Reconnect completion:** poll the existing connection ID and require the
  current attempt's organization, membership and attempt tags before the fresh
  Slack checks. Nango's top-level `updated_at` is provider metadata, not proof
  that this attempt completed. Creating a reconnect session alone must leave
  the attempt pending. Nango documents [tags as authorization correlation](https://nango.dev/docs/guides/auth/connection-tags-configuration-metadata)
  and [reconnect sessions](https://nango.dev/docs/reference/backend/http-api/connect/sessions/reconnect);
  the matching-tag completion path is source-tested, with live revalidation
  pending after deployment.

### 5.3 Owner setup and install (Slack provider routes)

Every authenticated route re-checks that the caller is a current owner.

1. **Setup** (configuration token). Calls `apps.manifest.create`, or
   `apps.manifest.update` when this organization already has an ECHO app, then
   stores the app credential bundle in the Authority secret store. The token is
   used once in memory and never stored, logged or echoed.
2. **Install begin.** Creates a Nango connect session carrying the organization
   app's client overrides, the four scopes and the attempt tags. When the bundle
   already holds a Nango connection ID it creates a reconnect session instead.
   It returns the session's `connect_link`, which the client opens in the
   system browser. Session links last 30 minutes, and ECHO's attempt lasts 10
   minutes.
3. **Install status** (same owner session family):
   1. finds the Nango connection for the attempt;
   2. reads its Slack identifiers (team, app, bot user);
   3. fetches the bot token from Nango;
   4. re-runs ECHO's existing Slack checks (`auth.test`, `bots.info`, the four
      permissions);
   5. activates the organization connection and records the Nango connection ID
      in the bundle.
4. **Install cancel.**

One install attempt is in flight per organization.

### 5.4 Connection record

No control-plane DDL change; baseline V3 stays.

- **Contract.** It keeps `echo-organization-tool-connection-v2` with the four
  permissions. `public_connection_configuration_sha256` hashes the
  configuration kind `echo-slack-nango-app-public-configuration-v1`.
- **Credential bundle.** One Authority secret, referenced by the state's
  `credential_reference_sha256`, holding `app_id`, `client_id`, `client_secret`,
  `signing_secret` and `nango_connection_id`. The connection ID is `null` until
  the first install completes. There is no bot token in the Authority.
- **No legacy connections** (revision 3). A Nango-kind connection is the only
  kind. The old bot-token-and-channel path, its local token and its
  signing-secret file are removed. Staging gets a fresh setup.

### 5.5 Reconnect, replacement and loss

- **Reconnect or update of the same app.** This uses a Nango reconnect session
  on the same connection ID. The bundle, the connection state hash and every
  waiting approval card are unchanged. This is the required proof that
  reconnect preserves outstanding cards.
- **Different app or workspace: refused in v1** (revision 3). An install of a
  different app fails with "Slack is already connected to a different app or
  workspace." A reconnect that lands in another workspace or bot fails as a
  workspace mismatch, and the owner reconnects choosing the organization's
  workspace; until then Nango's connection holds the other one, so the
  connection reads "needs reinstall". This avoids the restart failure that
  replacing a connection causes for organizations with decided cards. Moving an
  organization to another workspace is designed later if a real need appears.
- **Lost token** (uninstalled in Slack, or Nango reports a failed refresh). A
  Slack authentication error marks the connection "needs reinstall" in memory,
  and the tools status shows it. The owner's Install then runs a reconnect.
- **Lost Nango connection** (proposed in
  [ADR-0027](../decisions/ADR-0027-rebind-lost-nango-slack-connection.md)).
  A 404 from Nango for the connection marks it "needs reinstall" the same way.
  The owner's Install then opens a new connection and, if it reproduces the
  stored verification evidence, rebinds the bundle's Nango connection ID under
  the same handle. The state hash and every waiting card are unchanged.

### 5.6 Using the bot token

- The approval poster and the identity flows fetch the bot token from Nango at
  use time.
- The token is cached in memory per connection for at most five minutes.
- On a Slack authentication error the Authority re-reads the connection from
  Nango once, past its cache but without `force_refresh` (rotation is off, so
  only a reconnect brings a new token), then marks the connection "needs
  reinstall". A Nango connection that no longer matches the active one, or a
  404 for it, is marked the same way.
- The Authority calls Slack directly with the fetched token, not through the
  Nango proxy, so ECHO's existing Slack clients and checks stay unchanged.

### 5.7 Interactions and the person link

- The interaction handler is unchanged apart from where it gets its signing
  secret, which now comes from the credential bundle.
- The browser person-link provider is built from the bundle's client ID and
  secret, so person Connect works whenever the organization is connected.

### 5.8 Person tools contract

`/v4/person/tools` adds `organization_setup` to each tool:
- `not_set_up`, `app_created`, `connected` or `needs_reinstall` for owners;
- `null` for everyone else.

The v3 route strips the field and keeps serving older clients.

## 6. Client changes

- **Phase 1, CLI:** the `person tools` verbs in section 4. `setup` and `connect`
  open the returned link in the system browser, then poll every ~2 seconds for
  up to 10 minutes. The setup token is read from standard input only.
- **Phase 2, desktop:** the Connected tools rows, the Set up sheet, the waiting
  state with Cancel, and the Home nudge from section 4. These are driven by the
  same verbs, using `--no-wait` plus status polling. The setup token is handed
  over in process, never as an argument.

## 7. Host setup and phases

- **Phase 0, spike (throwaway).** With a real Nango environment and a Slack
  sandbox workspace, confirm:
  - the per-connection client override works for a private app;
  - the Nango callback URL;
  - where `team.id`, `app_id` and `bot_user_id` sit in `GET /connections`;
  - how to find the connection a session created (tag filter or webhook);
  - that reconnect keeps the ID with overrides;
  - what `DELETE` does to the Slack token.

  The answers are recorded here before phase 1 code relies on them.
- **Phase 1, switch over** (revision 3).
  - The Authority and Slack provider changes in section 5, plus the CLI.
  - Remove legacy-connection support, the stopped-state Slack CLI and the
    initial-owner Slack bootstrap.
  - Host onboarding drops `slack-bot-token`, `slack-signing-secret`,
    `slack_approval_channel_id`, `configure-slack-browser` and the
    Interactivity URL step.
  - Host onboarding gains the Nango secret key as a private input file, plus
    the Nango integration key in the onboarding JSON.
  - The setup manifest becomes v2.
  - The setup steps become: create Authority, owner signs in, **owner sets up
    Slack in the app**, owner connects, provider credentials, finalize,
    canary.
  - Staging gets a fresh setup through `replace-rehearsal`.
  - The ADR on credential custody lands with this phase.
- **Phase 2.** The desktop experience.

## 8. Errors and edge cases

| Situation | Behaviour |
|---|---|
| Setup token invalid, expired or lacking permission | "That token didn't work. Generate a new one in Slack." |
| App created, install never finished | Row shows "App created" with [Install]; resumable without a new token |
| New token while an ECHO app exists | Updates the same app; no duplicate |
| Workspace requires admin approval for apps | Not detectable. On expiry: "Not finished. If your Slack requires admin approval, try again once it's approved." |
| Nango unavailable | "Slack setup is unavailable right now. Try again." Existing cards keep working while the cached token is valid |
| Two owners at once | One wins; the other sees "Setup in progress" |
| Browser on the wrong workspace (person) | "Sign in to the *Workspace* Slack workspace, then try again." |
| Slack account linked to another ECHO person | "This Slack account is connected to another ECHO person." |
| Over 10 minutes, or the Authority restarted | "That took too long. Try again." (attempts are in memory) |
| Person leaves the organization | Link stops working, as today |
| Owner who set up leaves | Connection stays; it belongs to the organization |

Known weaknesses kept for this version:
- the browser identity flow ties the Slack sign-in to the workspace, not to the
  app ID;
- Enterprise Grid is unsupported;
- pending attempts are lost on restart.

## 9. Proof

- **Acceptance test (automated, phase 1),** against fake Nango and fake Slack HTTP
  servers. One end-to-end path:
  1. the owner sets up and connects Slack through Nango;
  2. ECHO verifies the workspace and app;
  3. the owner and an employee link their identity;
  4. an approval card is delivered and approved;
  5. a second card is delivered;
  6. the owner reconnects through a Nango reconnect session;
  7. the second card is still approved without `state_drift`.
- **Safety tests:**
  - owner-only routes;
  - the setup token and the Nango secret key never reach SQLite, logs or output;
  - the recipe's exact permissions and URLs;
  - a finished Connect flow is accepted only for its own attempt and owner
    session;
  - an install for a different app or workspace is refused, and nothing changes;
  - live needs-reinstall detection;
  - an Authority restart after a reconnect still starts and still verifies
    waiting cards.
- **CLI:** the setup token is accepted only on standard input, and the DM-code
  fallback still works.
- **Manual phase 1 rehearsal** (human steps), on a local Authority with a real
  Nango environment and a Slack sandbox:
  1. the founder makes a setup token and runs `person tools setup --tool slack`;
  2. the founder connects;
  3. a synthetic card is approved;
  4. a reconnect keeps a waiting card working.
- **Test budget:** test lines roughly 1:1 with production lines; both reported.

## 10. Size

Rough estimate, after mapping:

Revision 3 target: net production change against `main` well under revision
2's projected ~4,000 lines. It removes:
- the legacy-coexistence layer;
- the replacement path;
- the hand-entered fallback;
- the stopped-state Slack CLI and the host Slack inputs.

The phase 1 report gives exact production and test totals.

## 11. Out of scope

- One shared ECHO Slack app, Marketplace listing, or a callback router.
- Replacing an organization's Slack connection with a different app or
  workspace, and the hand-entered app-credentials fallback (revision 3).
- Nango Events API webhooks, syncs, actions and MCP.
- Nango user tokens. They come with Slack as an Ask source (RFC-0003), which
  must use the asker's user token.
- Signing in to ECHO itself with Slack.
- Enterprise Grid org-wide installs.
- Meeting ingestion. That design was deferred on 2026-09-30 under the rule
  "ECHO takes in only what a person could export by hand".
- Any tool other than Slack. Later tools reuse section 2's model and section
  4's `person tools` verbs, and Nango makes adding them cheaper.
