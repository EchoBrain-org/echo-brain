import { canonicalJson } from "./canonical-json.js";
import type { Sha256Digest } from "./contracts.js";
import type {
  InstallationKeyDescriptor,
  InstallationSigner,
} from "./installation-signer.js";
import { verifyInstallationKeyDescriptor } from "./installation-signer.js";
import { spawnBundledProductHelper } from "../spawn-sanitized-child.js";

const MAX_HELPER_OUTPUT_BYTES = 1024 * 1024;
const HELPER_TIMEOUT_MS = 30_000;

type HelperRequest =
  | {
      schema_version: 1;
      command: "create" | "describe";
      installation_id: string;
    }
  | {
      schema_version: 1;
      command: "sign";
      installation_id: string;
      expected_key_id: Sha256Digest;
      message_base64: string;
    }
  | {
      schema_version: 1;
      command: "delete";
      installation_id: string;
      expected_key_id: Sha256Digest;
    };

interface HelperResponse {
  schema_version: 1;
  ok: boolean;
  descriptor?: InstallationKeyDescriptor | null;
  signature_base64?: string;
  deleted?: boolean;
  error?: { code: string; message: string };
}

function parseHelperResponse(raw: string): HelperResponse {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(
      `installation signer returned invalid JSON: ${(error as Error).message}`,
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("installation signer returned a non-object response");
  }
  const response = value as Partial<HelperResponse>;
  if (response.schema_version !== 1 || typeof response.ok !== "boolean") {
    throw new Error("installation signer returned an unsupported response");
  }
  return response as HelperResponse;
}

async function invokeHelper(request: HelperRequest): Promise<HelperResponse> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error(
      `signer_unavailable: Secure Enclave helper requires darwin/arm64; observed ${process.platform}/${process.arch}`,
    );
  }
  const child = spawnBundledProductHelper("installation-signer");
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let settled = false;
  const result = await new Promise<HelperResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
      reject(new Error("installation signer timed out"));
    }, HELPER_TIMEOUT_MS);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    child.on("error", (error) => fail(error));
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_HELPER_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        fail(new Error("installation signer output exceeded its limit"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_HELPER_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        fail(new Error("installation signer output exceeded its limit"));
        return;
      }
      stderr.push(chunk);
    });
    child.on("close", (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (status !== 0) {
        reject(
          new Error(
            `installation signer failed (${status ?? signal ?? "unknown"}): ${Buffer.concat(stderr).toString("utf8").trim()}`,
          ),
        );
        return;
      }
      try {
        resolve(parseHelperResponse(Buffer.concat(stdout).toString("utf8")));
      } catch (error) {
        reject(error as Error);
      }
    });
    child.stdin.on("error", (error) => fail(error));
    child.stdin.end(`${canonicalJson(request)}\n`);
  });
  if (!result.ok) {
    throw new Error(
      `${result.error?.code ?? "signer_failed"}: ${result.error?.message ?? "installation signer rejected the operation"}`,
    );
  }
  return result;
}

function requireDescriptor(
  response: HelperResponse,
  installationId: string,
): InstallationKeyDescriptor {
  const descriptor = response.descriptor;
  if (descriptor === undefined || descriptor === null) {
    throw new Error("installation signer did not return a key descriptor");
  }
  if (descriptor.installation_id !== installationId) {
    throw new Error(
      "installation signer returned a descriptor for another installation",
    );
  }
  verifyInstallationKeyDescriptor(descriptor);
  if (
    descriptor.protection !== "secure-enclave" ||
    descriptor.assurance !== "hardware_bound"
  ) {
    throw new Error("seed-grade identity requires a Secure Enclave key");
  }
  return descriptor;
}

export class MacOsSecureEnclaveInstallationSigner implements InstallationSigner {
  async generate(installationId: string): Promise<InstallationKeyDescriptor> {
    return requireDescriptor(
      await invokeHelper({
        schema_version: 1,
        command: "create",
        installation_id: installationId,
      }),
      installationId,
    );
  }

  async inspect(
    installationId: string,
  ): Promise<InstallationKeyDescriptor | null> {
    const response = await invokeHelper({
      schema_version: 1,
      command: "describe",
      installation_id: installationId,
    });
    if (response.descriptor === null) return null;
    return requireDescriptor(response, installationId);
  }

  async sign(
    installationId: string,
    message: Buffer,
    expectedKeyId?: Sha256Digest,
  ): Promise<Buffer> {
    if (expectedKeyId === undefined) {
      throw new Error(
        "installation signing requires the expected key fingerprint",
      );
    }
    const response = await invokeHelper({
      schema_version: 1,
      command: "sign",
      installation_id: installationId,
      expected_key_id: expectedKeyId,
      message_base64: message.toString("base64"),
    });
    const encoded = response.signature_base64;
    if (encoded === undefined)
      throw new Error("installation signer omitted its signature");
    const signature = Buffer.from(encoded, "base64");
    if (signature.length === 0 || signature.toString("base64") !== encoded) {
      throw new Error(
        "installation signer returned non-canonical signature base64",
      );
    }
    return signature;
  }

  async deleteOrphan(
    installationId: string,
    expectedKeyId: Sha256Digest,
  ): Promise<boolean> {
    const response = await invokeHelper({
      schema_version: 1,
      command: "delete",
      installation_id: installationId,
      expected_key_id: expectedKeyId,
    });
    if (typeof response.deleted !== "boolean") {
      throw new Error("installation signer omitted its delete result");
    }
    return response.deleted;
  }
}
