import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { canonicalJson } from "@echo-brain/federation-protocol";
import { validateOrganizationAuthorityOrigin } from "@echo-brain/organization-api";

interface IssuedPersonOnboardingLoginGrant {
  readonly login_grant: string;
  readonly expires_at: string;
}

const MAX_PERSON_ONBOARDING_ARTIFACT_BYTES = 8 * 1024;

/**
 * A file adapter owns its own input rules rather than reaching across a layer
 * boundary for them. This repeats the Authority's canonical-email definition
 * deliberately, so the artifact writer can refuse a value it should never
 * serialize.
 */
const CANONICAL_PERSON_EMAIL =
  /^[a-z0-9](?:[a-z0-9_+%-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9_+%-]*[a-z0-9])?)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/;

function hasBoundedMailboxParts(value: string): boolean {
  const [localPart, domain] = value.split("@");
  return (
    localPart !== undefined &&
    domain !== undefined &&
    localPart.length <= 64 &&
    domain.length <= 253 &&
    domain.split(".").every((label) => label.length <= 63)
  );
}

function isCanonicalPersonEmail(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 3 ||
    value.length > 254 ||
    value !== value.trim() ||
    value !== value.toLowerCase() ||
    !CANONICAL_PERSON_EMAIL.test(value) ||
    !hasBoundedMailboxParts(value)
  ) {
    return false;
  }
  return true;
}

export interface PersonOnboardingInvitationV1 {
  schema_version: 1;
  kind: "echo-person-onboarding-invitation";
  authority_url: string;
  login_grant: string;
  expires_at: string;
}

/**
 * Version 2 deliberately changes the artifact version rather than extending
 * v1. Released v1 readers reject unknown keys, so a v1 artifact with an
 * additive `expected_email` field would strand recipients on older clients.
 */
export interface PersonOnboardingInvitationV2 {
  schema_version: 2;
  kind: "echo-person-onboarding-invitation";
  authority_url: string;
  login_grant: string;
  expires_at: string;
  /** The exact canonical work address selected for this one-time grant. */
  expected_email: string;
}

export type PersonOnboardingInvitation =
  | PersonOnboardingInvitationV1
  | PersonOnboardingInvitationV2;

export interface PersonOnboardingInvitationTarget {
  output_path: string;
  authority_url: string;
}

export interface ReservedPersonOnboardingInvitation extends PersonOnboardingInvitationTarget {
  descriptor: number | null;
  released: boolean;
}

function outputPath(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    !isAbsolute(value) ||
    resolve(value) !== value ||
    value === resolve("/")
  ) {
    throw new Error(
      "Person onboarding output path must be a normalized absolute path below root",
    );
  }
  return value;
}

function assertPrivateParent(path: string): void {
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

function assertOutputIsAbsent(path: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("Person onboarding output file already exists");
}

export function reservePersonOnboardingInvitationTarget(input: {
  output_path: string;
  authority_url: string;
}): ReservedPersonOnboardingInvitation {
  const path = outputPath(input.output_path);
  validateOrganizationAuthorityOrigin(input.authority_url);
  assertPrivateParent(path);
  assertOutputIsAbsent(path);
  const descriptor = openSync(
    path,
    fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_WRONLY |
      (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    fchmodSync(descriptor, 0o600);
  } catch (error) {
    try {
      closeSync(descriptor);
    } finally {
      try {
        unlinkSync(path);
        fsyncParent(path);
      } catch {}
    }
    throw error;
  }
  return {
    output_path: path,
    authority_url: input.authority_url,
    descriptor,
    released: false,
  };
}

function fsyncParent(path: string): void {
  const descriptor = openSync(dirname(path), fsConstants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function discardPersonOnboardingInvitation(
  reservation: ReservedPersonOnboardingInvitation,
): void {
  if (reservation.released) return;
  reservation.released = true;
  try {
    if (reservation.descriptor !== null) {
      try {
        closeSync(reservation.descriptor);
      } catch {}
    }
  } finally {
    reservation.descriptor = null;
    try {
      unlinkSync(reservation.output_path);
      fsyncParent(reservation.output_path);
    } catch {}
  }
}

function serialize(value: PersonOnboardingInvitation): string {
  const serialized = `${canonicalJson(value)}\n`;
  if (
    Buffer.byteLength(serialized, "utf8") > MAX_PERSON_ONBOARDING_ARTIFACT_BYTES
  ) {
    throw new Error("Person onboarding artifact exceeds its size limit");
  }
  return serialized;
}

/** Writes the one-time bootstrap secret once, never to stdout or a replacement file. */
export function writePersonOnboardingInvitation(
  reservation: ReservedPersonOnboardingInvitation,
  issuedLoginGrant: IssuedPersonOnboardingLoginGrant,
  options?: { readonly expected_email?: string },
): PersonOnboardingInvitation {
  if (reservation.released || reservation.descriptor === null) {
    throw new Error("Person onboarding output reservation is unavailable");
  }
  const expectedEmail = options?.expected_email;
  if (expectedEmail !== undefined && !isCanonicalPersonEmail(expectedEmail)) {
    throw new Error("Person onboarding expected email is invalid");
  }
  const invitation: PersonOnboardingInvitation =
    expectedEmail === undefined
      ? {
          schema_version: 1,
          kind: "echo-person-onboarding-invitation",
          authority_url: reservation.authority_url,
          login_grant: issuedLoginGrant.login_grant,
          expires_at: issuedLoginGrant.expires_at,
        }
      : {
          schema_version: 2,
          kind: "echo-person-onboarding-invitation",
          authority_url: reservation.authority_url,
          login_grant: issuedLoginGrant.login_grant,
          expires_at: issuedLoginGrant.expires_at,
          expected_email: expectedEmail,
        };
  try {
    writeFileSync(reservation.descriptor, serialize(invitation), "utf8");
    fsyncSync(reservation.descriptor);
    closeSync(reservation.descriptor);
    reservation.descriptor = null;
    fsyncParent(reservation.output_path);
    reservation.released = true;
    return invitation;
  } catch (error) {
    discardPersonOnboardingInvitation(reservation);
    throw error;
  }
}
