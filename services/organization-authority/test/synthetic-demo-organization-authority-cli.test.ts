import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "@echo-brain/federation-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

const runtimeState = vi.hoisted(() => ({
  opened: false,
  slack_nango: undefined as object | undefined,
}));

vi.mock("../src/composition/organization-authority-setup-cli.js", () => ({
  readOrganizationAuthoritySetupManifest: () => ({
    authority_url: "https://authority.example",
    oidc_config_path: "/private/oidc.json",
    pkce_key_file: "/private/pkce.key",
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
    openSyntheticDemoOrganizationAuthorityServiceV1: async (config: { readonly slack_nango: object }) => {
      runtimeState.opened = true;
      runtimeState.slack_nango = config.slack_nango;
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

const NANGO_KEY = "nango-secret-key-0000-never-printed-0000";
const roots: string[] = [];

afterEach(() => {
  runtimeState.opened = false;
  runtimeState.slack_nango = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function start(io: { readonly stderr: (value: string) => void }, extra: readonly string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "echo-synthetic-demo-nango-"));
  roots.push(root);
  const key = join(root, "nango-secret-key");
  writeFileSync(key, NANGO_KEY, { mode: 0o600 });
  chmodSync(key, 0o600);
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
      "--nango-secret-key-file",
      key,
      "--nango-integration",
      "slack",
      ...extra,
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
    expect(runtimeState.slack_nango).toEqual({ secret_key: NANGO_KEY, integration_key: "slack" });
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

  it("refuses the retired Slack signing-secret flag before opening the runtime", async () => {
    const stderr: string[] = [];
    await expect(
      start({ stderr: (value) => stderr.push(value) }, ["--slack-signing-secret-file", "/private/slack-signing-secret"]),
    ).resolves.toBe(1);
    expect(runtimeState.opened).toBe(false);
    expect(stderr.join("")).toMatch(/^usage:/);
    expect(stderr.join("")).not.toContain(NANGO_KEY);
  });
});
