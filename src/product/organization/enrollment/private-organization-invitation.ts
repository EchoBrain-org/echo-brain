import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import {
  validateOrganizationEnrollmentInvitation,
  type OrganizationEnrollmentInvitationV1,
} from '@echo-brain/organization-api';
import { canonicalJson } from '@echo-brain/federation-protocol';
import { assertNoPermissiveDarwinAcl } from '../../secure-local-files.js';

const MAX_INVITATION_ENVELOPE_BYTES = 32 * 1024;

function assertNormalizedAbsolutePath(path: string): void {
  if (
    path.length === 0 ||
    path.includes('\0') ||
    !isAbsolute(path) ||
    resolve(path) !== path ||
    path === resolve('/')
  ) {
    throw new Error(
      'organization invitation path must be a normalized absolute path below root',
    );
  }
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
      'organization invitation parent must be a current-user 0700 canonical directory',
    );
  }
  assertNoPermissiveDarwinAcl(parent, 'organization invitation parent');
}

function assertPrivateFile(path: string): Stats {
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
      'organization invitation must be a bounded current-user 0600 canonical file',
    );
  }
  assertNoPermissiveDarwinAcl(path, 'organization invitation');
  return state;
}

function sameFile(
  left: Pick<Stats, 'dev' | 'ino' | 'size'>,
  right: Pick<Stats, 'dev' | 'ino' | 'size'>,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size
  );
}

/**
 * Reads the secret-bearing invitation without following symlinks or accepting
 * permissive file modes. The raw grant is returned only inside the validated
 * invitation and remains caller-owned transient input.
 */
export function readPrivateOrganizationEnrollmentInvitation(
  path: string,
): OrganizationEnrollmentInvitationV1 {
  assertNormalizedAbsolutePath(path);
  assertPrivateParent(path);
  const state = assertPrivateFile(path);
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const file = openSync(path, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(file);
    if (!sameFile(opened, state)) {
      throw new Error('organization invitation changed while opening');
    }
    const raw = readFileSync(file, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new Error('organization invitation is not valid JSON');
    }
    const invitation = validateOrganizationEnrollmentInvitation(parsed);
    if (`${canonicalJson(invitation)}\n` !== raw) {
      throw new Error('organization invitation is not canonically encoded');
    }
    return invitation;
  } finally {
    closeSync(file);
  }
}
