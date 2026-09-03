import { canonicalJson } from "@echo-brain/federation-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdapterError } from "../src/processing/core/contracts/adapter.js";
import { MeetingProcessingWorkerLifecycleV1 } from "../src/processing/admitted-meeting-processing/meeting-processing-worker-lifecycle.js";

type WorkerErrorObserver = (error: Error) => void;
type AnswerCompositionFailureObserver = (event: object) => void;
type WorkerTelemetryObserver = (event: object) => void;

const runtimeState = vi.hoisted(() => ({
  worker_error: undefined as WorkerErrorObserver | undefined,
  worker_telemetry: undefined as WorkerTelemetryObserver | undefined,
  answer_composition_failure: undefined as
    | AnswerCompositionFailureObserver
    | undefined,
  startup_error: undefined as Error | undefined,
  open_gate: undefined as Promise<void> | undefined,
  slack_signing_secret_file: undefined as string | undefined,
  slack_connection_id: undefined as string | undefined,
  openrouter_credential_file: undefined as string | undefined,
  ask_journey_telemetry: undefined as object | undefined,
  meeting_approval_journey_telemetry: undefined as object | undefined,
  staging_meeting_approval_journey_telemetry_enabled: undefined as
    | true
    | undefined,
  authority_url: "https://authority.example",
  processing: "active" as "active" | "idle_until_finalize",
  shutdown_events: [] as string[],
  runtime_close_gate: undefined as Promise<void> | undefined,
}));

vi.mock("../src/composition/organization-authority-setup-cli.js", () => ({
  readOrganizationAuthoritySetupManifest: () => ({
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

vi.mock("../src/composition/organization-authority-person-administration-cli.js", () => ({
  readPersonOidcConfiguration: () => ({
    client_authentication: "none",
    configuration: {},
  }),
}));

vi.mock("../src/composition/organization-authority-composition-root.js", () => ({
  openOrganizationAuthorityService: async (config: {
    readonly on_worker_error?: WorkerErrorObserver;
    readonly on_worker_telemetry?: WorkerTelemetryObserver;
    readonly on_answer_composition_failure?: AnswerCompositionFailureObserver;
    readonly ask_journey_telemetry?: object;
    readonly meeting_approval_journey_telemetry?: object;
    readonly staging_meeting_approval_journey_telemetry_enabled?: true;
    readonly slack_signing_secret_file: string;
    readonly slack_connection_id: string;
    readonly openrouter_credential_file: string;
  }) => {
    if (runtimeState.open_gate !== undefined) await runtimeState.open_gate;
    if (runtimeState.startup_error !== undefined) throw runtimeState.startup_error;
    runtimeState.worker_error = config.on_worker_error;
    runtimeState.worker_telemetry = config.on_worker_telemetry;
    runtimeState.answer_composition_failure =
      config.on_answer_composition_failure;
    runtimeState.ask_journey_telemetry = config.ask_journey_telemetry;
    runtimeState.meeting_approval_journey_telemetry =
      config.meeting_approval_journey_telemetry;
    runtimeState.staging_meeting_approval_journey_telemetry_enabled =
      config.staging_meeting_approval_journey_telemetry_enabled;
    runtimeState.slack_signing_secret_file = config.slack_signing_secret_file;
    runtimeState.slack_connection_id = config.slack_connection_id;
    runtimeState.openrouter_credential_file = config.openrouter_credential_file;
    return {
      address: { address: "127.0.0.1", port: 43179 },
      processing: runtimeState.processing,
      close: async () => {
        runtimeState.shutdown_events.push("runtime-close-started");
        await runtimeState.runtime_close_gate;
        runtimeState.shutdown_events.push("runtime-close-finished");
      },
    };
  },
}));

vi.mock(
  "../src/composition/staging/observability/staging-journey-telemetry-transport-v1.js",
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import("../src/composition/staging/observability/staging-journey-telemetry-transport-v1.js")
    >();
    return {
      ...actual,
      createStagingJourneyTelemetryTransportFromEnvironmentV1(
        environment: Readonly<Record<string, string | undefined>>,
        dependencies: Parameters<
          typeof actual.createStagingJourneyTelemetryTransportFromEnvironmentV1
        >[1],
      ) {
        const transport =
          actual.createStagingJourneyTelemetryTransportFromEnvironmentV1(
            environment,
            dependencies,
          );
        return {
          ...transport,
          close() {
            runtimeState.shutdown_events.push("telemetry-transport-closed");
            transport.close();
          },
        };
      },
    };
  },
);

const { runOrganizationAuthorityServiceCli } = await import(
  "../src/composition/organization-authority-service-cli.js"
);

afterEach(() => {
  delete process.env.ECHO_STAGING_JOURNEY_TELEMETRY_V1;
  delete process.env.ECHO_BUILD_NUMBER;
  delete process.env.ECHO_SOURCE_SHA;
  runtimeState.worker_error = undefined;
  runtimeState.worker_telemetry = undefined;
  runtimeState.answer_composition_failure = undefined;
  runtimeState.startup_error = undefined;
  runtimeState.open_gate = undefined;
  runtimeState.slack_signing_secret_file = undefined;
  runtimeState.slack_connection_id = undefined;
  runtimeState.openrouter_credential_file = undefined;
  runtimeState.ask_journey_telemetry = undefined;
  runtimeState.meeting_approval_journey_telemetry = undefined;
  runtimeState.staging_meeting_approval_journey_telemetry_enabled = undefined;
  runtimeState.authority_url = "https://authority.example";
  runtimeState.processing = "active";
  runtimeState.shutdown_events = [];
  runtimeState.runtime_close_gate = undefined;
});

function start(io: { readonly stderr: (value: string) => void }) {
  return runOrganizationAuthorityServiceCli(
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

describe("admitted runtime CLI events", () => {
  it("closes telemetry only after the authority runtime has finished", async () => {
    process.env.ECHO_STAGING_JOURNEY_TELEMETRY_V1 = "true";
    process.env.ECHO_SOURCE_SHA = "a".repeat(40);
    process.env.ECHO_BUILD_NUMBER = "1";
    runtimeState.authority_url = "https://authority-staging.echobrain.org";
    let releaseRuntimeClose: (() => void) | undefined;
    runtimeState.runtime_close_gate = new Promise<void>((resolve) => {
      releaseRuntimeClose = resolve;
    });

    const running = start({ stderr: () => undefined });
    await vi.waitFor(() => expect(runtimeState.worker_error).toBeDefined());
    process.emit("SIGTERM");
    await vi.waitFor(() =>
      expect(runtimeState.shutdown_events).toEqual(["runtime-close-started"]),
    );

    releaseRuntimeClose!();
    await expect(running).resolves.toBe(0);
    expect(runtimeState.shutdown_events).toEqual([
      "runtime-close-started",
      "runtime-close-finished",
      "telemetry-transport-closed",
    ]);
  });

  it("emits identity-bound liveness only for the exact staging Authority", async () => {
    const releaseSha = "a".repeat(40);
    process.env.ECHO_STAGING_JOURNEY_TELEMETRY_V1 = "true";
    process.env.ECHO_SOURCE_SHA = releaseSha;
    process.env.ECHO_BUILD_NUMBER = "33689731778";
    runtimeState.authority_url = "https://authority-staging.echobrain.org";
    const stagingStderr: string[] = [];
    const staging = start({
      stderr: (value) => {
        stagingStderr.push(value);
      },
    });
    await vi.waitFor(() => expect(runtimeState.worker_error).toBeDefined());
    process.emit("SIGTERM");
    await expect(staging).resolves.toBe(0);

    const liveness = stagingStderr
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find(
        (event) =>
          event.kind === "echo-authority-journey-telemetry-liveness-v1",
      );
    expect(liveness).toMatchObject({
      schema_version: 1,
      kind: "echo-authority-journey-telemetry-liveness-v1",
      environment: "staging",
      release_sha: releaseSha,
      build_number: 33_689_731_778,
      event: "startup",
    });
    expect(new Date(String(liveness?.observed_at)).toISOString()).toBe(
      liveness?.observed_at,
    );
    expect(runtimeState.ask_journey_telemetry).toBeDefined();
    expect(runtimeState.meeting_approval_journey_telemetry).toMatchObject({
      release_sha: releaseSha,
      build_number: 33_689_731_778,
    });
    expect(
      runtimeState.staging_meeting_approval_journey_telemetry_enabled,
    ).toBe(true);

    runtimeState.worker_error = undefined;
    runtimeState.authority_url = "https://authority.example";
    const nonStagingStderr: string[] = [];
    const nonStaging = start({
      stderr: (value) => {
        nonStagingStderr.push(value);
      },
    });
    await vi.waitFor(() => expect(runtimeState.worker_error).toBeDefined());
    process.emit("SIGTERM");
    await expect(nonStaging).resolves.toBe(0);
    expect(runtimeState.ask_journey_telemetry).toBeUndefined();
    expect(runtimeState.meeting_approval_journey_telemetry).toBeUndefined();
    expect(
      runtimeState.staging_meeting_approval_journey_telemetry_enabled,
    ).toBeUndefined();
    expect(nonStagingStderr.join("")).not.toContain(
      "echo-authority-journey-telemetry-liveness-v1",
    );
  });

  it("keeps staging available when immutable telemetry identity is invalid", async () => {
    process.env.ECHO_STAGING_JOURNEY_TELEMETRY_V1 = "true";
    process.env.ECHO_SOURCE_SHA = "not-a-source-sha";
    process.env.ECHO_BUILD_NUMBER = "01";
    runtimeState.authority_url = "https://authority-staging.echobrain.org";
    const stderr: string[] = [];
    const running = start({
      stderr: (value) => {
        stderr.push(value);
      },
    });
    await vi.waitFor(() => expect(runtimeState.worker_error).toBeDefined());
    process.emit("SIGTERM");

    await expect(running).resolves.toBe(0);
    expect(runtimeState.ask_journey_telemetry).toBeUndefined();
    expect(runtimeState.meeting_approval_journey_telemetry).toBeUndefined();
    expect(
      runtimeState.staging_meeting_approval_journey_telemetry_enabled,
    ).toBeUndefined();
    expect(stderr.join("")).not.toContain(
      "echo-authority-journey-telemetry-liveness-v1",
    );
    expect(stderr.join("")).toContain("echo-clean-live-runtime-ready-v1");
  });

  it("does not claim staging liveness while runtime opening is pending or fails", async () => {
    const releaseSha = "b".repeat(40);
    process.env.ECHO_STAGING_JOURNEY_TELEMETRY_V1 = "true";
    process.env.ECHO_SOURCE_SHA = releaseSha;
    process.env.ECHO_BUILD_NUMBER = "42";
    runtimeState.authority_url = "https://authority-staging.echobrain.org";
    let releaseOpen: (() => void) | undefined;
    runtimeState.open_gate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const pendingStderr: string[] = [];
    const pending = start({ stderr: (value) => pendingStderr.push(value) });

    await Promise.resolve();
    expect(pendingStderr).toEqual([]);

    runtimeState.startup_error = new Error("runtime open failed");
    releaseOpen?.();
    await expect(pending).resolves.toBe(1);
    expect(pendingStderr.join("")).not.toContain(
      "echo-authority-journey-telemetry-liveness-v1",
    );
    expect(pendingStderr).toEqual([
      `${canonicalJson({
        schema_version: 1,
        kind: "echo-clean-live-startup-failed-v1",
      } as never)}\n`,
    ]);
  });

  it("keeps owner onboarding available when staging processing is still idle", async () => {
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
    expect(runtimeState.openrouter_credential_file).toBe(
      "/private/llm.credential",
    );
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
  // Lifecycle behavior is covered separately by Organization Authority service tests.
  it("redacts generic and typed lifecycle failures through the CLI observer", async () => {
    const stderr: string[] = [];
    const running = start({ stderr: (value) => stderr.push(value) });
    await vi.waitFor(() => expect(runtimeState.worker_telemetry).toBeDefined());
    const lifecycle = new MeetingProcessingWorkerLifecycleV1(
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

  it("does not disclose startup failure contents to the API server log", async () => {
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

  it("does not disclose worker failure contents to the API server log", async () => {
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
    runtimeState.answer_composition_failure!({
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
