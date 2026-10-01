---
schema_version: 1
id: ADR-0025
kind: decision
title: Nango holds Slack connection credentials
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-IDENTITY-ACCESS
  - CMP-PROCESSING-ADAPTERS
  - CMP-PERSON-CLIENT
created_at: 2026-09-30
reviewed_at: 2026-10-01
reviewed_ref: 9ba7aa782f8d427401699ef5fbfabb46b524c208
status: accepted
supersedes: []
superseded_by: []
updates: []
---

# ADR-0025: Nango holds Slack connection credentials

## Context and options

[Identity and onboarding](../architecture/identity-and-onboarding.md) says the
Authority owns provider credentials. Slack onboarding needed that to stay true
while removing the eight manual host steps an operator ran to stand up an
organization's Slack connection: creating the Slack app by hand, picking
permissions, installing it, copying the bot token and signing secret into
private files, creating a channel, and setting the Interactivity URL after the
Authority started. [Tool onboarding v1, revision 3](../product/2026-09-30-tool-onboarding-slack-v1.md)
moves that ceremony into the ECHO app: an owner pastes one Slack app
configuration token, and ECHO creates and installs a private Slack app for
that organization.

Two ways to run the OAuth install and hold the resulting bot token were
considered:

- **A. Custom OAuth, Authority-held token (status quo).** The Authority runs
  its own install routes, code exchange and token lifecycle, and keeps the bot
  token in its private secret store, as it does today. Rejected for the
  rewrite: the Authority would still have to build and operate token refresh,
  install-state and re-auth handling that an OAuth broker already solves, for
  the one provider ECHO supports.
- **B. Nango holds the connection.** Nango runs the OAuth install, keeps the
  bot token, and reconnects it. Chosen.
- **C. Nango holds everything, including interactivity and person identity.**
  Also route Slack's interactive approval payloads and the person-link sign-in
  through Nango. Rejected: Nango's webhook support covers the Events API only,
  not interactivity payloads
  ([NangoHQ/nango#5434](https://github.com/NangoHQ/nango/issues/5434), closed
  as not planned), and Nango does not offer Slack's OpenID Connect flow at
  all.

A private Slack app per organization, created from ECHO's own manifest recipe,
stays either way (founder decision, carried from revision 2): one shared ECHO
app would hit Slack's non-Marketplace rate limits on `conversations.history`
and `conversations.replies` for new installs
([changelog](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/)).
Nango's own Slack proxy was also considered for person access and rejected for
that separate feature: it defaults to the bot token, and a person's own
reads must use that person's token explicitly
([docs](https://nango.dev/docs/api-integrations/slack/slack-user-access-tokens)).

## Decision and consequences

**The founder accepted option B on 2026-09-30.** Each organization gets its
own Nango environment, with its own environment secret key: an environment
key can read every connection in that environment, so no environment is
shared between organizations. Nango Cloud (or an enterprise self-host; the
Authority takes Nango's base URL as configuration) holds:

- the Slack bot token, fetched by the Authority at use time and cached in
  memory for at most five minutes; and
- a copy of the organization's Slack app client secret, because Nango needs it
  to run the OAuth install under the per-connection client override
  (`oauth_client_secret_override`).

The Authority keeps, in its own private secret store:

- the app's client ID and client secret, for connect sessions and the
  person-link sign-in;
- the signing secret, to verify inbound Slack interactions; and
- the Nango connection ID.

This is a narrower exception to "the Authority owns ... provider credentials"
in [identity and onboarding](../architecture/identity-and-onboarding.md),
which now links here instead of repeating it. ECHO still decides who an ECHO
person is: Nango never sees a person identity, and interactivity and the
person-link sign-in stay Authority-owned, verified with the Authority's own
copy of the signing secret and client credentials.

Consequences:

- **Third-party custody.** The Slack bot token leaves ECHO's own custody
  boundary for the first time. A Nango compromise can act as the
  organization's bot; it cannot read the Authority's signing secret, client
  secret or database, and it cannot mint a Person session or an approval.
- **Nango outage.** The browser person sign-in needs only the app's client
  credentials from the Authority's own bundle, so it keeps working. The
  DM-code person link needs the bot token, so it works only while the
  in-memory cache (at most five minutes) still holds one. Approval-card
  delivery past that window retries quietly (`retry_allowed`) until Nango
  answers again; it shows no error. "Slack setup is unavailable right now"
  belongs only to the owner's setup and install calls, since a new install or
  reconnect cannot start.
- **Reconnect preserves cards.** A reconnect or app update reuses the same
  Nango connection ID through a Nango reconnect session. The credential
  bundle, the connection state hash and every outstanding approval card are
  unchanged, which is the property revision 2 broke: replacing a connection
  made the Authority fail to restart for an organization with decided
  approval cards. Replacing the connection with a different app or workspace
  is refused in v1 for the same reason; there is no replacement path yet.
- **Fresh lineage on staging.** Because credential custody changed shape, a
  pre-Nango staging host cannot reuse its connection in place: it runs
  `replace-rehearsal` and a full onboarding-input transfer, the same as any
  other fresh rehearsal.

## Migration, rollback, and evidence

There is no legacy coexistence. A Nango-kind connection is the only kind; the
prior bot-token-and-channel path, its local token file and its signing-secret
file are removed in the same change, and the stopped-state Slack setup CLI it
depended on is retired. A pre-Nango organization re-onboards by running
`replace-rehearsal` and transferring the full onboarding input directory,
including the new `nango-secret-key` file described in the
[deployment README](../../deploy/organization-authority/README.md); there is
no in-place upgrade of an existing connection record, and old rehearsal
receipts staged before this change are refused rather than reused.

Evidence:
`services/organization-authority/test/slack-nango-proof-path.test.ts` runs the
founder's path through the production composition: an Authority restart after
a reconnect still takes a waiting card's click, a different workspace or bot
is refused, and no setup token, client secret, signing secret, bot token or
Nango key reaches SQLite.
`services/organization-authority/test/organization-authority-private-approval-runtime.test.ts`
and `tests/architecture/organization-authority-command-rehearsal.test.ts` prove
the Authority only ever reads the Slack bot token from Nango.
