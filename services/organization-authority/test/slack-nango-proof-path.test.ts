import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  ORGANIZATION_API_SLACK_INSTALL_BEGIN_PATH_V1,
  ORGANIZATION_API_SLACK_INSTALL_STATUS_PATH_V1,
  ORGANIZATION_API_SLACK_SETUP_PATH_V1,
} from "@echo-brain/provider-slack-client/organization-api/organization-slack-setup-v1";
import {
  ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_CHALLENGES_PATH,
  ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_COMPLETIONS_PATH,
  organizationPersonSlackIdentityLinkChallengeCodeSha256,
} from "@echo-brain/provider-slack-client/organization-api/person-slack-identity-link";
import { SLACK_PRIVATE_APP_BOT_SCOPES_V1 } from "@echo-brain/provider-slack-server/organization-control-plane/application/slack-integration-contracts";
import { openOrganizationControlDatabase } from "@echo-brain/provider-slack-server/organization-control-plane/slack-approval-integration-v1";
import { slackApprovalActionIdV4 } from "@echo-brain/provider-slack-server/private-approval/slack-approval-card-v4";
import {
  parseVerifiedPrivateSlackApprovalInteractionV1,
  PrivateSlackApprovalInteractionError,
  verifyPrivateSlackApprovalRequestV1,
} from "@echo-brain/provider-slack-server/private-approval/private-slack-approval-interaction-protocol-v1";
import { readPrivateAuthorityPersonSessionPkceKey } from "@echo-brain/organization-authority-kernel/adapters/security/private-file-credentials";

import type { BegunPersonOidcLogin } from "../src/application/person-identity-sessions.js";
import type { PersonSessionOidcAuthorizationProvider } from "../src/composition/lazy-person-session-oidc-provider.js";
import {
  openOrganizationAuthorityService,
  type OrganizationAuthorityServiceConfig,
} from "../src/composition/organization-authority-composition-root.js";
import { bootstrapOrganizationAuthorityState } from "../src/composition/organization-authority-state-bootstrap.js";
import {
  initializePersonSessionCredentials,
  issuePersonOnboardingInvitation,
} from "../src/composition/person-onboarding-service.js";

/**
 * Spec 2026-09-30-tool-onboarding-slack-v1 §9: the founder's path through the
 * production composition. Only `fetch` is replaced: Slack and Nango are fakes,
 * the Authority's own routes are real loopback HTTP.
 */
const NOW = "2026-08-22T12:00:00.000Z";
const AUTHORITY_URL = "https://authority.example";
const NANGO_URL = "https://nango.proof.example";
const OIDC = {
  issuer: "https://issuer.example",
  client_id: "founder-client",
  redirect_uri: `${AUTHORITY_URL}/v2/session/oidc/callback`,
  tenant: { kind: "issuer" as const },
  id_token_algorithms: ["RS256"],
};
const OWNER_EMAIL = "founder@example.com";
const EMPLOYEE_EMAIL = "jane@example.com";
const CONFIGURATION_TOKEN = "xoxe.xoxp-1-proof-configuration-token";
const NANGO_KEY = "proof-nango-secret-key-000000000000";
const APP = {
  app_id: "A0PROOF",
  client_id: "1111.2222",
  client_secret: "proof-client-secret-0000",
  signing_secret: "proof-signing-secret-0000",
};
type Bot = {
  readonly team_id: string;
  readonly app_id: string;
  readonly bot_id: string;
  readonly bot_user_id: string;
};
const ECHO_BOT: Bot = {
  team_id: "T0PROOF",
  app_id: APP.app_id,
  bot_id: "B0PROOF",
  bot_user_id: "U0PROOFBOT",
};
const OWNER_SLACK = "U0OWNER";
const EMPLOYEE_SLACK = "U0EMPLOYEE";
const TOKENS = {
  first: "xoxb-proof-first-0001",
  rotated: "xoxb-proof-rotated-0002",
  other: "xoxb-proof-other-0003",
  reinstalled: "xoxb-proof-reinstalled-0004",
  recovered: "xoxb-proof-recovered-0005",
  rebound: "xoxb-proof-rebound-0006",
};
const SCOPES = SLACK_PRIVATE_APP_BOT_SCOPES_V1.join(",");

type Message = {
  type: "message";
  channel: string;
  ts: string;
  text: string;
  blocks: Record<string, any>[];
  user: string;
  thread_ts?: string;
  bot_id?: string;
  app_id?: string;
};

/** Slack's Web API: tokens are only valid while Slack holds them for an installed bot. */
function fakeSlack() {
  const tokens = new Map<string, Bot>();
  const messages: Message[] = [];
  const calls: { method: string; token: string }[] = [];
  let sequence = 0;
  const ts = () => `1727700000.${String(++sequence).padStart(6, "0")}`;
  const reply = (body: Record<string, unknown>) =>
    Response.json(body, { headers: { "x-oauth-scopes": SCOPES } });
  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = url.pathname.slice("/api/".length);
    const token =
      request.headers.get("authorization")?.slice("Bearer ".length) ?? "";
    calls.push({ method, token });
    const p: Record<string, any> =
      request.method === "GET"
        ? Object.fromEntries(url.searchParams)
        : request.headers.get("content-type")?.startsWith("application/json")
          ? await request.json()
          : Object.fromEntries(new URLSearchParams(await request.text()));
    if (method === "apps.manifest.create") {
      expect(token).toBe(CONFIGURATION_TOKEN);
      expect(JSON.parse(p.manifest).oauth_config).toMatchObject({
        redirect_urls: [`${NANGO_URL}/oauth/callback`, expect.any(String)],
        scopes: {
          bot: SLACK_PRIVATE_APP_BOT_SCOPES_V1,
          user: ["openid", "profile"],
        },
      });
      const { app_id, ...credentials } = APP;
      return reply({
        ok: true,
        app_id,
        credentials: { ...credentials, verification_token: "unused" },
      });
    }
    const bot = tokens.get(token);
    if (bot === undefined) return reply({ ok: false, error: "invalid_auth" });
    switch (method) {
      case "auth.test":
        return reply({
          ok: true,
          team_id: bot.team_id,
          user_id: bot.bot_user_id,
          bot_id: bot.bot_id,
          app_id: bot.app_id,
        });
      case "bots.info":
        return reply({
          ok: true,
          bot: {
            id: bot.bot_id,
            user_id: bot.bot_user_id,
            app_id: bot.app_id,
            deleted: false,
          },
        });
      case "users.info":
        return reply({
          ok: true,
          user: {
            id: p.user,
            team_id: bot.team_id,
            deleted: false,
            is_bot: false,
            is_app_user: false,
          },
        });
      case "conversations.open":
        return reply({
          ok: true,
          channel: {
            id: `D${String(p.users).slice(1)}`,
            is_im: true,
            user: p.users,
          },
        });
      case "chat.postMessage": {
        const message: Message = {
          type: "message",
          channel: p.channel,
          ts: ts(),
          text: p.text,
          user: bot.bot_user_id,
          bot_id: bot.bot_id,
          app_id: bot.app_id,
          blocks:
            typeof p.blocks === "string"
              ? JSON.parse(p.blocks)
              : (p.blocks ?? []),
        };
        messages.push(message);
        return reply({
          ok: true,
          channel: message.channel,
          ts: message.ts,
          message: { ...message, channel: undefined },
        });
      }
      case "chat.update": {
        Object.assign(
          messages.find(
            (message) => message.channel === p.channel && message.ts === p.ts,
          )!,
          { text: p.text, blocks: p.blocks ?? [] },
        );
        return reply({ ok: true, channel: p.channel, ts: p.ts, text: p.text });
      }
      case "conversations.replies":
        return reply({
          ok: true,
          has_more: false,
          messages: messages
            .filter(
              (message) =>
                message.channel === p.channel &&
                (message.ts === p.ts || message.thread_ts === p.ts),
            )
            .map((message) => ({ ...message, channel: undefined })),
        });
      default:
        throw new Error(`fake Slack has no ${method}`);
    }
  }
  return {
    tokens,
    calls,
    handle,
    /** A person answers in the bot's DM thread. */
    reply: (channel: string, thread_ts: string, user: string, text: string) =>
      messages.push({
        type: "message",
        channel,
        ts: ts(),
        thread_ts,
        user,
        text,
        blocks: [],
      }),
  };
}

/** Nango Cloud, with the assumed connection shape: `credentials.raw` is Slack's oauth.v2.access response. */
function fakeNango(slack: ReturnType<typeof fakeSlack>) {
  const sessions: {
    tags: Record<string, string>;
    reconnect_connection_id: string | null;
  }[] = [];
  let connection:
    | {
        connection_id: string;
        tags: Record<string, string>;
        updated_at: string;
        credentials: Record<string, unknown>;
      }
    | undefined;
  let revision = 0;
  let created = 0;
  async function handle(request: Request): Promise<Response> {
    expect(request.headers.get("authorization")).toBe(`Bearer ${NANGO_KEY}`);
    const url = new URL(request.url);
    if (request.method === "POST") {
      const body = (await request.json()) as {
        tags: Record<string, string>;
        connection_id?: string;
        integrations_config_defaults: unknown;
      };
      // Each organization's private app keeps its own OAuth client and the four scopes.
      expect(body.integrations_config_defaults).toEqual({
        slack: {
          authorization_params: { client_id: APP.client_id },
          connection_config: {
            oauth_client_id_override: APP.client_id,
            oauth_client_secret_override: APP.client_secret,
            oauth_scopes_override: SCOPES,
          },
        },
      });
      sessions.push({
        tags: body.tags,
        reconnect_connection_id:
          url.pathname === "/connect/sessions/reconnect"
            ? body.connection_id!
            : null,
      });
      return Response.json({
        data: {
          token: "nango-session-token",
          connect_link: `${NANGO_URL}/connect/${sessions.length}`,
          expires_at: "2099-01-01T00:00:00.000Z",
        },
      });
    }
    if (url.pathname === "/connections") {
      const [, key, value] = /^tags\[([^\]]+)\]=(.+)$/.exec(
        decodeURIComponent(url.search.slice(1)),
      )!;
      return Response.json({
        connections:
          connection?.tags[key!] === value
            ? [{ connection_id: connection!.connection_id }]
            : [],
      });
    }
    expect(url.searchParams.get("provider_config_key")).toBe("slack");
    // Spike-sensitive: Nango answers 404 for a connection id it does not have.
    if (url.pathname !== `/connections/${connection?.connection_id}`)
      return new Response(null, { status: 404 });
    return Response.json({
      ...connection,
      provider_config_key: "slack",
      provider: "slack",
    });
  }
  /** The owner approves Slack's install page for the latest session; Slack issues `token`, revoking any earlier one. */
  function finishConnect(bot: Bot, token: string) {
    const session = sessions.at(-1)!;
    if (session.reconnect_connection_id !== null)
      expect(session.reconnect_connection_id).toBe(connection!.connection_id);
    for (const [held, holder] of slack.tokens)
      if (holder.team_id === bot.team_id) slack.tokens.delete(held);
    slack.tokens.set(token, bot);
    // A reconnect session keeps its connection; a connect session creates another.
    const connection_id =
      session.reconnect_connection_id ??
      `nango-proof-connection${++created === 1 ? "" : `-${created}`}`;
    connection = {
      connection_id,
      tags: session.tags,
      updated_at: new Date(Date.parse(NOW) + ++revision * 60_000).toISOString(),
      credentials: {
        type: "OAUTH2",
        access_token: token,
        raw: {
          ok: true,
          app_id: bot.app_id,
          authed_user: { id: OWNER_SLACK },
          scope: SCOPES,
          token_type: "bot",
          access_token: token,
          bot_user_id: bot.bot_user_id,
          team: { id: bot.team_id, name: "Proof" },
          enterprise: null,
          is_enterprise_install: false,
        },
      },
    };
  }
  /** Nango no longer has the connection (deleted from its dashboard, say) and its token is revoked. */
  function lose() {
    slack.tokens.delete(
      (connection!.credentials as { access_token: string }).access_token,
    );
    connection = undefined;
  }
  return { handle, finishConnect, lose, sessions };
}

class TestOidcProvider implements PersonSessionOidcAuthorizationProvider {
  email = OWNER_EMAIL;
  private nonce = "";
  buildAuthorizationUrl(attempt: BegunPersonOidcLogin): string {
    this.nonce = attempt.nonce;
    return `https://issuer.example/authorize?state=${encodeURIComponent(attempt.state)}`;
  }
  async redeemAuthorizationCode() {
    return {
      kind: "verified" as const,
      token: {
        issuer: OIDC.issuer,
        subject: `subject-${this.email}`,
        audience: OIDC.client_id,
        nonce: this.nonce,
        issued_at: Math.floor(Date.now() / 1_000),
        claims: { email: this.email, email_verified: true },
      },
    };
  }
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function privateFile(path: string, value: string): string {
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it("sets up, connects, links, reconnects and restarts Slack through Nango, refuses a different workspace or bot, and recovers a lost connection", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "echo-slack-nango-proof-")),
  );
  chmodSync(root, 0o700);
  roots.push(root);
  const slack = fakeSlack();
  const nango = fakeNango(slack);
  const feedback: unknown[] = [];
  let feedback_status = 200;
  const loopback = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const { origin } = new URL(request.url);
      if (origin === "https://slack.com") return slack.handle(request);
      if (origin === NANGO_URL) return nango.handle(request);
      if (origin === "https://hooks.slack.com") {
        expect(request.redirect).toBe("error");
        feedback.push(await request.json());
        return Response.json(
          { ok: feedback_status === 200 },
          { status: feedback_status },
        );
      }
      expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:/);
      return loopback(input, init);
    },
  );

  // 1. A fresh Authority starts with Nango configured; nothing is admitted yet.
  const initialized = bootstrapOrganizationAuthorityState({
    state_directory: join(root, "state"),
    organization_display_name: "Proof Organization",
    owner_display_name: "Founder",
    created_at: "2026-08-22T11:00:00.000Z",
    creating_artifact_revision: "slack-nango-proof-path",
  });
  const state = initialized.state_directory;
  const credentials = initializePersonSessionCredentials({
    state_directory: state,
  });
  const invitation = join(root, "founder.invitation.json");
  issuePersonOnboardingInvitation({
    state_directory: state,
    oidc: OIDC,
    pkce_sealing_key: readPrivateAuthorityPersonSessionPkceKey(
      credentials.pkce_sealing_key_reference,
    ),
    membership_id: initialized.owner_membership_id,
    expected_email: OWNER_EMAIL,
    authority_url: AUTHORITY_URL,
    output_path: invitation,
  });
  const errors: Error[] = [];
  const config: OrganizationAuthorityServiceConfig = {
    state_directory: state,
    host: "127.0.0.1",
    port: await availablePort(),
    authority_url: AUTHORITY_URL,
    oidc: OIDC,
    client_authentication: { method: "none" },
    pkce_key_file: credentials.pkce_sealing_key_reference.slice("file:".length),
    slack_nango: {
      base_url: NANGO_URL,
      secret_key: NANGO_KEY,
      integration_key: "slack",
    },
    openrouter_credential_file: privateFile(
      join(root, "llm.key"),
      "llm-private-credential-material-000000",
    ),
    worker_interval_ms: 10,
    on_worker_error: (error) => errors.push(error),
  };
  const oidcProvider = new TestOidcProvider();
  let runtime = await openOrganizationAuthorityService(config, {
    api: { oidc_provider: oidcProvider },
  });
  expect(runtime.processing).toBe("active");
  const origin = () => `http://127.0.0.1:${runtime.address.port}`;
  const call = async (path: string, token: string, body?: unknown) => {
    const response = await fetch(
      `${origin()}${path}`,
      body === undefined
        ? { headers: { authorization: `Bearer ${token}` } }
        : {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          },
    );
    return {
      status: response.status,
      body: (await response.json()) as Record<string, any>,
    };
  };
  const signIn = async (login_grant: string, email: string) => {
    oidcProvider.email = email;
    const begun = await fetch(`${origin()}/v2/session/oidc/begin`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-echo-client-ip": "192.0.2.1",
      },
      body: JSON.stringify({
        kind: "identity_bootstrap",
        login_grant,
        loopback_handoff: {
          url: `http://127.0.0.1:39999/${"P".repeat(43)}`,
          token: "T".repeat(43),
        },
      }),
    });
    const authorization = (
      (await begun.json()) as { authorization_url: string }
    ).authorization_url;
    const page = await (
      await fetch(
        `${origin()}/v2/session/oidc/callback?state=${encodeURIComponent(new URL(authorization).searchParams.get("state")!)}&code=code`,
      )
    ).text();
    const session = /name="session" value="([A-Za-z0-9_-]+)"/.exec(page)![1]!;
    return (
      JSON.parse(Buffer.from(session, "base64url").toString("utf8")) as {
        access_token: string;
      }
    ).access_token;
  };
  const slackTool = async (token: string) =>
    (await call("/v4/person/tools", token)).body.tools.find(
      (tool: { tool_id: string }) => tool.tool_id === "slack",
    );
  /** Begins native Nango OAuth, lets the owner consent as `bot`, and reads the outcome. */
  const install = async (bot: Bot, token: string) => {
    const begun = await call(
      ORGANIZATION_API_SLACK_INSTALL_BEGIN_PATH_V1,
      owner,
      { request_id: `osi_${randomUUID()}` },
    );
    expect(begun).toMatchObject({
      status: 201,
      body: {
        connect_link: `${NANGO_URL}/oauth/connect/slack?connect_session_token=nango-session-token`,
      },
    });
    for (const secret of [
      CONFIGURATION_TOKEN,
      NANGO_KEY,
      APP.client_secret,
      APP.signing_secret,
    ])
      expect(begun.body.connect_link).not.toContain(secret);
    nango.finishConnect(bot, token);
    return (
      await call(ORGANIZATION_API_SLACK_INSTALL_STATUS_PATH_V1, owner, {
        attempt_id: begun.body.attempt_id,
      })
    ).body;
  };
  /** The DM-code link: ECHO posts a challenge in the bot's DM, the person replies with the code shown by ECHO. */
  const linkSlack = async (token: string, slackUser: string) => {
    const code = randomBytes(32).toString("base64url");
    const begun = await call(
      ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_CHALLENGES_PATH,
      token,
      {
        request_id: `psb_${randomUUID()}`,
        recipient_user_id: slackUser,
        challenge_code_sha256:
          organizationPersonSlackIdentityLinkChallengeCodeSha256(code),
      },
    );
    expect(begun.status).toBe(201);
    slack.reply(
      begun.body.channel_id,
      begun.body.challenge_message_ts,
      slackUser,
      code,
    );
    await expect(
      call(
        ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_COMPLETIONS_PATH,
        token,
        {
          request_id: `psc_${randomUUID()}`,
          challenge_attempt_id: begun.body.challenge_attempt_id,
          challenge_message_ts: begun.body.challenge_message_ts,
          challenge_code: code,
        },
      ),
    ).resolves.toMatchObject({
      status: 200,
      body: {
        provider_subject_id: slackUser,
        provider_tenant_id: ECHO_BOT.team_id,
      },
    });
  };
  const control = openOrganizationControlDatabase(
    join(state, "integrations.sqlite"),
    { fileMustExist: true },
  );
  const connectionState = () =>
    control
      .prepare(
        "SELECT connection_id, state_sha256, state_json FROM organization_tool_connection_current_state",
      )
      .all();
  let owner = "";
  try {
    // 2. The owner signs in.
    owner = await signIn(
      (JSON.parse(readFileSync(invitation, "utf8")) as { login_grant: string })
        .login_grant,
      OWNER_EMAIL,
    );
    expect(await slackTool(owner)).toMatchObject({
      organization_setup: "not_set_up",
    });

    // 3-4. Setup creates the private app from the recipe; the install runs through Nango and
    // ECHO verifies the workspace and app with the Nango-held bot token.
    await expect(
      call(ORGANIZATION_API_SLACK_SETUP_PATH_V1, owner, {
        request_id: `oss_${randomUUID()}`,
        configuration_token: CONFIGURATION_TOKEN,
      }),
    ).resolves.toMatchObject({
      status: 201,
      body: { app_id: APP.app_id, organization_setup: "app_created" },
    });
    expect(await install(ECHO_BOT, TOKENS.first)).toMatchObject({
      status: "complete",
      result: { kind: "created", workspace_id: ECHO_BOT.team_id },
    });
    expect(nango.sessions[0]).toMatchObject({
      reconnect_connection_id: null,
      tags: { echo_organization_id: initialized.organization_id },
    });
    expect(
      slack.calls.filter(
        (entry) => entry.method === "auth.test" || entry.method === "bots.info",
      ),
    ).toEqual([
      { method: "auth.test", token: TOKENS.first },
      { method: "bots.info", token: TOKENS.first },
    ]);
    expect(await slackTool(owner)).toMatchObject({
      availability: "enabled",
      personal_status: "unlinked",
      organization_setup: "connected",
    });

    // 5. The owner and an invited employee link their Slack identities by DM code.
    const invited = await call("/v1/person/employees", owner, {
      name: "Jane Doe",
      email: EMPLOYEE_EMAIL,
    });
    expect(invited.status).toBe(201);
    const employee = await signIn(invited.body.login_grant, EMPLOYEE_EMAIL);
    await linkSlack(owner, OWNER_SLACK);
    await linkSlack(employee, EMPLOYEE_SLACK);
    expect(await slackTool(employee)).toMatchObject({
      personal_status: "linked",
      external_subject_id: EMPLOYEE_SLACK,
      organization_setup: null,
    });

    // 6. The owner reconnects: Nango keeps the connection, Slack rotates the bot token and
    // Nango bumps updated_at. The connection state hash does not change.
    const before = connectionState();
    expect(await install(ECHO_BOT, TOKENS.rotated)).toMatchObject({
      status: "complete",
      result: { kind: "reconnected", workspace_id: ECHO_BOT.team_id },
    });
    expect(nango.sessions[1]).toMatchObject({
      reconnect_connection_id: "nango-proof-connection",
    });
    expect(connectionState()).toEqual(before);

    // 7. A reconnect that lands in a different workspace is refused and ECHO writes nothing. Nango's
    // connection now holds that workspace, so the owner sees needs_reinstall at once.
    const secrets = readdirSync(join(state, "secrets")).sort();
    const refused = await install(
      {
        ...ECHO_BOT,
        team_id: "T0OTHER",
        bot_id: "B0OTHER",
        bot_user_id: "U0OTHERBOT",
      },
      TOKENS.other,
    );
    expect(refused).toMatchObject({
      status: "failed",
      failure_reason: "workspace_mismatch",
      result: null,
    });
    expect(connectionState()).toEqual(before);
    expect(readdirSync(join(state, "secrets")).sort()).toEqual(secrets);
    expect(await slackTool(owner)).toMatchObject({
      personal_status: "linked",
      organization_setup: "needs_reinstall",
    });
    expect(errors).toEqual([]);

    // 8. A reconnect that comes back with a different bot user is refused too; Slack revoked the old token.
    expect(
      await install(
        { ...ECHO_BOT, bot_user_id: "U0NEWBOT" },
        TOKENS.reinstalled,
      ),
    ).toMatchObject({ status: "failed", failure_reason: "workspace_mismatch" });
    expect(await slackTool(owner)).toMatchObject({
      organization_setup: "needs_reinstall",
    });
    expect(connectionState()).toEqual(before);

    // 9. The owner reconnects to the original workspace and bot: the state hash is unchanged.
    expect(await install(ECHO_BOT, TOKENS.recovered)).toMatchObject({
      status: "complete",
      result: { kind: "reconnected", workspace_id: ECHO_BOT.team_id },
    });
    expect(connectionState()).toEqual(before);
    expect(await slackTool(owner)).toMatchObject({
      organization_setup: "connected",
    });

    // 10. Nango loses the connection and its token is revoked. The owner's next Install finds the
    // connection gone and opens a connect session with its own attempt's tags. The new connection
    // proves the same app, workspace and bot, so the bundle is pointed at it under the same handle
    // and the state hash is unchanged.
    nango.lose();
    expect(await install(ECHO_BOT, TOKENS.rebound)).toMatchObject({
      status: "complete",
      result: { kind: "reconnected", workspace_id: ECHO_BOT.team_id },
    });
    expect(nango.sessions.at(-1)).toMatchObject({
      reconnect_connection_id: null,
      tags: { echo_organization_id: initialized.organization_id },
    });
    expect(connectionState()).toEqual(before);
    expect(readdirSync(join(state, "secrets")).sort()).toEqual(secrets);
    expect(await slackTool(owner)).toMatchObject({
      organization_setup: "connected",
    });

    // 11. Restart: the setup and both identity links survive with the unchanged connection.
    await runtime.close();
    runtime = await openOrganizationAuthorityService(
      { ...config, port: await availablePort() },
      { api: { oidc_provider: oidcProvider } },
    );
    expect(runtime.processing).toBe("active");
    expect(await slackTool(owner)).toMatchObject({
      personal_status: "linked",
      organization_setup: "connected",
    });
    expect(await slackTool(employee)).toMatchObject({
      personal_status: "linked",
      external_subject_id: EMPLOYEE_SLACK,
    });
    expect(connectionState()).toEqual(before);
    // The restarted production composition has an active connection, so it
    // mounts the Slack interaction route and resolves its signing credential
    // from the configured app reference. This is a real signed V4 request;
    // there is no presentation for it, so the target-bound click path safely
    // refuses it and sends only the provider-safe stale/refused feedback.
    const approval_id = "apr_00000000-0000-4000-8000-000000000001";
    const interaction_state = {
      audience: {
        [slackApprovalActionIdV4(approval_id, "audience-select")]: {
          type: "static_select",
          selected_option: {
            text: { type: "plain_text", text: "Only me", emoji: false },
            value: "only-me",
          },
        },
      },
      projects: {
        [slackApprovalActionIdV4(approval_id, "projects-select")]: {
          type: "multi_static_select",
          selected_options: [],
        },
      },
      transcript: {
        [slackApprovalActionIdV4(approval_id, "transcript-checkbox")]: {
          type: "checkboxes",
          selected_options: [],
        },
      },
    };
    const interaction = {
      type: "block_actions",
      user: {
        id: OWNER_SLACK,
        team_id: ECHO_BOT.team_id,
        username: "founder",
        name: "Founder",
      },
      api_app_id: APP.app_id,
      trigger_id: "1234567890.1234567890.abcdefghijklmnopqrstuvwxyzABCD",
      container: {
        type: "message",
        channel_id: `D${OWNER_SLACK.slice(1)}`,
        message_ts: "1727700000.000001",
        is_ephemeral: false,
      },
      team: { id: ECHO_BOT.team_id, domain: "proof" },
      channel: { id: `D${OWNER_SLACK.slice(1)}`, name: "directmessage" },
      message: {
        type: "message",
        user: ECHO_BOT.bot_user_id,
        username: "echo",
        text: "Review this meeting",
        ts: "1727700000.000001",
        app_id: APP.app_id,
        bot_id: ECHO_BOT.bot_id,
        bot_profile: { id: ECHO_BOT.bot_id, app_id: APP.app_id, name: "echo" },
        blocks: [],
      },
      state: { values: interaction_state },
      response_url: "https://hooks.slack.com/actions/T0PROOF/B0PROOF/proof",
      actions: [
        {
          type: "button",
          action_id: slackApprovalActionIdV4(approval_id, "approve"),
          block_id: "actions",
          text: { type: "plain_text", text: "Approve meeting", emoji: false },
          action_ts: "1727700001.000001",
          value: JSON.stringify({
            schema_version: 2,
            approval_id,
            snapshot_sha256: `sha256:${"a".repeat(64)}`,
          }),
        },
      ],
    };
    const raw_interaction = new TextEncoder().encode(
      new URLSearchParams({ payload: JSON.stringify(interaction) }).toString(),
    );
    const interaction_timestamp = String(Math.floor(Date.now() / 1_000));
    const interaction_signature = createHmac("sha256", APP.signing_secret)
      .update(`v0:${interaction_timestamp}:`)
      .update(raw_interaction)
      .digest("hex");
    try {
      parseVerifiedPrivateSlackApprovalInteractionV1(
        verifyPrivateSlackApprovalRequestV1({
          raw_body: raw_interaction,
          signing_secret: APP.signing_secret,
          headers: {
            "x-slack-request-timestamp": interaction_timestamp,
            "x-slack-signature": `v0=${interaction_signature}`,
          },
          now_unix_seconds: Number(interaction_timestamp),
        }),
      );
    } catch (error) {
      if (error instanceof PrivateSlackApprovalInteractionError)
        throw new Error(
          `interaction parser rejection: ${error.rejection_stage}`,
        );
      throw error;
    }
    const interaction_response = await fetch(
      `${origin()}/v2/integrations/slack/interactions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-request-timestamp": interaction_timestamp,
          "x-slack-signature": `v0=${interaction_signature}`,
        },
        body: raw_interaction,
      },
    );
    expect({
      status: interaction_response.status,
      body: await interaction_response.text(),
    }).toEqual({ status: 200, body: "" });
    expect(feedback).toEqual([
      {
        response_type: "ephemeral",
        replace_original: false,
        text: "This approval is no longer available. Open the ECHO desktop app to review it.",
      },
    ]);
    feedback_status = 500;
    const rejected_feedback_response = await fetch(
      `${origin()}/v2/integrations/slack/interactions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-request-timestamp": interaction_timestamp,
          "x-slack-signature": `v0=${interaction_signature}`,
        },
        body: raw_interaction,
      },
    );
    expect({
      status: rejected_feedback_response.status,
      body: await rejected_feedback_response.text(),
    }).toEqual({ status: 200, body: "" });
    expect(feedback).toHaveLength(2);
    expect(errors).toEqual([]);
    for (const name of readdirSync(state).filter((file) =>
      file.includes(".sqlite"),
    )) {
      const bytes = readFileSync(join(state, name)).toString("latin1");
      for (const secret of [
        CONFIGURATION_TOKEN,
        NANGO_KEY,
        APP.client_secret,
        APP.signing_secret,
        ...Object.values(TOKENS),
      ])
        expect(bytes, name).not.toContain(secret);
    }
  } finally {
    await runtime.close();
    control.close();
  }
});
