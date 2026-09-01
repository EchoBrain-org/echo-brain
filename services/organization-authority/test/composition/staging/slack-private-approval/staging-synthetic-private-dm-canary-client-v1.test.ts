import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requestStagingSyntheticPrivateDmCanaryV1 } from "../../../../src/composition/staging/slack-private-approval/staging-synthetic-private-dm-canary-client-v1.js";

const RELEASE_ID = "clean-v1-staging-canary";
const directories: string[] = [];
const servers: Server[] = [];

async function withSocket(
  body: string,
  options: Readonly<{ status?: number; content_type?: string }> = {},
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "echo-canary-client-"));
  directories.push(directory);
  const socketPath = join(directory, "control.sock");
  const server = createServer((request, response) => {
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/v1/run");
    expect(request.headers["content-length"]).toBe("0");
    request.resume();
    response.writeHead(options.status ?? 200, {
      "content-type": options.content_type ?? "application/json; charset=utf-8",
    });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  servers.push(server);
  return socketPath;
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) =>
              error === undefined ? resolve() : reject(error),
            ),
          ),
      ),
  );
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("staging synthetic private-DM canary client", () => {
  it.each(["staged", "quarantined"] as const)(
    "uses only the private socket and returns a bounded %s receipt",
    async (approvalOutcome) => {
    const socket_path = await withSocket(
      JSON.stringify({
        schema_version: 1,
        kind: "echo-staging-synthetic-private-dm-canary-receipt-v1",
        release_id: RELEASE_ID,
        approval_outcome: approvalOutcome,
        approval_id: "apr_private",
      }),
    );

    await expect(
      requestStagingSyntheticPrivateDmCanaryV1({
        release_id: RELEASE_ID,
        socket_path,
      }),
    ).resolves.toEqual({
      schema_version: 1,
      kind: "echo-staging-synthetic-private-dm-canary-receipt-v1",
      release_id: RELEASE_ID,
      approval_outcome: approvalOutcome,
      approval_id: "apr_private",
    });
    },
  );

  it("refuses a receipt for another release or a non-success socket response", async () => {
    const wrong_release_socket = await withSocket(
      JSON.stringify({
        schema_version: 1,
        kind: "echo-staging-synthetic-private-dm-canary-receipt-v1",
        release_id: "clean-v1-other-release",
        approval_outcome: "not_actionable",
      }),
    );
    await expect(
      requestStagingSyntheticPrivateDmCanaryV1({
        release_id: RELEASE_ID,
        socket_path: wrong_release_socket,
      }),
    ).rejects.toThrow("receipt is invalid");

    const failure_socket = await withSocket("{}", { status: 500 });
    await expect(
      requestStagingSyntheticPrivateDmCanaryV1({
        release_id: RELEASE_ID,
        socket_path: failure_socket,
      }),
    ).rejects.toThrow("receipt is invalid");
  });

  it("rejects an oversized private-socket response without waiting for timeout", async () => {
    const oversized_socket = await withSocket("x".repeat(1_025));
    await expect(
      requestStagingSyntheticPrivateDmCanaryV1({
        release_id: RELEASE_ID,
        socket_path: oversized_socket,
      }),
    ).rejects.toThrow("receipt is invalid");
  });
});
