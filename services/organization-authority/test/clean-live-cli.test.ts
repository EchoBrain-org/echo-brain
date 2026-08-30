import { canonicalJson } from "@echo-brain/federation-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdapterError } from "../src/processing/core/contracts/adapter.js";
import { CleanLiveWorkerLifecycleV1 } from "../src/processing/clean-v1/clean-live-worker-lifecycle.js";

type WorkerErrorObserver = (error: Error) => void;
type Layer4FailureObserver = (event: object) => void;
type WorkerTelemetryObserver = (event: object) => void;

const runtimeState = vi.hoisted(() => ({
  worker_error: undefined as WorkerErrorObserver | undefined,
  worker_telemetry: undefined as WorkerTelemetryObserver | undefined,
  layer4_failure: undefined as Layer4FailureObserver | undefined,
  startup_error: undefined as Error | undefined,
  slack_signing_secret_file: undefined as string | undefined,
  slack_connection_id: undefined as string | undefined,
  authority_url: "https://authority.example",
  processing: "active" as "active" | "idle_until_finalize",
}));

vi.mock("../src/composition/clean-founder-cli.js", () => ({
  readCleanFounderOnboardingManifest: () => ({
    authority_url: runtimeState.authority_url,
    oidc_config_path: "/private/oidc.json",
    pkce_key_file: "/private/pkce.key",
    slack_connection_id: "con_manifest",
    slack_approval_channel_id: "C_APPROVAL",
    granola_credential_file: "/private/granola.credential",
    granola_owner_email_file: "/private/granola-owner-email",
    llm_credential_file: "/private/llm.credential",
    owner_email: "founder@example.com",
  }),
}));

vi.mock("../src/composition/clean-person-cli.js", () => ({
  readCleanPersonOidcConfiguration: () => ({
    client_authentication: "none",
    configuration: {},
  }),
}));

vi.mock("../src/composition/open-clean-granola-live-runtime.js", () => ({
  openCleanGranolaLiveRuntime: async (config: {
    readonly on_worker_error?: WorkerErrorObserver;
    readonly on_worker_telemetry?: WorkerTelemetryObserver;
    readonly on_layer4_failure?: Layer4FailureObserver;
    readonly slack_signing_secret_file: string;
    readonly slack_connection_id: string;
  }) => {
    if (runtimeState.startup_error !== undefined) throw runtimeState.startup_error;
    runtimeState.worker_error = config.on_worker_error;
    runtimeState.worker_telemetry = config.on_worker_telemetry;
    runtimeState.layer4_failure = config.on_layer4_failure;
    runtimeState.slack_signing_secret_file = config.slack_signing_secret_file;
    runtimeState.slack_connection_id = config.slack_connection_id;
    return {
      address: { address: "127.0.0.1", port: 43179 },
      processing: runtimeState.processing,
      close: async () => undefined,
    };
  },
}));

const { runCleanLiveCli } = await import(
  "../src/composition/clean-live-cli.js"
);

afterEach(() => {
  runtimeState.worker_error = undefined;
  runtimeState.worker_telemetry = undefined;
  runtimeState.layer4_failure = undefined;
  runtimeState.startup_error = undefined;
  runtimeState.slack_signing_secret_file = undefined;
  runtimeState.slack_connection_id = undefined;
  runtimeState.authority_url = "https://authority.example";
  runtimeState.processing = "active";
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
      "--slack-signing-secret-file",
      "/private/slack-signing-secret",
    ],
    { stdout: () => undefined, ...io },
  );
}

describe("clean live CLI runtime events", () => {
  it("keeps founder onboarding live when staging processing is still idle", async () => {
    const stderr: string[] = [];
    runtimeState.authority_url = "https://authority-staging.echobrain.org";
    runtimeState.processing = "idle_until_finalize";
    const running = start({ stderr: (value) => stderr.push(value) });
    await vi.waitFor(() => expect(runtimeState.worker_error).toBeDefined());
    process.emit("SIGTERM");
    await expect(running).resolves.toBe(0);
    expect(stderr).toContain(
      `${canonicalJson({
        schema_version: 1,
        kind: "echo-clean-live-runtime-ready-v1",
        processing: "idle_until_finalize",
      } as never)}\n`,
    );
  });

  it("requires and forwards only the Slack signing-secret file path", async () => {
    const stderr: string[] = [];
    const running = start({ stderr: (value) => stderr.push(value) });
    await vi.waitFor(() =>
      expect(runtimeState.slack_signing_secret_file).toBe(
        "/private/slack-signing-secret",
      ),
    );
    process.emit("SIGTERM");
    await expect(running).resolves.toBe(0);
    expect(stderr.join("")).not.toContain("slack-signing-secret");
    expect(runtimeState.slack_connection_id).toBe("con_manifest");
  });

  it("writes the closed worker lifecycle event without mutation", async () => {
    const stderr: string[] = [];
    const running = start({ stderr: (value) => stderr.push(value) });
    await vi.waitFor(() => expect(runtimeState.worker_telemetry).toBeDefined());

    runtimeState.worker_telemetry!({
      schema_version: 1,
      kind: "echo-clean-live-worker-phase-v1",
      event: "failed",
      cycle_phase: "extraction",
      elapsed_ms: 120_000,
      failure_class: "unknown",
      retryable: true,
    });
    process.emit("SIGTERM");
    await expect(running).resolves.toBe(0);

    expect(stderr).toContain(
      `${canonicalJson({
        schema_version: 1,
        kind: "echo-clean-live-worker-phase-v1",
        event: "failed",
        cycle_phase: "extraction",
        elapsed_ms: 120_000,
        failure_class: "unknown",
        retryable: true,
      } as never)}\n`,
    );
  });

  // This covers the lifecycle-schema to CLI-serialization seam. Runtime
  // lifecycle behavior is covered separately by clean-live-runtime tests.
  it("redacts generic and typed lifecycle failures through the CLI observer", async () => {
    const stderr: string[] = [];
    const running = start({ stderr: (value) => stderr.push(value) });
    await vi.waitFor(() => expect(runtimeState.worker_telemetry).toBeDefined());
    const lifecycle = new CleanLiveWorkerLifecycleV1(
      (event) => runtimeState.worker_telemetry!(event),
      () => 1_000,
    );
    lifecycle.startCycle();
    await expect(
      lifecycle.runPhase("extraction", async () => {
        throw new Error("generic-runtime-sentinel prompt-sentinel");
      }),
    ).rejects.toThrow("generic-runtime-sentinel");
    await expect(
      lifecycle.runPhase("approval_staging", async () => {
        throw new AdapterError(
          "unauthorized",
          "typed-runtime-sentinel credential-sentinel",
          false,
        );
      }),
    ).rejects.toThrow("typed-runtime-sentinel");
    lifecycle.failCycle(new Error("cycle-runtime-sentinel"));
    process.emit("SIGTERM");
    await expect(running).resolves.toBe(0);

    const output = stderr.join("");
    for (const sentinel of [
      "generic-runtime-sentinel",
      "prompt-sentinel",
      "typed-runtime-sentinel",
      "credential-sentinel",
      "cycle-runtime-sentinel",
    ]) {
      expect(output).not.toContain(sentinel);
    }
    expect(output).toContain('"failure_class":"unknown"');
    expect(output).toContain('"failure_class":"authorization"');
  });

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
      adapter_id: "private-adapter-sentinel",
      finish_reason: "error",
      adapter_request_id: "private-request-sentinel",
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
      "private-adapter-sentinel",
      "private-request-sentinel",
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
