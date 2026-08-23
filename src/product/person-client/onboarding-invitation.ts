import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { canonicalJson } from "@echo-brain/federation-protocol";
import { validateOrganizationAuthorityOrigin } from "@echo-brain/organization-api";

const MAXIMUM_INVITATION_BYTES = 8 * 1024;
const LOGIN_GRANT_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface PersonOnboardingInvitationV1 {
  readonly schema_version: 1;
  readonly kind: "echo-person-onboarding-invitation";
  readonly authority_url: string;
  readonly login_grant: string;
  readonly expires_at: string;
}

function invitationPath(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    !isAbsolute(value) ||
    resolve(value) !== value ||
    value === resolve("/")
  ) {
    throw new Error("Person onboarding invitation path must be absolute");
  }
  return value;
}

function assertPrivateOutputParent(path: string): void {
  const parent = dirname(path);
  const state = lstatSync(parent);
  const currentUid = process.getuid?.();
  if (
    state.isSymbolicLink() ||
    !state.isDirectory() ||
    realpathSync(parent) !== parent ||
    (currentUid !== undefined && state.uid !== currentUid) ||
    (state.mode & 0o777) !== 0o700
  ) {
    throw new Error(
      "Person onboarding output parent must be a current-user 0700 canonical directory",
    );
  }
}

function fsyncParent(path: string): void {
  const descriptor = openSync(dirname(path), constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Checks local output safety before any Authority request. The later O_EXCL
 * write remains authoritative: a rare race is recoverable by reissuing.
 */
export function preflightPersonOnboardingInvitationOutput(inputPath: string): string {
  const path = invitationPath(inputPath);
  assertPrivateOutputParent(path);
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return path;
    throw error;
  }
  throw new Error("Person onboarding invitation output already exists");
}

function validate(value: unknown): PersonOnboardingInvitationV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Person onboarding invitation is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
      "authority_url,expires_at,kind,login_grant,schema_version" ||
    record.schema_version !== 1 ||
    record.kind !== "echo-person-onboarding-invitation" ||
    typeof record.authority_url !== "string" ||
    typeof record.login_grant !== "string" ||
    typeof record.expires_at !== "string"
  ) {
    throw new Error("Person onboarding invitation is invalid");
  }
  try {
    validateOrganizationAuthorityOrigin(record.authority_url);
  } catch {
    throw new Error("Person onboarding invitation Authority URL is invalid");
  }
  if (
    !LOGIN_GRANT_PATTERN.test(record.login_grant) ||
    Buffer.from(record.login_grant, "base64url").length !== 32 ||
    !Number.isFinite(Date.parse(record.expires_at)) ||
    new Date(Date.parse(record.expires_at)).toISOString() !== record.expires_at
  ) {
    throw new Error("Person onboarding invitation is invalid");
  }
  return Object.freeze({
    schema_version: 1,
    kind: "echo-person-onboarding-invitation",
    authority_url: record.authority_url,
    login_grant: record.login_grant,
    expires_at: record.expires_at,
  });
}

/** Reads the Authority-neutral, one-time bootstrap artifact without printing it. */
export function readPersonOnboardingInvitation(
  inputPath: string,
): PersonOnboardingInvitationV1 {
  const path = invitationPath(inputPath);
  const before = lstatSync(path);
  const currentUid = process.getuid?.();
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.size <= 0 ||
    before.size > MAXIMUM_INVITATION_BYTES ||
    realpathSync(path) !== path ||
    (currentUid !== undefined && before.uid !== currentUid) ||
    (before.mode & 0o777) !== 0o600
  ) {
    throw new Error(
      "Person onboarding invitation must be a bounded current-user 0600 canonical file",
    );
  }
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("Person onboarding invitation changed while opening");
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      bytes.byteLength !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    ) {
      throw new Error("Person onboarding invitation changed while reading");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      throw new Error("Person onboarding invitation is not valid JSON");
    }
    const invitation = validate(parsed);
    if (`${canonicalJson(invitation)}\n` !== bytes.toString("utf8")) {
      throw new Error(
        "Person onboarding invitation is not canonically encoded",
      );
    }
    return invitation;
  } finally {
    closeSync(descriptor);
  }
}

/** Writes a new invitation once into an explicitly private, non-replaced file. */
export function writePersonOnboardingInvitation(
  inputPath: string,
  value: PersonOnboardingInvitationV1,
): void {
  const path = invitationPath(inputPath);
  assertPrivateOutputParent(path);
  const invitation = validate(value);
  const bytes = `${canonicalJson(invitation)}\n`;
  if (Buffer.byteLength(bytes, "utf8") > MAXIMUM_INVITATION_BYTES) {
    throw new Error("Person onboarding invitation exceeds its size limit");
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, bytes, "utf8");
    fsyncSync(descriptor);
  } catch (error) {
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  fsyncParent(path);
}
