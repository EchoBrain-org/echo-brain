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
import { canonicalSha256 } from "@echo-brain/federation-protocol";
import type { SlackIdentityProviderV1 } from "@echo-brain/provider-slack-server/organization-control-plane/adapters/slack/slack-web-identity-provider-v1";
import type { NangoConnectionClientV1, NangoSlackConnectionV1 } from "@echo-brain/provider-slack-server/organization-control-plane/adapters/nango/nango-connection-client-v1";
import { SLACK_PRIVATE_APP_BOT_SCOPES_V1, type SlackAppManifestProviderV1 } from "@echo-brain/provider-slack-server/organization-control-plane/adapters/slack/slack-app-manifest-provider-v1";
import { afterEach, describe, expect, it } from "vitest";
import type { BegunPersonOidcLogin } from "../../services/organization-authority/src/application/person-identity-sessions.js";
import { readPrivateAuthorityPersonSessionPkceKey } from "@echo-brain/organization-authority-kernel/adapters/security/private-file-credentials";
import {
  runOrganizationAuthoritySetupCli,
  type OrganizationAuthoritySetupCliDependencies,
} from "../../services/organization-authority/src/composition/organization-authority-setup-cli.js";
import { runGranolaMeetingSourceAdmissionCli } from "@echo-brain/organization-authority/composition/admit-granola-meeting-source-cli-v1";
import {
  initializePersonSessionCredentials,
  issuePersonOnboardingInvitation,
} from "../../services/organization-authority/src/composition/person-onboarding-service.js";
import type { PersonSessionOidcAuthorizationProvider } from "../../services/organization-authority/src/composition/lazy-person-session-oidc-provider.js";
import { openOrganizationAuthorityService, type OrganizationAuthorityServiceConfig } from "../../services/organization-authority/src/composition/organization-authority-composition-root.js";
import { bootstrapOrganizationAuthorityState } from "../../services/organization-authority/src/composition/organization-authority-state-bootstrap.js";
import type { OrganizationAuthorityProcessingCycleV1 } from "../../services/organization-authority/src/composition/organization-authority-service-lifecycle.js";
import { runPersonClientCli } from "../../src/product/person-client/composition.js";

const roots: string[] = [];
const AUTHORITY_URL = "https://authority.example";
const OIDC = {
  issuer: "https://issuer.example",
  client_id: "person-client",
  redirect_uri: `${AUTHORITY_URL}/v2/session/oidc/callback`,
  tenant: { kind: "issuer" as const },
  id_token_algorithms: ["RS256"],
};

function directory(): string {
  const created = mkdtempSync(join(tmpdir(), "echo-authority-command-rehearsal-"));
  chmodSync(created, 0o700);
  const value = realpathSync(created);
  roots.push(value);
  return value;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("test port did not resolve");
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  return address.port;
}

function commandOutput(): {
  readonly values: string[];
  readonly write: (value: string) => void;
} {
  const values: string[] = [];
  return { values, write: (value) => values.push(value) };
}

function oneJson<T>(captured: { readonly values: readonly string[] }): T {
  expect(captured.values).toHaveLength(1);
  return JSON.parse(captured.values[0]!) as T;
}

class MockOidcProvider implements PersonSessionOidcAuthorizationProvider {
  private last: BegunPersonOidcLogin | undefined;

  buildAuthorizationUrl(input: BegunPersonOidcLogin): string {
    this.last = input;
    return `https://issuer.example/authorize?state=${encodeURIComponent(input.state)}`;
  }

  async redeemAuthorizationCode(): Promise<{
    kind: "verified";
    token: {
      issuer: string;
      subject: string;
      audience: string;
      nonce: string;
      issued_at: number;
      claims: Readonly<Record<string, unknown>>;
    };
  }> {
    if (this.last === undefined) throw new Error("OIDC begin was not called");
    return {
      kind: "verified",
      token: {
        issuer: OIDC.issuer,
        subject: "initial-owner-subject",
        audience: OIDC.client_id,
        nonce: this.last.nonce,
        issued_at: Math.floor(Date.now() / 1000),
        claims: { email: "owner@example.com", email_verified: true },
      },
    };
  }
}

const CONFIGURATION_TOKEN = "xoxe.xoxp-1-rehearsal-configuration-token";
const CLIENT_SECRET = "rehearsal-client-secret-never-stored-in-sqlite";
const SIGNING_SECRET = "rehearsal-signing-secret-never-stored-in-sqlite";
const BOT_TOKEN = "xoxb-rehearsal-bot-token-only-in-nango";
const SLACK_NANGO = { secret_key: "rehearsal-nango-secret-key-000000000", integration_key: "slack" };
const CONNECT_LINK = "https://connect.nango.dev/?session_token=rehearsal";
const SECRETS = [CONFIGURATION_TOKEN, CLIENT_SECRET, SIGNING_SECRET, BOT_TOKEN, SLACK_NANGO.secret_key];

/** Slack, seen only with the bot token Nango holds. */
const fakeSlack: SlackIdentityProviderV1 = {
  openIdentityLinkDirectMessage: async (token) => {
    expect(token).toBe(BOT_TOKEN);
    return { team_id: "T12345678", channel_id: "D12345678", recipient_user_id: "U12345679" };
  },
  verifyConnection: async (token) => {
    expect(token).toBe(BOT_TOKEN);
    return { team_id: "T12345678", enterprise_id: null, bot_user_id: "U12345678", bot_id: "B12345678", app_id: "A12345678",
      granted_scopes: [...SLACK_PRIVATE_APP_BOT_SCOPES_V1], verification_evidence_sha256: canonicalSha256("rehearsal-slack-connection") };
  },
  verifyHuman: async () => {
    throw new Error("Person Slack identity linking observes a thread instead");
  },
  postIdentityLinkChallenge: async (_token, input) => ({
    team_id: "T12345678",
    channel_id: input.channel_id,
    challenge_message_ts: "100.000001",
  }),
  observeIdentityLinkChallenge: async (_token, input) => ({
    team_id: "T12345678",
    user_id: "U12345679",
    channel_id: input.channel_id,
    challenge_message_ts: input.challenge_message_ts,
    reply_message_ts: "100.000002",
    verification_evidence_sha256: canonicalSha256("rehearsal-slack-observation"),
  }),
};

const fakeManifest: SlackAppManifestProviderV1 = {
  createApp: async (input) => {
    expect(input.configuration_token).toBe(CONFIGURATION_TOKEN);
    return { app_id: "A12345678", client_id: "1234.5678", client_secret: CLIENT_SECRET, signing_secret: SIGNING_SECRET };
  },
  updateApp: async () => {
    throw new Error("the rehearsal creates the app once");
  },
};

/** Nango; `finishConnect` is the owner completing the Connect flow ECHO opened. */
function fakeNango() {
  const connections = new Map<string, NangoSlackConnectionV1>();
  let tags: Readonly<Record<string, string>> | undefined;
  const client: NangoConnectionClientV1 = {
    createConnectSession: async (input) => {
      tags = input.tags;
      return { connect_link: CONNECT_LINK, expires_at: "2099-01-01T00:00:00.000Z" };
    },
    createReconnectSession: async () => {
      throw new Error("the rehearsal installs once");
    },
    findConnectionIdByTag: async ({ key, value }) =>
      [...connections.values()].find((connection) => connection.tags[key] === value)?.connection_id,
    getSlackConnection: async ({ connection_id }) => connections.get(connection_id)!,
    deleteConnection: async () => undefined,
  };
  const finishConnect = () => connections.set("nango-rehearsal", {
    connection_id: "nango-rehearsal", tags: tags!, team_id: "T12345678", enterprise_id: null, is_enterprise_install: false,
    app_id: "A12345678", bot_user_id: "U12345678", granted_scopes: SLACK_PRIVATE_APP_BOT_SCOPES_V1, bot_token: BOT_TOKEN,
    updated_at: "2026-08-22T12:00:00.000Z",
  });
  return { client, finishConnect };
}

const inactiveWorker: OrganizationAuthorityProcessingCycleV1 = {
  recoverV4Appends: async () => undefined,
  pollAndStageAdmittedMeetings: async () => undefined,
  observeAndFinalizePendingApprovals: async () => undefined,
  appendFinalizedApprovalsToV4: async () => undefined,
  reconcileReadableSearchGeneration: async () => undefined,
};

function setupDependencies(): OrganizationAuthoritySetupCliDependencies {
  return {
    now: () => "2026-08-22T12:00:00.000Z",
    initialize_state: bootstrapOrganizationAuthorityState,
    initialize_credentials: async (stateDirectory) => {
      initializePersonSessionCredentials({ state_directory: stateDirectory });
    },
    issue_invitation: async (input) => {
      issuePersonOnboardingInvitation({
        state_directory: input.state_directory,
        oidc: OIDC,
        pkce_sealing_key: readPrivateAuthorityPersonSessionPkceKey(
          `file:${input.pkce_key_file}`,
        ),
        membership_id: input.membership_id,
        expected_email: input.expected_email,
        authority_url: input.authority_url,
        output_path: input.output_path,
      });
    },
    admit_source: async (input) => {
      const output = commandOutput();
      const status = await runGranolaMeetingSourceAdmissionCli(
        [
          "--state-dir",
          input.state_directory,
          "--source-instance",
          "initial-owner-granola-v1",
          "--processor-instance",
          "initial-owner-llm-v1",
          "--granola-credential-file",
          input.granola_credential_file,
          "--granola-owner-email-file",
          input.granola_owner_email_file,
          "--llm-credential-file",
          input.llm_credential_file,
        ],
        { stdout: output.write, stderr: () => undefined },
        {
          createGranolaRecordOwnerClient: () => ({
            async listNotes() {
              return {
                notes: [
                  {
                    id: "initial-owner-preflight-note",
                    owner: { email: "owner@example.com" },
                  },
                ],
                hasMore: false,
                cursor: null,
              };
            },
          }),
        },
      );
      expect(status).toBe(0);
      oneJson(output);
    },
    admit_staging_synthetic_source: async () => {
      throw new Error("the ordinary onboarding rehearsal must retain its Granola source");
    },
  };
}

function privateCredential(path: string, value: string): void {
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function setupStatus(stateDirectory: string): Promise<Record<string, unknown>> {
  const output = commandOutput();
  expect(await runOrganizationAuthoritySetupCli(["status", "--state-dir", stateDirectory],
    { stdout: output.write, stderr: output.write })).toBe(0);
  return oneJson(output);
}

describe("Organization Authority command rehearsal", () => {
  it("runs bootstrap, owner login, Slack set up in the app, the owner's Slack link, stopped finalize, then active restart", async () => {
    const root = directory();
    const stateDirectory = join(root, "state");
    const oidcConfigPath = join(root, "oidc.json");
    writeFileSync(
      oidcConfigPath,
      JSON.stringify({ ...OIDC, client_authentication: "none" }),
      { mode: 0o600 },
    );
    chmodSync(oidcConfigPath, 0o600);

    const bootstrap = commandOutput();
    await expect(
      runOrganizationAuthoritySetupCli(
        [
          "bootstrap",
          "--state-dir",
          stateDirectory,
          "--organization-name",
          "Example Organization",
          "--owner-display-name",
          "Initial Owner",
          "--owner-email",
          "owner@example.com",
          "--authority-url",
          AUTHORITY_URL,
          "--oidc-config",
          oidcConfigPath,
          "--artifact-revision",
          "organization-authority-command-rehearsal",
        ],
        { stdout: bootstrap.write, stderr: bootstrap.write },
        setupDependencies(),
      ),
    ).resolves.toBe(0);
    const bootstrapped = oneJson<{ invitation_path: string }>(bootstrap);

    const nango = fakeNango();
    const config: OrganizationAuthorityServiceConfig = {
      state_directory: stateDirectory,
      host: "127.0.0.1",
      port: await availablePort(),
      authority_url: AUTHORITY_URL,
      oidc: OIDC,
      client_authentication: { method: "none" },
      pkce_key_file: join(stateDirectory, "credentials", "person-session-pkce-sealing-key"),
      slack_nango: SLACK_NANGO,
      granola_credential_file: join(stateDirectory, "credentials", "granola-credential"),
      granola_owner_email_file: join(stateDirectory, "credentials", "granola-owner-email"),
      openrouter_credential_file: join(stateDirectory, "credentials", "llm-credential"),
    };
    const slack = { nango: nango.client, manifest_provider: fakeManifest, provider: fakeSlack };
    const idle = await openOrganizationAuthorityService(config, { slack, api: { oidc_provider: new MockOidcProvider() } });
    expect(idle.processing).toBe("idle_until_finalize");
    try {
      const loopback = `http://127.0.0.1:${String(idle.address.port)}`;
      const rewriteFetch: typeof fetch = async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        expect(url.origin).toBe(AUTHORITY_URL);
        const response = await fetch(`${loopback}${url.pathname}${url.search}`, {
          method: request.method,
          headers: request.headers,
          body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
          duplex: request.body === null ? undefined : "half",
        } as RequestInit);
        if (url.pathname === "/v2/session/oidc/begin") {
          const begun = (await response.clone().json()) as { authorization_url: string };
          const state = new URL(begun.authorization_url).searchParams.get("state");
          expect(state).not.toBeNull();
          const callback = await fetch(
            `${loopback}/v2/session/oidc/callback?state=${encodeURIComponent(state!)}&code=code-1&iss=${encodeURIComponent(OIDC.issuer)}`,
          );
          expect(callback.status).toBe(200);
          expect(callback.headers.get("content-type")).toContain("text/html");
          const page = await callback.text();
          const action = /<form id="handoff" method="post" action="([^"]+)">/.exec(page)?.[1];
          const token = /name="token" value="([A-Za-z0-9_-]+)"/.exec(page)?.[1];
          const session = /name="session" value="([A-Za-z0-9_-]+)"/.exec(page)?.[1];
          expect(action).toBeDefined();
          expect(token).toBeDefined();
          expect(session).toBeDefined();
          const delivered = await fetch(action!, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token: token!, session: session! }),
          });
          expect(delivered.status).toBe(200);
        }
        return response;
      };
      const homeDirectory = join(root, "home");
      const login = commandOutput();
      await expect(
        runPersonClientCli(["login", "--invitation", bootstrapped.invitation_path], {
          stdout: { write: login.write },
          stderr: { write: login.write },
          home_directory: homeDirectory,
          fetch: rewriteFetch,
        }),
      ).resolves.toBe(0);
      expect(login.values.join("")).toContain('"phase":"installed"');
      expect(await setupStatus(stateDirectory)).toMatchObject({ slack_connected: false, next_step: "connect_slack_in_app" });

      // The owner sets up Slack: the CLI, the Authority's owner routes, Slack's manifest API and Nango.
      const setup = commandOutput();
      await expect(
        runPersonClientCli(["tools", "setup", "--tool", "slack"], {
          stdout: { write: setup.write },
          stderr: { write: setup.write },
          home_directory: homeDirectory,
          fetch: rewriteFetch,
          read_input: () => `${CONFIGURATION_TOKEN}\n`,
          // The owner finishes the Connect page ECHO opened.
          open_authorization_url: (url) => { expect(url).toBe(CONNECT_LINK); nango.finishConnect(); return true; },
          sleep: async () => undefined,
        }),
      ).resolves.toBe(0);
      expect(setup.values.join("")).toContain('"phase":"connected"');
      expect(setup.values.join("")).toContain('"kind":"created","workspace_id":"T12345678"');
      expect(setup.values.join("")).not.toContain(CONFIGURATION_TOKEN);
      expect(await setupStatus(stateDirectory)).toMatchObject({ slack_connected: true, next_step: "complete_founder_slack_link" });

      const linked = commandOutput();
      await expect(
        runPersonClientCli(["tools", "connect", "--tool", "slack", "--method", "dm-code", "--slack-user", "U12345679"], {
          stdout: { write: linked.write },
          stderr: { write: linked.write },
          home_directory: homeDirectory,
          fetch: rewriteFetch,
          read_input: () => "\n",
        }),
      ).resolves.toBe(0);
      expect(linked.values.join("")).toContain('"phase":"linked"');
      expect(await setupStatus(stateDirectory)).toMatchObject({ founder_slack_link_active: true, next_step: "install_provider_credentials" });
    } finally {
      await idle.close();
    }

    privateCredential(
      join(stateDirectory, "credentials", "granola-credential"),
      `grn_${"a".repeat(32)}`,
    );
    privateCredential(
      join(stateDirectory, "credentials", "granola-owner-email"),
      "owner@example.com",
    );
    privateCredential(
      join(stateDirectory, "credentials", "llm-credential"),
      "x".repeat(32),
    );
    const finalized = commandOutput();
    const finalizeStatus = await runOrganizationAuthoritySetupCli(
      ["finalize", "--state-dir", stateDirectory],
      { stdout: finalized.write, stderr: finalized.write },
      setupDependencies(),
    );
    expect(finalizeStatus, finalized.values.join("")).toBe(0);
    expect(oneJson<{ ok: boolean }>(finalized).ok).toBe(true);

    // The restart loads the approval lane on the in-app connection and its credential bundle.
    const active = await openOrganizationAuthorityService(
      { ...config, port: await availablePort() },
      { slack, active_processing: inactiveWorker },
    );
    try {
      expect(active.processing).toBe("active");
      expect(
        await fetch(
          `http://127.0.0.1:${String(active.address.port)}/v1/authority-descriptor`,
        ),
      ).toMatchObject({ status: 200 });
    } finally {
      await active.close();
    }
    for (const name of readdirSync(stateDirectory).filter((file) => file.includes(".sqlite"))) {
      const bytes = readFileSync(join(stateDirectory, name)).toString("latin1");
      for (const secret of SECRETS) expect(bytes, name).not.toContain(secret);
    }
  });
});
