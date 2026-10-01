import { canonicalJson } from "@echo-brain/federation-protocol";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureCoreRuntimeContentV1, observeCoreRuntimeV1, type CoreRuntimeObservationScopeV1 } from "@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1";
import { AdapterError } from "@echo-brain/organization-processing/core/contracts/adapter";
import { MeetingProcessingWorkerLifecycleV1 } from "@echo-brain/organization-processing/admitted-meeting-processing/meeting-processing-worker-lifecycle";

type WorkerErrorObserver = (error: Error) => void;
type WorkerTelemetryObserver = (event: object) => void;
type ApprovedSearchBacklogObserver = (event: {
  readonly observed_at: string;
  readonly pending_count: number;
  readonly stuck_count: number;
  readonly oldest_age_ms: number | null;
}) => void | Promise<void>;

const runtimeState = vi.hoisted(() => ({
  worker_error: undefined as WorkerErrorObserver | undefined,
  worker_telemetry: undefined as WorkerTelemetryObserver | undefined,
  approved_search_backlog: undefined as
    ApprovedSearchBacklogObserver | undefined,
  startup_error: undefined as Error | undefined,
  open_gate: undefined as Promise<void> | undefined,
  slack_nango: undefined as object | undefined,
  openrouter_credential_file: undefined as string | undefined,
  staging_synthetic_meetings_directory: undefined as string | undefined,
  staging_synthetic_owner_email: undefined as string | undefined,
  ask_journey_telemetry: undefined as object | undefined,
  core_runtime_observation: undefined as CoreRuntimeObservationScopeV1 | undefined,
  meeting_approval_journey_telemetry: undefined as object | undefined,
  staging_meeting_approval_journey_telemetry_enabled: undefined as
    | true
    | undefined,
  agentic_ask_v1_enabled: undefined as true | undefined,
  agentic_ask_v1_small_scope_shortcut: undefined as true | undefined,
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
    granola_credential_file: "/private/granola.credential",
    granola_owner_email_file: "/private/granola-owner-email",
    llm_credential_file: "/private/llm.credential",
    owner_email: "founder@example.com",
  }),
}));

vi.mock(
  "../src/composition/organization-authority-person-administration-cli.js",
  () => ({
    readPersonOidcConfiguration: () => ({
      client_authentication: "none",
      configuration: {},
    }),
  }),
);

vi.mock("../src/composition/organization-authority-composition-root.js", () => ({
  openOrganizationAuthorityService: async (config: {
    readonly on_worker_error?: WorkerErrorObserver;
    readonly on_worker_telemetry?: WorkerTelemetryObserver;
    readonly ask_journey_telemetry?: object;
    readonly core_runtime_observation?: CoreRuntimeObservationScopeV1;
    readonly meeting_approval_journey_telemetry?: {
      readonly approved_search_backlog_observer?: ApprovedSearchBacklogObserver;
    };
    readonly staging_meeting_approval_journey_telemetry_enabled?: true;
    readonly agentic_ask_v1_enabled?: true;
    readonly agentic_ask_v1_small_scope_shortcut?: true;
    readonly slack_nango: object;
    readonly openrouter_credential_file: string;
    readonly staging_synthetic_meetings_directory?: string;
    readonly staging_synthetic_owner_email?: string;
  }) => {
    if (runtimeState.open_gate !== undefined) await runtimeState.open_gate;
    if (runtimeState.startup_error !== undefined) throw runtimeState.startup_error;
    runtimeState.worker_error = config.on_worker_error;
    runtimeState.worker_telemetry = config.on_worker_telemetry;
    runtimeState.approved_search_backlog =
      config.meeting_approval_journey_telemetry
        ?.approved_search_backlog_observer;
    runtimeState.ask_journey_telemetry = config.ask_journey_telemetry;
    runtimeState.core_runtime_observation = config.core_runtime_observation;
    runtimeState.meeting_approval_journey_telemetry =
      config.meeting_approval_journey_telemetry;
    runtimeState.staging_meeting_approval_journey_telemetry_enabled =
      config.staging_meeting_approval_journey_telemetry_enabled;
    runtimeState.agentic_ask_v1_enabled = config.agentic_ask_v1_enabled;
    runtimeState.agentic_ask_v1_small_scope_shortcut =
      config.agentic_ask_v1_small_scope_shortcut;
    runtimeState.slack_nango = config.slack_nango;
    runtimeState.openrouter_credential_file = config.openrouter_credential_file;
    runtimeState.staging_synthetic_meetings_directory =
      config.staging_synthetic_meetings_directory;
    runtimeState.staging_synthetic_owner_email =
      config.staging_synthetic_owner_email;
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
    const actual =
      await importOriginal<
        typeof import("../src/composition/staging/observability/staging-journey-telemetry-transport-v1.js")
      >();
    return {
      ...actual,
      createStagingJourneyTelemetryTransportFromEnvironmentV1(
        environment: Readonly<Record<string, string | undefined>>,
        dependencies: Parameters<
          typeof actual.createStagingJourneyTelemetryTransportFromEnvironmentV1
        >[1],
        vocabulary: Parameters<typeof actual.createStagingJourneyTelemetryTransportFromEnvironmentV1>[2],
      ) {
        const transport =
          actual.createStagingJourneyTelemetryTransportFromEnvironmentV1(
            environment,
            dependencies,
            vocabulary,
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

const { runOrganizationAuthorityServiceCli } =
  await import("../src/composition/organization-authority-service-cli.js");

afterEach(() => {
  delete process.env.ECHO_STAGING_JOURNEY_TELEMETRY_V1;
  delete process.env.ECHO_STAGING_JOURNEY_CONTENT_TELEMETRY_V1;
  delete process.env.ECHO_STAGING_SYNTHETIC_MEETINGS_DIR;
  delete process.env.ECHO_AGENTIC_ASK_V1;
  delete process.env.ECHO_AGENTIC_ASK_SMALL_SCOPE_SHORTCUT;
  delete process.env.ECHO_BUILD_NUMBER;
  delete process.env.ECHO_SOURCE_SHA;
  runtimeState.worker_error = undefined;
  runtimeState.worker_telemetry = undefined;
  runtimeState.approved_search_backlog = undefined;
  runtimeState.startup_error = undefined;
  runtimeState.open_gate = undefined;
  runtimeState.slack_nango = undefined;
  runtimeState.openrouter_credential_file = undefined;
  runtimeState.staging_synthetic_meetings_directory = undefined;
  runtimeState.staging_synthetic_owner_email = undefined;
  runtimeState.ask_journey_telemetry = undefined;
  runtimeState.meeting_approval_journey_telemetry = undefined;
  runtimeState.staging_meeting_approval_journey_telemetry_enabled = undefined;
  runtimeState.agentic_ask_v1_enabled = undefined;
  runtimeState.agentic_ask_v1_small_scope_shortcut = undefined;
  runtimeState.authority_url = "https://authority.example";
  runtimeState.processing = "active";
  runtimeState.shutdown_events = [];
  runtimeState.runtime_close_gate = undefined;
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const temporaryRoots: string[] = [];
const NANGO_KEY = "nango-secret-key-0000-never-printed-0000";

function nangoKeyFile(mode = 0o600): string {
  const root = mkdtempSync(join(tmpdir(), "echo-service-cli-nango-"));
  temporaryRoots.push(root);
  const path = join(root, "nango-secret-key");
  writeFileSync(path, NANGO_KEY, { mode });
  chmodSync(path, mode);
  return path;
}

function start(
  io: { readonly stderr: (value: string) => void },
  stateDirectory = "/private/state",
  nango: readonly string[] = ["--nango-secret-key-file", nangoKeyFile(), "--nango-integration", "slack"],
) {
  return runOrganizationAuthorityServiceCli(
    [
      "serve",
      "--state-dir",
      stateDirectory,
      "--host",
      "127.0.0.1",
      "--port",
      "43179",
      ...nango,
    ],
    { stdout: () => undefined, ...io },
  );
}

describe("admitted runtime CLI events", () => {
  it("serves agentic Ask without a flag and passes the shortcut only when it is switched on", async () => {
    for (const input of [
      { agentic: undefined, shortcut: undefined },
      { agentic: "false", shortcut: "true" },
      { agentic: "true", shortcut: undefined },
      { agentic: "true", shortcut: "false" },
      { agentic: "true", shortcut: "true" },
      { agentic: undefined, shortcut: "true" },
    ]) {
      if (input.agentic === undefined) delete process.env.ECHO_AGENTIC_ASK_V1;
      else process.env.ECHO_AGENTIC_ASK_V1 = input.agentic;
      if (input.shortcut === undefined) {
        delete process.env.ECHO_AGENTIC_ASK_SMALL_SCOPE_SHORTCUT;
      } else {
        process.env.ECHO_AGENTIC_ASK_SMALL_SCOPE_SHORTCUT = input.shortcut;
      }
      const running = start({ stderr: () => undefined });
      await vi.waitFor(() => expect(runtimeState.worker_error).toBeDefined());
      // ECHO_AGENTIC_ASK_V1 is retired (ADR-0022): older profiles still set it, to no effect.
      expect(runtimeState.agentic_ask_v1_enabled).toBeUndefined();
      expect(runtimeState.agentic_ask_v1_small_scope_shortcut).toBe(
        input.shortcut === "true" ? true : undefined,
      );
      process.emit("SIGTERM");
      await expect(running).resolves.toBe(0);
      runtimeState.worker_error = undefined;
    }
  });

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
    expect(runtimeState.approved_search_backlog).toBeDefined();
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
    expect(runtimeState.approved_search_backlog).toBeDefined();
    runtimeState.approved_search_backlog?.({
      observed_at: "2026-09-02T12:35:56.000Z",
      pending_count: 1,
      stuck_count: 0,
      oldest_age_ms: 60_000,
    });
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
    expect(
      stagingStderr
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find(
          (event) => event.kind === "echo-authority-approved-search-backlog-v1",
        ),
    ).toMatchObject({
      environment: "staging",
      pending_count: 1,
      stuck_count: 0,
      oldest_age_ms: 60_000,
    });

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

  it("writes content records to stderr only when the staging content switch is on", async () => {
    const releaseSha = "a".repeat(40);
    process.env.ECHO_STAGING_JOURNEY_TELEMETRY_V1 = "true";
    process.env.ECHO_SOURCE_SHA = releaseSha;
    process.env.ECHO_BUILD_NUMBER = "33689731778";
    runtimeState.authority_url = "https://authority-staging.echobrain.org";
    for (const enabled of [false, true]) {
      if (enabled) process.env.ECHO_STAGING_JOURNEY_CONTENT_TELEMETRY_V1 = "true";
      else delete process.env.ECHO_STAGING_JOURNEY_CONTENT_TELEMETRY_V1;
      runtimeState.worker_error = undefined;
      const stderr: string[] = [];
      const run = start({
        stderr: (value) => {
          stderr.push(value);
        },
      });
      await vi.waitFor(() => expect(runtimeState.worker_error).toBeDefined());
      // Ask content is the model request of each agentic step, captured under its span.
      const scope = runtimeState.core_runtime_observation;
      expect(scope).toBeDefined();
      await observeCoreRuntimeV1("ask_planner", async () => {
        captureCoreRuntimeContentV1("model_request", { question: "CONTENT-SWITCH-QUESTION" });
      }, scope);
      process.emit("SIGTERM");
      await expect(run).resolves.toBe(0);
      const records = stderr
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((event) => event.kind === "echo-authority-journey-content-v1");
      if (enabled) {
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          schema_version: 2,
          environment: "staging",
          workflow: "core_runtime",
          release_sha: releaseSha,
          build_number: 33_689_731_778,
          stage: "core_operation",
          content_kind: "model_request",
          truncated: false,
          content: JSON.stringify({ question: "CONTENT-SWITCH-QUESTION" }),
        });
      } else {
        expect(records).toHaveLength(0);
        expect(stderr.join("")).not.toContain("CONTENT-SWITCH-QUESTION");
      }
    }
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

  it("service CLI requires the Nango flags and never prints the key", async () => {
    const failure = `${canonicalJson({ schema_version: 1, kind: "echo-clean-live-startup-failed-v1" } as never)}\n`;
    const key = nangoKeyFile();
    for (const nango of [
      ["--nango-integration", "slack"],
      ["--nango-secret-key-file", key],
      ["--nango-secret-key-file", nangoKeyFile(0o644), "--nango-integration", "slack"],
      // The retired signing-secret flag is refused: the signing secret is in the app's credential bundle.
      ["--nango-secret-key-file", key, "--nango-integration", "slack", "--slack-signing-secret-file", "/private/slack-signing-secret"],
    ]) {
      const stderr: string[] = [];
      await expect(start({ stderr: (value) => stderr.push(value) }, "/private/state", nango)).resolves.toBe(1);
      expect(stderr).toEqual([failure]);
    }
    expect(runtimeState.slack_nango).toBeUndefined();

    runtimeState.startup_error = new Error(`Nango refused ${NANGO_KEY}`);
    const failed: string[] = [];
    await expect(start({ stderr: (value) => failed.push(value) })).resolves.toBe(1);
    expect(failed).toEqual([failure]);
    runtimeState.startup_error = undefined;

    const stderr: string[] = [];
    const running = start({ stderr: (value) => stderr.push(value) }, "/private/state", [
      "--nango-secret-key-file", key, "--nango-integration", "slack", "--nango-base-url", "https://nango.example",
    ]);
    await vi.waitFor(() => expect(runtimeState.slack_nango).toEqual({
      secret_key: NANGO_KEY, integration_key: "slack", base_url: "https://nango.example",
    }));
    process.emit("SIGTERM");
    await expect(running).resolves.toBe(0);
    expect(stderr.join("")).not.toContain(NANGO_KEY);
    expect(runtimeState.openrouter_credential_file).toBe("/private/llm.credential");

    const defaulted = start({ stderr: () => undefined });
    await vi.waitFor(() => expect(runtimeState.slack_nango).toEqual({ secret_key: NANGO_KEY, integration_key: "slack" }));
    process.emit("SIGTERM");
    await expect(defaulted).resolves.toBe(0);
  });

  it("selects the staging fixture source from the deployment environment", async () => {
    runtimeState.authority_url = "https://authority-staging.echobrain.org";
    process.env.ECHO_STAGING_SYNTHETIC_MEETINGS_DIR = "/echo-clean/meetings";
    const running = start({ stderr: () => undefined });

    await vi.waitFor(() =>
      expect(runtimeState.staging_synthetic_meetings_directory).toBe(
        "/echo-clean/meetings",
      ),
    );
    expect(runtimeState.staging_synthetic_owner_email).toBe(
      "founder@example.com",
    );
    process.emit("SIGTERM");
    await expect(running).resolves.toBe(0);
  });

  it("rejects a fixture source when the manifest points at a non-staging Authority", async () => {
    process.env.ECHO_STAGING_SYNTHETIC_MEETINGS_DIR = "/echo-clean/meetings";

    await expect(
      start({ stderr: () => undefined }),
    ).resolves.toBe(1);
    expect(runtimeState.worker_error).toBeUndefined();
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
    process.emit("SIGTERM");
    await expect(running).resolves.toBe(0);

    const output = stderr.join("");
    for (const sentinel of [
      "credential-sentinel",
      "note-sentinel",
      "prompt-sentinel",
      "answer-sentinel",
      "bearer-sentinel",
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
    ]);
    expect(output).not.toContain("127.0.0.1");
    expect(output).not.toContain("43179");
    expect(output).not.toContain("/private/");
  });
});
