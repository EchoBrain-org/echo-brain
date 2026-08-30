import { mkdtemp, lstat, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openStagingSyntheticPrivateDmCanaryControlV1,
  STAGING_SYNTHETIC_PRIVATE_DM_CANARY_AUTHORITY_ORIGIN_V1,
} from "../../src/composition/staging-synthetic-private-dm-canary-control-v1.js";
import type { OpenedOrganizationAuthorityRuntime } from "../../src/composition/organization-authority-runtime.js";
import { createStagingSyntheticMeetingCanaryV1 } from "../../src/processing/clean-v1/staging-synthetic-meeting-canary-v1.js";

const RELEASE_ID = "clean-v1-staging-canary";
const OWNER_EMAIL = "founder@example.com";
const directories: string[] = [];
type CanaryRun = NonNullable<
  OpenedOrganizationAuthorityRuntime["run_staging_synthetic_private_dm_canary"]
>;

async function socketPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "echo-canary-control-"));
  directories.push(directory);
  return join(directory, "control.sock");
}

async function post(
  socket_path: string,
  path = "/v1/run",
): Promise<{
  readonly status: number;
  readonly body: string;
}> {
  return new Promise((resolve, reject) => {
    const client = request(
      { socketPath: socket_path, path, method: "POST" },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode!, body }),
        );
      },
    );
    client.once("error", reject);
    client.end();
  });
}

function runtime(
  runCanary: CanaryRun,
): Pick<
  OpenedOrganizationAuthorityRuntime,
  "run_staging_synthetic_private_dm_canary"
> {
  return { run_staging_synthetic_private_dm_canary: runCanary };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("staging synthetic private-DM canary control", () => {
  it("refuses every origin except the exact staging Authority origin", async () => {
    await expect(
      openStagingSyntheticPrivateDmCanaryControlV1({
        authority_url: "https://authority.echobrain.org",
        authority_host: "authority.echobrain.org",
        release_id: RELEASE_ID,
        owner_email: OWNER_EMAIL,
        runtime: runtime(async () => ({
          kind: "staged",
          approval_id: "apr_test",
          stage_id: "stage_test",
          reused_frozen_extraction: false,
        })),
        socket_path: await socketPath(),
      }),
    ).rejects.toThrow("staging-only");
    await expect(
      openStagingSyntheticPrivateDmCanaryControlV1({
        authority_url: STAGING_SYNTHETIC_PRIVATE_DM_CANARY_AUTHORITY_ORIGIN_V1,
        authority_host: "authority-staging.example.com",
        release_id: RELEASE_ID,
        owner_email: OWNER_EMAIL,
        runtime: runtime(async () => ({
          kind: "staged",
          approval_id: "apr_test",
          stage_id: "stage_test",
          reused_frozen_extraction: false,
        })),
        socket_path: await socketPath(),
      }),
    ).rejects.toThrow("host is invalid");
  });

  it("never unlinks a non-socket file when recovering a stale path", async () => {
    const unsafe_path = await socketPath();
    await writeFile(unsafe_path, "not a socket", "utf8");
    await expect(
      openStagingSyntheticPrivateDmCanaryControlV1({
        authority_url: STAGING_SYNTHETIC_PRIVATE_DM_CANARY_AUTHORITY_ORIGIN_V1,
        authority_host: "authority-staging.echobrain.org",
        release_id: RELEASE_ID,
        owner_email: OWNER_EMAIL,
        runtime: runtime(async () => ({
          kind: "staged",
          approval_id: "apr_test",
          stage_id: "stage_test",
          reused_frozen_extraction: false,
        })),
        socket_path: unsafe_path,
      }),
    ).rejects.toThrow("socket path is unsafe");
    expect((await lstat(unsafe_path)).isFile()).toBe(true);
  });

  it("accepts the longest canonical clean-v1 release id as its canary id", () => {
    const release_id = `clean-v1-${"a".repeat(64)}`;
    expect(() =>
      createStagingSyntheticMeetingCanaryV1({
        canary_id: release_id,
        owner_email: OWNER_EMAIL,
        observed_at: "2026-08-30T12:00:00.000Z",
      }),
    ).not.toThrow();
  });

  it("derives its stable canary id and owner from live startup state, not the request", async () => {
    const calls: unknown[] = [];
    const control = await openStagingSyntheticPrivateDmCanaryControlV1({
      authority_url: STAGING_SYNTHETIC_PRIVATE_DM_CANARY_AUTHORITY_ORIGIN_V1,
      authority_host: "authority-staging.echobrain.org",
      release_id: RELEASE_ID,
      owner_email: OWNER_EMAIL,
      runtime: runtime(async (input) => {
        calls.push(input);
        return {
          kind: "staged",
          approval_id: "apr_private",
          stage_id: "stage_private",
          reused_frozen_extraction: false,
        };
      }),
      socket_path: await socketPath(),
      now: () => "2026-08-30T12:00:00.000Z",
    });

    const response = await post(control.socket_path);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      schema_version: 1,
      kind: "echo-staging-synthetic-private-dm-canary-receipt-v1",
      release_id: RELEASE_ID,
      approval_outcome: "staged",
      approval_id: "apr_private",
    });
    expect(response.body).not.toContain(OWNER_EMAIL);
    expect(calls).toEqual([
      {
        canary_id: RELEASE_ID,
        owner_email: OWNER_EMAIL,
        observed_at: "2026-08-30T12:00:00.000Z",
      },
    ]);
    await control.close();
  });

  it("sends duplicate requests through the same stable canary id and cleans up its private socket", async () => {
    const ids: string[] = [];
    const socket_path = await socketPath();
    const control = await openStagingSyntheticPrivateDmCanaryControlV1({
      authority_url: STAGING_SYNTHETIC_PRIVATE_DM_CANARY_AUTHORITY_ORIGIN_V1,
      authority_host: "authority-staging.echobrain.org",
      release_id: RELEASE_ID,
      owner_email: OWNER_EMAIL,
      runtime: runtime(async (input) => {
        ids.push(input.canary_id);
        return {
          kind: "staged",
          approval_id: "apr_test",
          stage_id: "stage_test",
          reused_frozen_extraction: ids.length > 1,
        };
      }),
      socket_path,
    });

    expect((await lstat(socket_path)).mode & 0o777).toBe(0o600);
    const [first, second] = await Promise.all([
      post(socket_path),
      post(socket_path),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(ids).toEqual([RELEASE_ID, RELEASE_ID]);
    await control.close();
    await expect(lstat(socket_path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("aborts a canary that exceeds the control request deadline", async () => {
    let observedSignal: AbortSignal | undefined;
    const control = await openStagingSyntheticPrivateDmCanaryControlV1({
      authority_url: STAGING_SYNTHETIC_PRIVATE_DM_CANARY_AUTHORITY_ORIGIN_V1,
      authority_host: "authority-staging.echobrain.org",
      release_id: RELEASE_ID,
      owner_email: OWNER_EMAIL,
      runtime: runtime(async (_input, options) => {
        observedSignal = options?.signal;
        return await new Promise((_, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            {
              once: true,
            },
          );
        });
      }),
      socket_path: await socketPath(),
      operation_timeout_ms: 5,
    });

    expect((await post(control.socket_path)).status).toBe(500);
    expect(observedSignal?.aborted).toBe(true);
    await control.close();
  });

  it("does not receipt a successful canary result after its deadline", async () => {
    let observedSignal: AbortSignal | undefined;
    const control = await openStagingSyntheticPrivateDmCanaryControlV1({
      authority_url: STAGING_SYNTHETIC_PRIVATE_DM_CANARY_AUTHORITY_ORIGIN_V1,
      authority_host: "authority-staging.echobrain.org",
      release_id: RELEASE_ID,
      owner_email: OWNER_EMAIL,
      runtime: runtime(async (_input, options) => {
        observedSignal = options?.signal;
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        return {
          kind: "staged",
          approval_id: "apr_late",
          stage_id: "stage_late",
          reused_frozen_extraction: false,
        };
      }),
      socket_path: await socketPath(),
      operation_timeout_ms: 5,
    });

    const response = await post(control.socket_path);
    expect(response.status).toBe(500);
    expect(observedSignal?.aborted).toBe(true);
    await control.close();
  });

  it("returns at its deadline while a queued canary waits behind prior work", async () => {
    let releasePreceding!: () => void;
    const preceding = new Promise<void>((resolve) => {
      releasePreceding = resolve;
    });
    let observeAbort!: () => void;
    const aborted = new Promise<void>((resolve) => {
      observeAbort = resolve;
    });
    let queuedRun: ReturnType<CanaryRun> | undefined;
    let sideEffects = 0;
    const control = await openStagingSyntheticPrivateDmCanaryControlV1({
      authority_url: STAGING_SYNTHETIC_PRIVATE_DM_CANARY_AUTHORITY_ORIGIN_V1,
      authority_host: "authority-staging.echobrain.org",
      release_id: RELEASE_ID,
      owner_email: OWNER_EMAIL,
      runtime: runtime((_input, options) => {
        options?.signal?.addEventListener("abort", observeAbort, {
          once: true,
        });
        queuedRun = preceding.then(() => {
          options?.signal?.throwIfAborted();
          sideEffects += 1;
          return {
            kind: "staged",
            approval_id: "apr_queued",
            stage_id: "stage_queued",
            reused_frozen_extraction: false,
          };
        });
        return queuedRun;
      }),
      socket_path: await socketPath(),
      operation_timeout_ms: 5,
    });

    const response = post(control.socket_path);
    await aborted;
    expect((await response).status).toBe(500);
    expect(sideEffects).toBe(0);

    releasePreceding();
    await expect(queuedRun).rejects.toBeInstanceOf(Error);
    expect(sideEffects).toBe(0);
    await control.close();
  });

  it("aborts in-flight canary work before closing its socket", async () => {
    let observedSignal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    const control = await openStagingSyntheticPrivateDmCanaryControlV1({
      authority_url: STAGING_SYNTHETIC_PRIVATE_DM_CANARY_AUTHORITY_ORIGIN_V1,
      authority_host: "authority-staging.echobrain.org",
      release_id: RELEASE_ID,
      owner_email: OWNER_EMAIL,
      runtime: runtime(async (_input, options) => {
        observedSignal = options?.signal;
        markStarted();
        return await new Promise((_, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            {
              once: true,
            },
          );
        });
      }),
      socket_path: await socketPath(),
    });

    const pending = post(control.socket_path).catch(() => undefined);
    await started;
    await control.close();
    expect(observedSignal?.aborted).toBe(true);
    await pending;
  });
});
