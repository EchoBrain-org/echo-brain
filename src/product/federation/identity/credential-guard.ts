import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ToolConnectionGenerationV1 } from "../contracts.js";

const CREDENTIAL_GUARD_DOMAIN = Buffer.from(
  "echo-brain:local-credential-guard:v1\0",
  "utf8",
);
const DEFAULT_SALT_BYTES = 32;
const MIN_SALT_BYTES = 16;
const MAX_SALT_BYTES = 64;
const MAX_CREDENTIAL_BYTES = 64 * 1024;
const ENV_CREDENTIAL_REFERENCE = /^env:[A-Za-z][A-Za-z0-9_.-]*$/;
const FILE_CREDENTIAL_REFERENCE = /^file:\/[^\u0000]+$/u;

export type LocalCredentialGuardV1 =
  ToolConnectionGenerationV1["local_credential_guard"];

export class LocalCredentialGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalCredentialGuardError";
  }
}

function assertCredentialReference(reference: string): void {
  if (
    !ENV_CREDENTIAL_REFERENCE.test(reference) &&
    !FILE_CREDENTIAL_REFERENCE.test(reference)
  ) {
    throw new LocalCredentialGuardError(
      "credential reference must be an env: name or absolute file: path",
    );
  }
}

function credentialBytes(credential: string): Buffer {
  const value = Buffer.from(credential, "utf8");
  if (value.length === 0 || value.length > MAX_CREDENTIAL_BYTES) {
    throw new LocalCredentialGuardError(
      `credential must contain between 1 and ${MAX_CREDENTIAL_BYTES} bytes`,
    );
  }
  return value;
}

function canonicalSalt(saltBase64: string): Buffer {
  const salt = Buffer.from(saltBase64, "base64");
  if (
    salt.length < MIN_SALT_BYTES ||
    salt.length > MAX_SALT_BYTES ||
    salt.toString("base64") !== saltBase64
  ) {
    throw new LocalCredentialGuardError(
      `credential guard salt must be canonical base64 containing ${MIN_SALT_BYTES}-${MAX_SALT_BYTES} bytes`,
    );
  }
  return salt;
}

function guardDigest(salt: Buffer, credential: Buffer): `sha256:${string}` {
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(credential.length);
  return `sha256:${createHash("sha256")
    .update(CREDENTIAL_GUARD_DOMAIN)
    .update(salt)
    .update(length)
    .update(credential)
    .digest("hex")}`;
}

/**
 * Create local-only credential replacement evidence. The credential is never
 * returned; the random salt and digest stay in the non-exported local registry.
 */
export function createLocalCredentialGuard(
  reference: string,
  credential: string,
  salt: Buffer = randomBytes(DEFAULT_SALT_BYTES),
): LocalCredentialGuardV1 {
  assertCredentialReference(reference);
  if (salt.length < MIN_SALT_BYTES || salt.length > MAX_SALT_BYTES) {
    throw new LocalCredentialGuardError(
      `credential guard salt must contain ${MIN_SALT_BYTES}-${MAX_SALT_BYTES} bytes`,
    );
  }
  const value = credentialBytes(credential);
  return {
    reference,
    algorithm: "sha256-salted",
    salt_base64: Buffer.from(salt).toString("base64"),
    digest: guardDigest(salt, value),
    exportable: false,
  };
}

/** Compare an exact resolved credential and reference to a stored local guard. */
export function matchesLocalCredentialGuard(
  guard: LocalCredentialGuardV1,
  reference: string,
  credential: string,
): boolean {
  assertCredentialReference(reference);
  if (
    guard.algorithm !== "sha256-salted" ||
    guard.exportable !== false ||
    guard.reference !== reference ||
    !/^sha256:[0-9a-f]{64}$/.test(guard.digest)
  ) {
    return false;
  }
  const expected = guardDigest(
    canonicalSalt(guard.salt_base64),
    credentialBytes(credential),
  );
  return timingSafeEqual(Buffer.from(expected), Buffer.from(guard.digest));
}

export function assertLocalCredentialGuard(
  guard: LocalCredentialGuardV1,
): void {
  assertCredentialReference(guard.reference);
  canonicalSalt(guard.salt_base64);
  if (
    guard.algorithm !== "sha256-salted" ||
    guard.exportable !== false ||
    !/^sha256:[0-9a-f]{64}$/.test(guard.digest)
  ) {
    throw new LocalCredentialGuardError(
      "credential guard has an unsupported shape",
    );
  }
}

export function assertLocalCredentialGuardMatches(
  guard: LocalCredentialGuardV1,
  reference: string,
  credential: string,
): void {
  if (!matchesLocalCredentialGuard(guard, reference, credential)) {
    throw new LocalCredentialGuardError(
      "credential material or reference no longer matches the active connection generation",
    );
  }
}
