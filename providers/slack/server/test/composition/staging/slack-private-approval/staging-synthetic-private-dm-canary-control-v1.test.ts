import { mkdtemp, lstat, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStagingSyntheticPrivateDmCanaryControlV1, STAGING_SYNTHETIC_PRIVATE_DM_CANARY_AUTHORITY_ORIGIN_V1 } from "../../../../src/composition/staging/slack-private-approval/staging-synthetic-private-dm-canary-control-v1.js";
import type { OpenedOrganizationAuthorityRuntime } from "../../../../../../../services/organization-authority/src/composition/organization-authority-runtime.js";

const RELEASE_ID = "clean-v1-staging-canary";
const directories: string[] = [];
type CanaryRun = NonNullable<
  OpenedOrganizationAuthorityRuntime["run_staging_synthetic_canary"]
>;

async function socketPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "echo-canary-control-"));
  directories.push(directory);
  return join(directory, "control.sock");
}

async function post(socket_path: string): Promise<{
  readonly status: number;
  readonly body: string;
}> {
  return new Promise((resolve, reject) => {
    const client = request(
      { socketPath: socket_path, path: "/v1/run", method: "POST" },
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

async function open(
  runCanary: CanaryRun,
  extra: Partial<Parameters<typeof openStagingSyntheticPrivateDmCanaryControlV1>[0]> = {},
) {
  return openStagingSyntheticPrivateDmCanaryControlV1({
    authority_url: STAGING_SYNTHETIC_PRIVATE_DM_CANARY_AUTHORITY_ORIGIN_V1,
    authority_host: "authority-staging.echobrain.org",
    release_id: RELEASE_ID,
    runtime: { run_staging_synthetic_canary: runCanary },
    socket_path: extra.socket_path ?? (await socketPath()),
    ...extra,
  });
}

function untilAborted(options: Parameters<CanaryRun>[1]): Promise<never> {
  return new Promise((_, reject) => {
    options?.signal?.addEventListener(
      "abort",
      () => reject(options.signal?.reason),
      {
        once: true,
      },
    );
  });
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
    const staged: CanaryRun = async () => ({ kind: "staged", approval_id: "apr_test" });
    await expect(
      open(staged, {
        authority_url: "https://authority.echobrain.org",
        authority_host: "authority.echobrain.org",
      }),
    ).rejects.toThrow("staging-only");
    await expect(
      open(staged, {
        authority_url: STAGING_SYNTHETIC_PRIVATE_DM_CANARY_AUTHORITY_ORIGIN_V1,
        authority_host: "authority-staging.example.com",
      }),
    ).rejects.toThrow("host is invalid");
  });

  it("never unlinks a non-socket file when recovering a stale path", async () => {
    const unsafe_path = await socketPath();
    await writeFile(unsafe_path, "not a socket", "utf8");
    await expect(
      open(async () => ({ kind: "staged", approval_id: "apr_test" }), { socket_path: unsafe_path }),
    ).rejects.toThrow("socket path is unsafe");
    expect((await lstat(unsafe_path)).isFile()).toBe(true);
  });

  it.each([
    [{ kind: "staged", approval_id: "apr_private" }, { approval_outcome: "staged", approval_id: "apr_private" }],
    [{ kind: "not_staged", approval_id: "apr_private" }, { approval_outcome: "not_staged", approval_id: "apr_private" }],
    [{ kind: "not_actionable", approval_id: null }, { approval_outcome: "not_actionable" }],
  ] as const)("receipts the runtime's canary outcome %j for the startup release", async (outcome, fields) => {
    const releases: string[] = [];
    const control = await open(async (release) => { releases.push(release); return outcome; });

    const response = await post(control.socket_path);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      schema_version: 1,
      kind: "echo-staging-synthetic-private-dm-canary-receipt-v1",
      release_id: RELEASE_ID,
      ...fields,
    });
    // The canary is bound to the release the runtime started with.
    expect(releases).toEqual([RELEASE_ID]);
    await control.close();
  });

  it("serves duplicate requests and cleans up its private socket", async () => {
    let runs = 0;
    const socket_path = await socketPath();
    const control = await open(async () => {
      runs += 1;
      return { kind: "staged", approval_id: "apr_test" };
    }, { socket_path });

    expect((await lstat(socket_path)).mode & 0o777).toBe(0o600);
    const [first, second] = await Promise.all([
      post(socket_path),
      post(socket_path),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(JSON.parse(first.body)).toEqual(JSON.parse(second.body));
    expect(runs).toBe(2);
    await control.close();
    await expect(lstat(socket_path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["rejects on abort", untilAborted],
    ["resolves successfully on abort", async (options: Parameters<CanaryRun>[1]) => {
      await new Promise<void>((resolve) => {
        options?.signal?.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
      return { kind: "staged" as const, approval_id: "apr_late" };
    }],
  ])("aborts and does not receipt a canary that %s after the control request deadline", async (_label, behave) => {
    let observedSignal: AbortSignal | undefined;
    const control = await open(async (_release, options) => {
      observedSignal = options?.signal;
      return await behave(options);
    }, { operation_timeout_ms: 5 });

    expect((await post(control.socket_path)).status).toBe(500);
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
    const control = await open((_release, options) => {
      options?.signal?.addEventListener("abort", observeAbort, {
        once: true,
      });
      queuedRun = preceding.then(() => {
        options?.signal?.throwIfAborted();
        sideEffects += 1;
        return { kind: "staged" as const, approval_id: "apr_queued" };
      });
      return queuedRun;
    }, { operation_timeout_ms: 5 });

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
    const control = await open(async (_release, options) => {
      observedSignal = options?.signal;
      markStarted();
      return await untilAborted(options);
    });

    const pending = post(control.socket_path).catch(() => undefined);
    await started;
    await control.close();
    expect(observedSignal?.aborted).toBe(true);
    await pending;
  });
});
