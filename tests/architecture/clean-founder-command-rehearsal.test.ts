import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BegunPersonOidcLogin } from "../../services/organization-authority/src/application/person-identity-sessions.js";
import type { PersonSessionOidcAuthorizationProvider } from "../../services/organization-authority/src/composition/lazy-person-session-oidc-provider.js";
import { runCleanPersonCli } from "../../services/organization-authority/src/composition/clean-person-cli.js";
import { runCleanResetCli } from "../../services/organization-authority/src/composition/clean-reset-cli.js";
import { startCleanPersonRuntime } from "../../services/organization-authority/src/composition/clean-person-runtime.js";
import { readPrivateAuthorityPersonSessionPkceKey } from "../../services/organization-authority/src/adapters/security/private-file-credentials.js";
import { runPersonClientCli } from "../../src/product/person-client/commands.js";

const roots: string[] = [];
const AUTHORITY_URL = "https://authority.example";

function directory(): string {
  const created = mkdtempSync(join(tmpdir(), "echo-clean-founder-rehearsal-"));
  chmodSync(created, 0o700);
  const value = realpathSync(created);
  roots.push(value);
  return value;
}

function output() {
  const values: string[] = [];
  return { values, write: (value: string) => values.push(value) };
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
        issuer: "https://issuer.example",
        subject: "founder-subject",
        audience: "founder-client",
        nonce: this.last.nonce,
        issued_at: Math.floor(Date.now() / 1000),
        claims: { email: "founder@example.com", email_verified: true },
      },
    };
  }
}

function parsedLine<T>(captured: { readonly values: readonly string[] }): T {
  expect(captured.values).toHaveLength(1);
  return JSON.parse(captured.values[0]!) as T;
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("clean founder command rehearsal", () => {
  it("runs reset, credentials, invite, Person login begin/install, refresh, and logout against loopback", async () => {
    const root = directory();
    const stateDirectory = join(root, "state");
    const reset = output();
    expect(
      runCleanResetCli(
        [
          "--state-dir",
          stateDirectory,
          "--organization-name",
          "Founder Organization",
          "--owner-display-name",
          "Founder",
          "--created-at",
          new Date(Date.now() - 1_000).toISOString(),
          "--artifact-revision",
          "founder-command-rehearsal",
        ],
        { stdout: reset.write, stderr: reset.write },
      ),
    ).toBe(0);
    const initialized = parsedLine<{
      owner_membership_id: string;
    }>(reset);

    const oidcConfigPath = join(root, "oidc.json");
    writeFileSync(
      oidcConfigPath,
      JSON.stringify({
        issuer: "https://issuer.example",
        client_id: "founder-client",
        redirect_uri: `${AUTHORITY_URL}/v2/session/oidc/callback`,
        tenant: { kind: "issuer" },
        id_token_algorithms: ["RS256"],
        client_authentication: "none",
      }),
      { mode: 0o600 },
    );
    const credentials = output();
    await expect(
      runCleanPersonCli(["credentials-init", "--state-dir", stateDirectory], {
        stdout: credentials.write,
        stderr: credentials.write,
      }),
    ).resolves.toBe(0);
    const generated = parsedLine<{ pkce_sealing_key_reference: string }>(
      credentials,
    );
    const pkceKeyPath = generated.pkce_sealing_key_reference.slice(
      "file:".length,
    );

    const invitationDirectory = join(root, "invitations");
    // The invitation writer requires a founder-controlled canonical 0700 parent.
    mkdirSync(invitationDirectory, { mode: 0o700 });
    chmodSync(invitationDirectory, 0o700);
    const invitationPath = join(invitationDirectory, "founder.invitation.json");
    const invite = output();
    await expect(
      runCleanPersonCli(
        [
          "invite",
          "--state-dir",
          stateDirectory,
          "--oidc-config",
          oidcConfigPath,
          "--pkce-key-file",
          pkceKeyPath,
          "--membership-id",
          initialized.owner_membership_id,
          "--expected-email",
          "founder@example.com",
          "--authority-url",
          AUTHORITY_URL,
          "--out",
          invitationPath,
        ],
        { stdout: invite.write, stderr: invite.write },
      ),
    ).resolves.toBe(0);
    expect(parsedLine<{ output_path: string }>(invite).output_path).toBe(
      invitationPath,
    );

    const runtime = await startCleanPersonRuntime(
      {
        state_directory: stateDirectory,
        host: "127.0.0.1",
        port: 19_992,
        authority_url: AUTHORITY_URL,
        oidc: {
          issuer: "https://issuer.example",
          client_id: "founder-client",
          redirect_uri: `${AUTHORITY_URL}/v2/session/oidc/callback`,
          tenant: { kind: "issuer" },
          id_token_algorithms: ["RS256"],
        },
        client_authentication: { method: "none" },
        pkce_sealing_key: readPrivateAuthorityPersonSessionPkceKey(
          generated.pkce_sealing_key_reference,
        ),
      },
      { oidc_provider: new MockOidcProvider() },
    );
    try {
      const loopback = `http://127.0.0.1:${String(runtime.address.port)}`;
      const rewriteFetch: typeof fetch = async (input, init) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        expect(url.origin).toBe(AUTHORITY_URL);
        return await fetch(`${loopback}${url.pathname}${url.search}`, init);
      };
      const homeDirectory = join(root, "home");
      const login = output();
      await expect(
        runPersonClientCli(["login-begin", "--invitation", invitationPath], {
          stdout: login,
          stderr: login,
          home_directory: homeDirectory,
          fetch: rewriteFetch,
        }),
      ).resolves.toBe(0);
      const begun = parsedLine<{ authorization_url: string }>(login);
      const state = new URL(begun.authorization_url).searchParams.get("state");
      expect(state).not.toBeNull();
      const callback = await fetch(
        `${loopback}/v2/session/oidc/callback?state=${encodeURIComponent(state!)}&code=code-1&iss=https%3A%2F%2Fissuer.example`,
      );
      expect(callback.status).toBe(200);
      const session = await callback.json();

      const install = output();
      await expect(
        runPersonClientCli(
          ["session-install", "--authority-url", AUTHORITY_URL],
          {
            stdout: install,
            stderr: install,
            home_directory: homeDirectory,
            fetch: rewriteFetch,
            read_input: () => JSON.stringify(session),
          },
        ),
      ).resolves.toBe(0);
      expect(parsedLine<{ ok: boolean }>(install).ok).toBe(true);

      const refresh = output();
      await expect(
        runPersonClientCli(["session-refresh"], {
          stdout: refresh,
          stderr: refresh,
          home_directory: homeDirectory,
          fetch: rewriteFetch,
        }),
      ).resolves.toBe(0);
      expect(parsedLine<{ ok: boolean }>(refresh).ok).toBe(true);

      const logout = output();
      await expect(
        runPersonClientCli(["logout"], {
          stdout: logout,
          stderr: logout,
          home_directory: homeDirectory,
          fetch: rewriteFetch,
        }),
      ).resolves.toBe(0);
      expect(parsedLine<{ ok: boolean }>(logout).ok).toBe(true);
    } finally {
      await runtime.close();
    }
  });
});
