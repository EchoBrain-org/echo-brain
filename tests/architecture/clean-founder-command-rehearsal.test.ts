import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalSha256 } from "@echo-brain/federation-protocol";
import type { CleanSlackIdentityProviderV1 } from "@echo-brain/organization-control-plane/clean-slack-identity-v1";
import { runCleanSlackConnectCli } from "../../services/organization-control-plane/src/composition/clean-slack-connect-cli.js";
import { verifyCleanControlPlaneStateV1 } from "../../services/organization-control-plane/src/persistence/verified-clean-control-plane-state-v1.js";
import { afterEach, describe, expect, it } from "vitest";
import type { BegunPersonOidcLogin } from "../../services/organization-authority/src/application/person-identity-sessions.js";
import { readPrivateAuthorityPersonSessionPkceKey } from "../../services/organization-authority/src/adapters/security/private-file-credentials.js";
import {
  runCleanFounderCli,
  type CleanFounderCliDependencies,
} from "../../services/organization-authority/src/composition/clean-founder-cli.js";
import { runCleanGranolaSourceCli } from "../../services/organization-authority/src/composition/clean-granola-source-cli.js";
import {
  initializeCleanPersonCredentials,
  issueCleanPersonInvitation,
} from "../../services/organization-authority/src/composition/clean-person-onboarding.js";
import type { PersonSessionOidcAuthorizationProvider } from "../../services/organization-authority/src/composition/lazy-person-session-oidc-provider.js";
import { openCleanGranolaLiveRuntime } from "../../services/organization-authority/src/composition/open-clean-granola-live-runtime.js";
import { initializeCleanResetState } from "../../services/organization-authority/src/composition/clean-reset-state.js";
import type { CleanLiveProcessingCycleV1 } from "../../services/organization-authority/src/composition/clean-live-runtime.js";
import { runPersonClientCli } from "../../src/product/person-client/commands.js";

const roots: string[] = [];
const AUTHORITY_URL = "https://authority.example";
const OIDC = {
  issuer: "https://issuer.example",
  client_id: "founder-client",
  redirect_uri: `${AUTHORITY_URL}/v2/session/oidc/callback`,
  tenant: { kind: "issuer" as const },
  id_token_algorithms: ["RS256"],
};

function directory(): string {
  const created = mkdtempSync(join(tmpdir(), "echo-clean-founder-rehearsal-"));
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
        subject: "founder-subject",
        audience: OIDC.client_id,
        nonce: this.last.nonce,
        issued_at: Math.floor(Date.now() / 1000),
        claims: { email: "founder@example.com", email_verified: true },
      },
    };
  }
}

const fakeSlack: CleanSlackIdentityProviderV1 = {
  verifyConnection: async () => ({
    team_id: "T12345678",
    enterprise_id: null,
    bot_user_id: "U12345678",
    bot_id: "B12345678",
    app_id: "A12345678",
    granted_scopes: [
      "channels:history",
      "channels:read",
      "chat:write",
      "im:history",
      "im:write",
      "reactions:read",
      "users:read",
    ],
    verification_evidence_sha256: canonicalSha256("rehearsal-slack-connection"),
  }),
  verifyChannel: async (_token, channelId) => ({
    team_id: "T12345678",
    channel_id: channelId,
    is_public_organization_channel: true,
    is_active: true,
    bot_membership_verified: true,
    bot_access_verified: true,
    verification_evidence_sha256: canonicalSha256("rehearsal-slack-channel"),
  }),
  verifyHuman: async () => {
    throw new Error("clean Person Slack linking observes a thread instead");
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

const inactiveWorker: CleanLiveProcessingCycleV1 = {
  recoverV4Appends: async () => undefined,
  pollAndStageLiveOnlySource: async () => undefined,
  observeAndFinalizePendingApprovals: async () => undefined,
  appendFinalizedApprovalsToV4: async () => undefined,
  reconcileReadableSearchGeneration: async () => undefined,
};

function founderDependencies(): CleanFounderCliDependencies {
  return {
    now: () => "2026-08-22T12:00:00.000Z",
    reset: initializeCleanResetState,
    initialize_credentials: async (stateDirectory) => {
      initializeCleanPersonCredentials({ state_directory: stateDirectory });
    },
    connect_slack: async (input) => {
      if (input.connection_id === undefined) {
        throw new Error("missing planned connection ID");
      }
      const output = commandOutput();
      const status = await runCleanSlackConnectCli(
        [
          "--state-dir",
          input.state_directory,
          "--approval-channel-id",
          input.approval_channel_id,
          "--connection-id",
          input.connection_id,
        ],
        { stdout: output.write, read_stdin: input.read_stdin },
        {
          verify_state: verifyCleanControlPlaneStateV1,
          create_verifier: () => fakeSlack,
          now: () => "2026-08-22T12:00:00.000Z",
        },
      );
      expect(status).toBe(0);
      const verified = oneJson<{
        provider_tenant_id: string;
        provider_enterprise_id: string | null;
        provider_app_id: string;
        provider_bot_id: string;
        provider_bot_user_id: string;
        approval_channel_id: string;
        required_scopes: readonly string[];
        selected_channel_public: true;
        selected_channel_active: true;
        bot_membership_verified: true;
        bot_access_verified: true;
        verified_at: string;
      }>(output);
      return {
        connection_id: input.connection_id,
        verification: {
          workspace_id: verified.provider_tenant_id,
          enterprise_id: verified.provider_enterprise_id,
          app_id: verified.provider_app_id,
          bot_id: verified.provider_bot_id,
          bot_user_id: verified.provider_bot_user_id,
          identity_link_channel_id: verified.approval_channel_id,
          required_scopes: verified.required_scopes,
          identity_link_channel_access: "verified",
          selected_channel_public: verified.selected_channel_public,
          selected_channel_active: verified.selected_channel_active,
          bot_membership_verified: verified.bot_membership_verified,
          bot_access_verified: verified.bot_access_verified,
          verified_at: verified.verified_at,
        },
      };
    },
    issue_invitation: async (input) => {
      issueCleanPersonInvitation({
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
      const status = await runCleanGranolaSourceCli(
        [
          "--state-dir",
          input.state_directory,
          "--source-instance",
          "founder-granola-v1",
          "--processor-instance",
          "founder-llm-v1",
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
                    id: "founder-preflight-note",
                    owner: { email: "founder@example.com" },
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

describe("clean founder command rehearsal", () => {
  it("recovers durable Slack preflight proof after a lost bootstrap response", async () => {
    const root = directory();
    const stateDirectory = join(root, "state");
    const oidcConfigPath = join(root, "oidc.json");
    writeFileSync(
      oidcConfigPath,
      JSON.stringify({ ...OIDC, client_authentication: "none" }),
      { mode: 0o600 },
    );
    chmodSync(oidcConfigPath, 0o600);
    const args = [
      "bootstrap",
      "--state-dir",
      stateDirectory,
      "--organization-name",
      "Founder Organization",
      "--owner-display-name",
      "Founder",
      "--owner-email",
      "founder@example.com",
      "--authority-url",
      AUTHORITY_URL,
      "--oidc-config",
      oidcConfigPath,
      "--slack-approval-channel-id",
      "C12345678",
      "--artifact-revision",
      "clean-founder-command-rehearsal",
    ];
    const first = commandOutput();
    expect(
      await runCleanFounderCli(
        args,
        { stdout: first.write, stderr: first.write, read_stdin: async () => "fake-slack-bot-token" },
        founderDependencies(),
      ),
    ).toBe(0);
    // Deliberately discard `first`: status and an exact bootstrap retry must
    // reconstruct only durable, safe provider facts without a second token read.
    const status = commandOutput();
    expect(
      await runCleanFounderCli(
        ["status", "--state-dir", stateDirectory],
        { stdout: status.write, stderr: status.write, read_stdin: async () => "" },
      ),
    ).toBe(0);
    const safeStatus = oneJson<Record<string, unknown>>(status);
    expect(safeStatus).toMatchObject({
      slack_connected: true,
      source_progress_observed: false,
      approved_record_present: false,
      active_generation_current: false,
      owner_layer1_read_after_head: false,
      owner_layer2_read_after_generation: false,
    });
    expect(safeStatus).not.toHaveProperty("slack_verification");
    expect(JSON.stringify(safeStatus)).not.toContain("T12345678");
    expect(JSON.stringify(safeStatus)).not.toContain("2026-08-22T12:00:00.000Z");
    const resumed = commandOutput();
    expect(
      await runCleanFounderCli(
        args,
        { stdout: resumed.write, stderr: resumed.write, read_stdin: async () => { throw new Error("Slack stdin must not be reread"); } },
        founderDependencies(),
      ),
    ).toBe(0);
    expect(oneJson<Record<string, unknown>>(resumed)).toMatchObject({
      slack_verification: {
        workspace_id: "T12345678",
        selected_channel_public: true,
        selected_channel_active: true,
        bot_membership_verified: true,
        bot_access_verified: true,
      },
    });
  });

  it("runs bootstrap, idle live login and Slack link, stopped finalize, then active live restart", async () => {
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
      runCleanFounderCli(
        [
          "bootstrap",
          "--state-dir",
          stateDirectory,
          "--organization-name",
          "Founder Organization",
          "--owner-display-name",
          "Founder",
          "--owner-email",
          "founder@example.com",
          "--authority-url",
          AUTHORITY_URL,
          "--oidc-config",
          oidcConfigPath,
          "--slack-approval-channel-id",
          "C12345678",
          "--artifact-revision",
          "clean-founder-command-rehearsal",
        ],
        {
          stdout: bootstrap.write,
          stderr: bootstrap.write,
          read_stdin: async () => "fake-slack-bot-token",
        },
        founderDependencies(),
      ),
    ).resolves.toBe(0);
    const bootstrapped = oneJson<{ invitation_path: string }>(bootstrap);

    const idle = await openCleanGranolaLiveRuntime(
      {
        state_directory: stateDirectory,
        host: "127.0.0.1",
        port: await availablePort(),
        authority_url: AUTHORITY_URL,
        oidc: OIDC,
        client_authentication: { method: "none" },
        pkce_key_file: join(
          stateDirectory,
          "credentials",
          "person-session-pkce-sealing-key",
        ),
        slack_signing_secret_file: join(
          stateDirectory,
          "credentials",
          "slack-signing-secret",
        ),
        // The provider-free idle branch must not inspect this exact-id input.
        slack_connection_id: "con_not_read",
        slack_approval_channel_id: "C12345678",
        granola_credential_file: join(stateDirectory, "credentials", "granola-credential"),
        granola_owner_email_file: join(stateDirectory, "credentials", "granola-owner-email"),
        llm_credential_file: join(stateDirectory, "credentials", "llm-credential"),
      },
      { person: { oidc_provider: new MockOidcProvider(), slack_provider: fakeSlack } },
    );
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

      const linked = commandOutput();
      await expect(
        runPersonClientCli(["slack-link"], {
          stdout: { write: linked.write },
          stderr: { write: linked.write },
          home_directory: homeDirectory,
          fetch: rewriteFetch,
          read_input: () => "\n",
        }),
      ).resolves.toBe(0);
      expect(linked.values.join("")).toContain('"phase":"linked"');
    } finally {
      await idle.close();
    }

    privateCredential(
      join(stateDirectory, "credentials", "granola-credential"),
      `grn_${"a".repeat(32)}`,
    );
    privateCredential(
      join(stateDirectory, "credentials", "granola-owner-email"),
      "founder@example.com",
    );
    privateCredential(
      join(stateDirectory, "credentials", "llm-credential"),
      "x".repeat(32),
    );
    const finalized = commandOutput();
    const finalizeStatus = await runCleanFounderCli(
      ["finalize", "--state-dir", stateDirectory],
      {
        stdout: finalized.write,
        stderr: finalized.write,
        read_stdin: async () => "",
      },
      founderDependencies(),
    );
    expect(finalizeStatus, finalized.values.join("")).toBe(0);
    expect(oneJson<{ ok: boolean }>(finalized).ok).toBe(true);

    const active = await openCleanGranolaLiveRuntime(
      {
        state_directory: stateDirectory,
        host: "127.0.0.1",
        port: await availablePort(),
        authority_url: AUTHORITY_URL,
        oidc: OIDC,
        client_authentication: { method: "none" },
        pkce_key_file: join(
          stateDirectory,
          "credentials",
          "person-session-pkce-sealing-key",
        ),
        slack_signing_secret_file: join(
          stateDirectory,
          "credentials",
          "slack-signing-secret",
        ),
        // The injected processing seam also remains provider-free.
        slack_connection_id: "con_not_read",
        slack_approval_channel_id: "C12345678",
        granola_credential_file: join(stateDirectory, "credentials", "granola-credential"),
        granola_owner_email_file: join(stateDirectory, "credentials", "granola-owner-email"),
        llm_credential_file: join(stateDirectory, "credentials", "llm-credential"),
      },
      { active_processing: inactiveWorker },
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
  });
});
