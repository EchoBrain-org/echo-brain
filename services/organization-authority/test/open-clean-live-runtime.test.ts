import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeCleanPersonCredentials } from "../src/composition/clean-person-onboarding.js";
import { initializeCleanResetState } from "../src/composition/clean-reset-state.js";
import { openCleanLiveRuntime } from "../src/composition/open-clean-live-runtime.js";

const roots: string[] = [];

function root(): string {
  const created = mkdtempSync(join(tmpdir(), "echo-open-clean-live-"));
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
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

afterEach(() => {
  for (const value of roots.splice(0))
    rmSync(value, { recursive: true, force: true });
});

describe("open clean live runtime", () => {
  it("starts the same Person server before finalize without contacting OIDC, Granola, OpenRouter, or Slack", async () => {
    const parent = root();
    const initialized = initializeCleanResetState({
      state_directory: join(parent, "state"),
      organization_display_name: "Founder Organization",
      owner_display_name: "Founder",
      created_at: "2026-08-22T12:00:00.000Z",
      creating_artifact_revision: "open-clean-live-runtime-test",
    });
    const credentials = initializeCleanPersonCredentials({
      state_directory: initialized.state_directory,
    });
    const runtime = await openCleanLiveRuntime({
      state_directory: initialized.state_directory,
      host: "127.0.0.1",
      port: await availablePort(),
      authority_url: "https://authority.example",
      // A real discovery request to this deliberately invalid issuer would
      // fail. Successful startup proves construction is provider-free.
      oidc: {
        issuer: "https://issuer.invalid",
        client_id: "founder-client",
        redirect_uri: "https://authority.example/v2/session/oidc/callback",
        tenant: { kind: "issuer" },
        id_token_algorithms: ["RS256"],
      },
      client_authentication: { method: "none" },
      pkce_key_file: credentials.pkce_sealing_key_reference.slice(
        "file:".length,
      ),
      slack_approval_channel_id: "C0123456789",
      // Admission is intentionally absent, so these private paths must not be
      // touched until stopped-state finalize admits the source.
      granola_credential_file: join(parent, "not-read-granola"),
      granola_owner_email_file: join(parent, "not-read-owner"),
      llm_credential_file: join(parent, "not-read-llm"),
    });
    try {
      expect(runtime.processing).toBe("idle_until_finalize");
      const descriptor = await fetch(
        `http://127.0.0.1:${String(runtime.address.port)}/v1/authority-descriptor`,
      );
      expect(descriptor.status).toBe(200);
    } finally {
      await runtime.close();
    }
  });
});
