import { request } from "node:http";
import { STAGING_SYNTHETIC_PRIVATE_DM_CANARY_SOCKET_V1 } from "./staging-synthetic-private-dm-canary-control-v1.js";

const RELEASE_ID = /^clean-v1-[a-z0-9][a-z0-9-]{2,63}$/;
const APPROVAL_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_RECEIPT_BYTES = 1_024;
const REQUEST_TIMEOUT_MS = 120_000;
const OUTCOMES = new Set([
  "staged",
  "delivery_pending",
  "not_actionable",
  "not_staged",
]);

export type StagingSyntheticPrivateDmCanaryReceiptV1 =
  | Readonly<{
      schema_version: 1;
      kind: "echo-staging-synthetic-private-dm-canary-receipt-v1";
      release_id: string;
      approval_outcome: "not_actionable";
    }>
  | Readonly<{
      schema_version: 1;
      kind: "echo-staging-synthetic-private-dm-canary-receipt-v1";
      release_id: string;
      approval_outcome: "staged" | "delivery_pending" | "not_staged";
      approval_id: string;
    }>;

function invalidReceipt(): never {
  throw new Error("staging synthetic canary receipt is invalid");
}

function parseReceipt(
  body: string,
  expectedReleaseId: string,
): StagingSyntheticPrivateDmCanaryReceiptV1 {
  if (Buffer.byteLength(body, "utf8") > MAX_RECEIPT_BYTES) invalidReceipt();
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    invalidReceipt();
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    invalidReceipt();
  const receipt = raw as Record<string, unknown>;
  if (
    receipt.schema_version !== 1 ||
    receipt.kind !== "echo-staging-synthetic-private-dm-canary-receipt-v1" ||
    receipt.release_id !== expectedReleaseId ||
    !OUTCOMES.has(receipt.approval_outcome as string)
  ) {
    invalidReceipt();
  }
  if (receipt.approval_outcome === "not_actionable") {
    if (
      Object.keys(receipt).length !== 4 ||
      Object.keys(receipt).some(
        (key) =>
          !new Set([
            "schema_version",
            "kind",
            "release_id",
            "approval_outcome",
          ]).has(key),
      )
    ) {
      invalidReceipt();
    }
    return Object.freeze({
      schema_version: 1,
      kind: "echo-staging-synthetic-private-dm-canary-receipt-v1",
      release_id: expectedReleaseId,
      approval_outcome: "not_actionable",
    });
  }
  if (
    Object.keys(receipt).length !== 5 ||
    Object.keys(receipt).some(
      (key) =>
        !new Set([
          "schema_version",
          "kind",
          "release_id",
          "approval_outcome",
          "approval_id",
        ]).has(key),
    ) ||
    typeof receipt.approval_id !== "string" ||
    !APPROVAL_ID.test(receipt.approval_id)
  ) {
    invalidReceipt();
  }
  return Object.freeze({
    schema_version: 1,
    kind: "echo-staging-synthetic-private-dm-canary-receipt-v1",
    release_id: expectedReleaseId,
    approval_outcome: receipt.approval_outcome as
      "staged" | "delivery_pending" | "not_staged",
    approval_id: receipt.approval_id,
  });
}

/**
 * The only client of the private staging canary socket. It neither opens the
 * Authority runtime nor reads its databases; the long-lived runtime owns both
 * and derives the canary identity from its accepted release environment.
 */
export async function requestStagingSyntheticPrivateDmCanaryV1(
  input: Readonly<{
    release_id: string;
    /** Test seam. Production always uses the fixed unmounted socket path. */
    socket_path?: string;
  }>,
): Promise<StagingSyntheticPrivateDmCanaryReceiptV1> {
  if (!RELEASE_ID.test(input.release_id))
    throw new Error("staging synthetic canary release id is invalid");
  const socketPath =
    input.socket_path ?? STAGING_SYNTHETIC_PRIVATE_DM_CANARY_SOCKET_V1;
  return new Promise((resolve, reject) => {
    const client = request(
      {
        socketPath,
        path: "/v1/run",
        method: "POST",
        headers: { "content-length": "0" },
      },
      (response) => {
        let body = "";
        let bytes = 0;
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          bytes += Buffer.byteLength(chunk, "utf8");
          if (bytes > MAX_RECEIPT_BYTES) {
            reject(new Error("staging synthetic canary receipt is invalid"));
            response.destroy();
            client.destroy();
            return;
          }
          body += chunk;
        });
        response.once("error", () =>
          reject(new Error("staging synthetic canary unavailable")),
        );
        response.once("end", () => {
          try {
            if (
              response.statusCode !== 200 ||
              response.headers["content-type"] !==
                "application/json; charset=utf-8" ||
              bytes > MAX_RECEIPT_BYTES
            ) {
              invalidReceipt();
            }
            resolve(parseReceipt(body, input.release_id));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    client.setTimeout(REQUEST_TIMEOUT_MS, () =>
      client.destroy(new Error("staging synthetic canary timed out")),
    );
    client.once("error", () =>
      reject(new Error("staging synthetic canary unavailable")),
    );
    client.end();
  });
}
