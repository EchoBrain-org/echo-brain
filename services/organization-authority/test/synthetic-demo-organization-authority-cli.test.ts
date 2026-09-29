import { canonicalJson } from "@echo-brain/federation-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

const runtimeState = vi.hoisted(() => ({
  opened: false,
}));

vi.mock("../src/composition/organization-authority-setup-cli.js", () => ({
  readOrganizationAuthoritySetupManifest: () => ({
    authority_url: "https://authority.example",
    oidc_config_path: "/private/oidc.json",
    pkce_key_file: "/private/pkce.key",
    slack_connection_id: "con_manifest",
    slack_approval_channel_id: "C_APPROVAL",
    llm_credential_file: "/private/llm.credential",
    owner_email: "founder@example.com",
  }),
}));

vi.mock("../src/composition/organization-authority-person-administration-cli.js", () => ({
  readPersonOidcConfiguration: () => ({
    client_authentication: "none",
    configuration: {},
  }),
}));

vi.mock(
  "../src/composition/synthetic-demo-organization-authority-composition-root-v1.js",
  () => ({
    openSyntheticDemoOrganizationAuthorityServiceV1: async () => {
      runtimeState.opened = true;
      return {
        processing: "active" as const,
        close: async () => undefined,
      };
    },
  }),
);

const { runSyntheticDemoOrganizationAuthorityCliV1 } = await import(
  "../src/composition/synthetic-demo-organization-authority-cli.js"
);

afterEach(() => {
  runtimeState.opened = false;
});

function start(io: { readonly stderr: (value: string) => void }) {
  return runSyntheticDemoOrganizationAuthorityCliV1(
    [
      "serve",
      "--state-dir",
      "/private/state",
      "--meetings-dir",
      "/private/meetings",
      "--host",
      "127.0.0.1",
      "--port",
      "43179",
      "--slack-signing-secret-file",
      "/private/slack-signing-secret",
    ],
    { stdout: () => undefined, ...io },
  );
}

describe("synthetic demo runtime CLI events", () => {
  it("writes only the closed ready event to the server log", async () => {
    // The one-shot Ask failure log was retired with that Ask (ADR-0022).
    const stderr: string[] = [];
    const running = start({ stderr: (value) => stderr.push(value) });
    await vi.waitFor(() => expect(runtimeState.opened).toBe(true));
    process.emit("SIGTERM");
    await expect(running).resolves.toBe(0);
    expect(stderr).toEqual([
      `${canonicalJson({
        schema_version: 1,
        kind: "echo-synthetic-demo-runtime-ready-v1",
        processing: "active",
      } as never)}\n`,
    ]);
  });
});
