import { canonicalJson } from "@echo-brain/federation-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

type WorkerErrorObserver = (error: Error) => void;
type Layer4FailureObserver = (event: object) => void;

const runtimeState = vi.hoisted(() => ({
  worker_error: undefined as WorkerErrorObserver | undefined,
  layer4_failure: undefined as Layer4FailureObserver | undefined,
  startup_error: undefined as Error | undefined,
}));

vi.mock("../src/composition/clean-founder-cli.js", () => ({
  readCleanFounderOnboardingManifest: () => ({
    authority_url: "https://authority.example",
    oidc_config_path: "/private/oidc.json",
    pkce_key_file: "/private/pkce.key",
    slack_approval_channel_id: "C_APPROVAL",
    granola_credential_file: "/private/granola.credential",
    granola_owner_email_file: "/private/granola-owner-email",
    llm_credential_file: "/private/llm.credential",
  }),
}));

vi.mock("../src/composition/clean-person-cli.js", () => ({
  readCleanPersonOidcConfiguration: () => ({
    client_authentication: "none",
    configuration: {},
  }),
}));

vi.mock("../src/composition/open-clean-live-runtime.js", () => ({
  openCleanLiveRuntime: async (config: {
    readonly on_worker_error?: WorkerErrorObserver;
    readonly on_layer4_failure?: Layer4FailureObserver;
  }) => {
    if (runtimeState.startup_error !== undefined) throw runtimeState.startup_error;
    runtimeState.worker_error = config.on_worker_error;
    runtimeState.layer4_failure = config.on_layer4_failure;
    return {
      address: { address: "127.0.0.1", port: 43179 },
      processing: "active",
      close: async () => undefined,
    };
  },
}));

const { runCleanLiveCli } = await import(
  "../src/composition/clean-live-cli.js"
);

afterEach(() => {
  runtimeState.worker_error = undefined;
  runtimeState.layer4_failure = undefined;
  runtimeState.startup_error = undefined;
});

function start(io: { readonly stderr: (value: string) => void }) {
  return runCleanLiveCli(
    [
      "serve",
      "--state-dir",
      "/private/state",
      "--host",
      "127.0.0.1",
      "--port",
      "43179",
    ],
    { stdout: () => undefined, ...io },
  );
}

describe("clean live CLI runtime events", () => {
  it("does not disclose startup failure contents to the live server log", async () => {
    const stderr: string[] = [];
    runtimeState.startup_error = new Error(
      "credential=credential-sentinel Authorization: Bearer bearer-sentinel",
    );

    await expect(
      start({ stderr: (value) => stderr.push(value) }),
    ).resolves.toBe(1);

    expect(stderr.join("")).not.toContain("credential-sentinel");
    expect(stderr.join("")).not.toContain("bearer-sentinel");
    expect(stderr).toEqual([
      `${canonicalJson({
        schema_version: 1,
        kind: "echo-clean-live-startup-failed-v1",
      } as never)}\n`,
    ]);
  });

  it("does not disclose worker failure contents to the live server log", async () => {
    const stderr: string[] = [];
    const running = start({ stderr: (value) => stderr.push(value) });
    await vi.waitFor(() => expect(runtimeState.worker_error).toBeDefined());

    runtimeState.worker_error!(
      new Error(
        "credential=credential-sentinel note=note-sentinel " +
          "prompt=prompt-sentinel answer=answer-sentinel " +
          "Authorization: Bearer bearer-sentinel",
      ),
    );
    runtimeState.layer4_failure!({
      schema_version: 1,
      kind: "echo-clean-layer4-failure-v1",
      stage: "answer",
      failure_class: "adapter_response",
      elapsed_ms: 120_000,
      http_status: 504,
      provider: "private-provider-sentinel",
      finish_reason: "error",
      provider_generation_id: "private-generation-sentinel",
      retrieval_generation_id: "private-retrieval-sentinel",
    });
    process.emit("SIGTERM");
    await expect(running).resolves.toBe(0);

    const output = stderr.join("");
    for (const sentinel of [
      "credential-sentinel",
      "note-sentinel",
      "prompt-sentinel",
      "answer-sentinel",
      "bearer-sentinel",
      "private-provider-sentinel",
      "private-generation-sentinel",
      "private-retrieval-sentinel",
    ]) {
      expect(output).not.toContain(sentinel);
    }
    expect(stderr).toEqual([
      `${canonicalJson({
        schema_version: 1,
        kind: "echo-clean-live-runtime-ready-v1",
        processing: "active",
      } as never)}\n`,
      `${canonicalJson({
        schema_version: 1,
        kind: "echo-clean-live-worker-failed-v1",
      } as never)}\n`,
      `${canonicalJson({
        schema_version: 1,
        kind: "echo-clean-layer4-failure-v1",
        stage: "answer",
        failure_class: "adapter_response",
        elapsed_ms: 120_000,
        http_status: 504,
        finish_reason: "error",
      } as never)}\n`,
    ]);
    expect(output).not.toContain("127.0.0.1");
    expect(output).not.toContain("43179");
    expect(output).not.toContain("/private/");
  });
});
