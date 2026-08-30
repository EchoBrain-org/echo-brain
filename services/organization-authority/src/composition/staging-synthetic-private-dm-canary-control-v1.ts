import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { OpenedCleanLiveRuntime } from "./open-clean-live-runtime.js";

export const STAGING_SYNTHETIC_PRIVATE_DM_CANARY_SOCKET_V1 =
  "/echo-runtime/authority-staging-private-dm-canary-v1.sock";

export const STAGING_SYNTHETIC_PRIVATE_DM_CANARY_AUTHORITY_ORIGIN_V1 =
  "https://authority-staging.echobrain.org";
const RELEASE_ID = /^clean-v1-[a-z0-9][a-z0-9-]{2,63}$/;
const STAGING_AUTHORITY_HOST = "authority-staging.echobrain.org";
const CONTROL_PATH = "/v1/stage";

export interface StagingSyntheticPrivateDmCanaryControlV1 {
  readonly socket_path: string;
  close(): Promise<void>;
}

export interface OpenStagingSyntheticPrivateDmCanaryControlV1Input {
  readonly authority_url: string;
  readonly authority_host: string;
  readonly release_id: string;
  readonly owner_email: string;
  readonly runtime: Pick<
    OpenedCleanLiveRuntime,
    "stage_staging_synthetic_private_dm_canary"
  >;
  /** A focused test seam. Production uses the fixed non-mounted runtime path. */
  readonly socket_path?: string;
  readonly now?: () => string;
}

type ApprovalOutcome =
  "staged" | "delivery_pending" | "not_actionable" | "not_staged";

function assertStagingControlInput(
  input: OpenStagingSyntheticPrivateDmCanaryControlV1Input,
): void {
  if (
    input.authority_url !==
    STAGING_SYNTHETIC_PRIVATE_DM_CANARY_AUTHORITY_ORIGIN_V1
  ) {
    throw new Error("staging synthetic private-DM control is staging-only");
  }
  if (input.authority_host !== STAGING_AUTHORITY_HOST) {
    throw new Error("staging synthetic private-DM control host is invalid");
  }
  if (!RELEASE_ID.test(input.release_id)) {
    throw new Error(
      "staging synthetic private-DM control release id is invalid",
    );
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.owner_email)) {
    throw new Error("staging synthetic private-DM control owner is invalid");
  }
  if (input.runtime.stage_staging_synthetic_private_dm_canary === undefined) {
    throw new Error(
      "staging synthetic private-DM control requires active processing",
    );
  }
}

function removeStaleSocket(socketPath: string): void {
  try {
    const state = lstatSync(socketPath);
    if (!state.isSocket()) {
      throw new Error(
        "staging synthetic private-DM control socket path is unsafe",
      );
    }
    unlinkSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function noContent(response: ServerResponse): void {
  response.writeHead(204, { "cache-control": "no-store" });
  response.end();
}

function receipt(
  response: ServerResponse,
  releaseId: string,
  result: Awaited<
    ReturnType<
      NonNullable<
        OpenedCleanLiveRuntime["stage_staging_synthetic_private_dm_canary"]
      >
    >
  >,
): void {
  const body = Buffer.from(
    JSON.stringify({
      schema_version: 1,
      kind: "echo-staging-synthetic-private-dm-canary-receipt-v1",
      release_id: releaseId,
      approval_outcome: result.kind as ApprovalOutcome,
      ...(result.kind === "not_actionable"
        ? {}
        : { approval_id: result.approval_id }),
    }),
    "utf8",
  );
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-length": String(body.byteLength),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(body);
}

function badRequest(response: ServerResponse): void {
  response.writeHead(400, {
    "cache-control": "no-store",
    "content-length": "0",
  });
  response.end();
}

function internalError(response: ServerResponse): void {
  response.writeHead(500, {
    "cache-control": "no-store",
    "content-length": "0",
  });
  response.end();
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

/**
 * Opens the staging rehearsal trigger only on a Unix socket inside the
 * Authority container. Caddy has no filesystem access to this socket, so it
 * cannot become a public route; SSM plus Docker access is the operator gate.
 */
export async function openStagingSyntheticPrivateDmCanaryControlV1(
  input: OpenStagingSyntheticPrivateDmCanaryControlV1Input,
): Promise<StagingSyntheticPrivateDmCanaryControlV1> {
  assertStagingControlInput(input);
  const socketPath =
    input.socket_path ?? STAGING_SYNTHETIC_PRIVATE_DM_CANARY_SOCKET_V1;
  removeStaleSocket(socketPath);
  const stage = input.runtime.stage_staging_synthetic_private_dm_canary!;
  const now = input.now ?? (() => new Date().toISOString());
  const server = createServer(async (request, response) => {
    const method = request.method ?? "";
    const path = new URL(request.url ?? "/", "http://localhost");
    if (
      method !== "POST" ||
      path.pathname !== CONTROL_PATH ||
      path.search !== ""
    ) {
      noContent(response);
      return;
    }
    if (request.headers["transfer-encoding"] !== undefined) {
      badRequest(response);
      request.resume();
      return;
    }
    if (request.headers["content-length"] !== undefined) {
      const length = Number(request.headers["content-length"]);
      if (!Number.isSafeInteger(length) || length !== 0) {
        badRequest(response);
        request.resume();
        return;
      }
    }
    request.resume();
    try {
      const result = await stage({
        canary_id: input.release_id,
        owner_email: input.owner_email,
        observed_at: now(),
      });
      receipt(response, input.release_id, result);
    } catch {
      internalError(response);
    }
  });
  try {
    await listen(server, socketPath);
    chmodSync(socketPath, 0o600);
  } catch (error) {
    await close(server).catch(() => undefined);
    try {
      removeStaleSocket(socketPath);
    } catch {
      // Preserve the original open failure.
    }
    throw error;
  }
  return Object.freeze({
    socket_path: socketPath,
    close: async () => {
      await close(server);
      removeStaleSocket(socketPath);
    },
  });
}
