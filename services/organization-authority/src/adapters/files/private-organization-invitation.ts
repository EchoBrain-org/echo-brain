import { randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  MAX_ENROLLMENT_GRANT_LIFETIME_SECONDS,
  validateIssuedOrganizationEnrollmentGrant,
  validateOrganizationAuthorityOrigin,
  validateOrganizationEnrollmentInvitation,
} from '@echo-brain/organization-api';
import type { OrganizationEnrollmentInvitationV1 } from '@echo-brain/organization-api';
import { canonicalJson } from '@echo-brain/federation-protocol';
import { organizationEnrollmentGrantSha256 } from '@echo-brain/organization-protocol';

/** Maximum durable secret-envelope size accepted from disk. */
const MAX_INVITATION_ENVELOPE_BYTES = 32 * 1024;
const UUID_V4_SOURCE =
  '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const AUTHORITY_ID_PATTERN = new RegExp(`^oau_${UUID_V4_SOURCE}$`);
const ORGANIZATION_ID_PATTERN = new RegExp(`^org_${UUID_V4_SOURCE}$`);
const MEMBERSHIP_ID_PATTERN = new RegExp(`^mem_${UUID_V4_SOURCE}$`);
const COMMAND_ID_PATTERN = new RegExp(`^adm_${UUID_V4_SOURCE}$`);
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export type OrganizationInvitationEnvelopeV1 =
  OrganizationEnrollmentInvitationV1;

export interface PrepareOrganizationInvitationOptions {
  output_path: string;
  authority_base_url: string;
  authority_id: string;
  authority_pin_sha256: `sha256:${string}`;
  organization_id: string;
  membership_id: string;
  lifetime_seconds: number;
  command_id?: string;
  random_bytes?: (size: number) => Uint8Array;
  random_uuid?: () => string;
}

interface InvitationFileIdentity {
  dev: number;
  ino: number;
}

export interface PreparedOrganizationInvitation {
  output_path: string;
  envelope: OrganizationInvitationEnvelopeV1;
  file_identity: InvitationFileIdentity;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertCanonicalId(
  value: unknown,
  pattern: RegExp,
  label: string,
): asserts value is string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${label} must be a canonical identifier`);
  }
}

function validateOutputPath(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    !isAbsolute(value) ||
    resolve(value) !== value ||
    value === resolve('/')
  ) {
    throw new Error(
      'invitation output path must be a normalized absolute path below root',
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
      'invitation output parent must be a current-user 0700 canonical directory',
    );
  }
}

function assertPrivateEnvelopeFile(path: string): Stats {
  const state = lstatSync(path);
  const currentUid = process.getuid?.();
  if (
    state.isSymbolicLink() ||
    !state.isFile() ||
    state.size <= 0 ||
    state.size > MAX_INVITATION_ENVELOPE_BYTES ||
    (currentUid !== undefined && state.uid !== currentUid) ||
    (state.mode & 0o777) !== 0o600 ||
    realpathSync(path) !== path
  ) {
    throw new Error(
      'invitation envelope must be a bounded current-user 0600 canonical file',
    );
  }
  return state;
}

function sameFile(
  state: Pick<Stats, 'dev' | 'ino'>,
  identity: InvitationFileIdentity,
): boolean {
  return state.dev === identity.dev && state.ino === identity.ino;
}

function assertCanonicalAuthorityOrigin(
  value: unknown,
): asserts value is string {
  validateOrganizationAuthorityOrigin(value);
}

function validateEnvelope(value: unknown): OrganizationInvitationEnvelopeV1 {
  return validateOrganizationEnrollmentInvitation(value);
}

function validateAgainstRequest(
  envelope: OrganizationInvitationEnvelopeV1,
  options: PrepareOrganizationInvitationOptions,
): void {
  if (
    envelope.authority_base_url !== options.authority_base_url ||
    envelope.authority_id !== options.authority_id ||
    envelope.authority_pin_sha256 !== options.authority_pin_sha256 ||
    envelope.organization_id !== options.organization_id ||
    envelope.membership_id !== options.membership_id ||
    envelope.lifetime_seconds !== options.lifetime_seconds ||
    (options.command_id !== undefined &&
      envelope.command_id !== options.command_id)
  ) {
    throw new Error(
      'existing invitation envelope does not match the requested invitation',
    );
  }
}

function readEnvelope(path: string): PreparedOrganizationInvitation {
  assertPrivateParent(path);
  const state = assertPrivateEnvelopeFile(path);
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const file = openSync(path, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(file);
    if (!sameFile(opened, state)) {
      throw new Error('invitation envelope changed while opening');
    }
    const raw = readFileSync(file, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new Error('invitation envelope is not valid JSON');
    }
    const envelope = validateEnvelope(parsed);
    if (`${canonicalJson(envelope)}\n` !== raw) {
      throw new Error('invitation envelope is not canonically encoded');
    }
    return {
      output_path: path,
      envelope,
      file_identity: { dev: opened.dev, ino: opened.ino },
    };
  } finally {
    closeSync(file);
  }
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function fsyncParent(path: string): void {
  const directory = openSync(dirname(path), fsConstants.O_RDONLY);
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function serializeEnvelope(envelope: OrganizationInvitationEnvelopeV1): string {
  const serialized = `${canonicalJson(envelope)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_INVITATION_ENVELOPE_BYTES) {
    throw new Error('invitation envelope exceeds its size limit');
  }
  return serialized;
}

function writeEnvelopeExclusive(
  path: string,
  envelope: OrganizationInvitationEnvelopeV1,
): void {
  assertPrivateParent(path);
  const preparedPath = join(
    dirname(path),
    `.${basename(path)}.publishing-${randomBytes(16).toString('hex')}`,
  );
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const file = openSync(
    preparedPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow,
    0o600,
  );
  try {
    fchmodSync(file, 0o600);
    writeFileSync(file, serializeEnvelope(envelope), 'utf8');
    fsyncSync(file);
  } catch (error) {
    closeSync(file);
    try {
      unlinkSync(preparedPath);
    } catch {}
    throw error;
  }
  closeSync(file);
  try {
    linkSync(preparedPath, path);
    fsyncParent(path);
  } finally {
    try {
      unlinkSync(preparedPath);
    } catch {}
  }
}

function replaceEnvelope(
  prepared: PreparedOrganizationInvitation,
  envelope: OrganizationInvitationEnvelopeV1,
): void {
  const path = prepared.output_path;
  assertPrivateParent(path);
  const current = assertPrivateEnvelopeFile(path);
  if (!sameFile(current, prepared.file_identity)) {
    throw new Error('invitation envelope changed before issuance was recorded');
  }

  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.issuing-${randomUUID()}`,
  );
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const temporary = openSync(
    temporaryPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow,
    0o600,
  );
  let temporaryExists = true;
  let temporaryOpen = true;
  try {
    try {
      fchmodSync(temporary, 0o600);
      writeFileSync(temporary, serializeEnvelope(envelope), 'utf8');
      fsyncSync(temporary);
    } finally {
      temporaryOpen = false;
      closeSync(temporary);
    }
    const beforeReplace = assertPrivateEnvelopeFile(path);
    if (!sameFile(beforeReplace, prepared.file_identity)) {
      throw new Error(
        'invitation envelope changed before issuance was recorded',
      );
    }
    renameSync(temporaryPath, path);
    temporaryExists = false;
    fsyncParent(path);
  } finally {
    if (temporaryOpen) {
      try {
        closeSync(temporary);
      } catch {}
    }
    if (temporaryExists) {
      try {
        unlinkSync(temporaryPath);
      } catch {}
    }
  }
}

export function prepareOrganizationInvitation(
  options: PrepareOrganizationInvitationOptions,
): PreparedOrganizationInvitation {
  const outputPath = validateOutputPath(options.output_path);
  assertCanonicalAuthorityOrigin(options.authority_base_url);
  assertCanonicalId(options.authority_id, AUTHORITY_ID_PATTERN, 'authority_id');
  assertCanonicalId(
    options.organization_id,
    ORGANIZATION_ID_PATTERN,
    'organization_id',
  );
  assertCanonicalId(
    options.membership_id,
    MEMBERSHIP_ID_PATTERN,
    'membership_id',
  );
  if (!DIGEST_PATTERN.test(options.authority_pin_sha256)) {
    throw new Error('authority pin must be a canonical SHA-256 digest');
  }
  if (
    !Number.isSafeInteger(options.lifetime_seconds) ||
    options.lifetime_seconds <= 0 ||
    options.lifetime_seconds > MAX_ENROLLMENT_GRANT_LIFETIME_SECONDS
  ) {
    throw new Error(
      `invitation lifetime must be from 1 through ${MAX_ENROLLMENT_GRANT_LIFETIME_SECONDS} seconds`,
    );
  }
  if (options.command_id !== undefined) {
    assertCanonicalId(options.command_id, COMMAND_ID_PATTERN, 'command_id');
  }
  assertPrivateParent(outputPath);

  try {
    const existing = readEnvelope(outputPath);
    validateAgainstRequest(existing.envelope, options);
    return existing;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }

  const commandId =
    options.command_id ?? `adm_${(options.random_uuid ?? randomUUID)()}`;
  assertCanonicalId(commandId, COMMAND_ID_PATTERN, 'command_id');
  const generatedGrant = (options.random_bytes ?? randomBytes)(32);
  if (
    !(generatedGrant instanceof Uint8Array) ||
    generatedGrant.byteLength !== 32
  ) {
    throw new Error('invitation grant generator returned invalid bytes');
  }
  const grant = Buffer.from(generatedGrant);
  const envelope: OrganizationInvitationEnvelopeV1 = {
    schema_version: 1,
    kind: 'echo-organization-enrollment-invitation',
    status: 'pending_registration',
    authority_base_url: options.authority_base_url,
    authority_id: options.authority_id,
    authority_pin_sha256: options.authority_pin_sha256,
    authority_pin_verification: 'independent_pin_required',
    organization_id: options.organization_id,
    membership_id: options.membership_id,
    command_id: commandId,
    enrollment_grant_sha256: organizationEnrollmentGrantSha256(grant),
    enrollment_grant_base64url: grant.toString('base64url'),
    lifetime_seconds: options.lifetime_seconds,
    issued: null,
  };

  try {
    writeEnvelopeExclusive(outputPath, envelope);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
  }
  const prepared = readEnvelope(outputPath);
  validateAgainstRequest(prepared.envelope, options);
  return prepared;
}

export function recordOrganizationInvitationIssued(
  prepared: PreparedOrganizationInvitation,
  value: unknown,
): OrganizationInvitationEnvelopeV1 {
  const issued = validateIssuedOrganizationEnrollmentGrant(value);
  const intent = prepared.envelope;
  if (
    issued.authority_id !== intent.authority_id ||
    issued.authority_pin_sha256 !== intent.authority_pin_sha256 ||
    issued.organization_id !== intent.organization_id ||
    issued.membership_id !== intent.membership_id ||
    issued.enrollment_grant_sha256 !== intent.enrollment_grant_sha256
  ) {
    throw new Error('issued invitation does not match the prepared invitation');
  }

  const current = readEnvelope(prepared.output_path);
  if (current.envelope.status === 'issued') {
    if (canonicalJson(current.envelope.issued) !== canonicalJson(issued)) {
      throw new Error('issued invitation conflicts with its saved envelope');
    }
    return current.envelope;
  }
  if (
    !sameFile(current.file_identity, prepared.file_identity) ||
    canonicalJson(current.envelope) !== canonicalJson(intent)
  ) {
    throw new Error('invitation envelope changed before issuance was recorded');
  }

  const completed = validateOrganizationEnrollmentInvitation({
    ...intent,
    status: 'issued',
    issued,
  });
  replaceEnvelope(current, completed);
  const recorded = readEnvelope(prepared.output_path);
  if (canonicalJson(recorded.envelope) !== canonicalJson(completed)) {
    throw new Error('invitation issuance was not saved safely');
  }
  return recorded.envelope;
}
