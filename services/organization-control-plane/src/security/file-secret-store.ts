import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  AUTHORITY_FILE_SECRET_BACKEND,
  type OrganizationSecretReference,
  type OrganizationSecretStore,
} from '../application/contracts.js';

const MAXIMUM_SECRET_BYTES = 16 * 1024;
const SECRET_HANDLE_PATTERN = /^sch_[0-9a-f-]{36}$/;
const SECRET_FILE_PATTERN = /^(sch_[0-9a-f-]{36})\.secret$/;

function fsyncDirectory(path: string): void {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const descriptor = openSync(path, fsConstants.O_RDONLY | noFollow);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function assertPrivateDirectory(path: string): void {
  const state = lstatSync(path);
  const currentUid = process.getuid?.();
  if (
    state.isSymbolicLink() ||
    !state.isDirectory() ||
    realpathSync(path) !== path ||
    (currentUid !== undefined && state.uid !== currentUid) ||
    (state.mode & 0o777) !== 0o700
  ) {
    throw new Error(
      'organization integration secret directory must be a current-user 0700 canonical directory',
    );
  }
}

function normalizeSecret(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAXIMUM_SECRET_BYTES ||
    value.includes('\0') ||
    value.trim() !== value
  ) {
    throw new Error('organization integration secret is invalid');
  }
  return value;
}

export class FileOrganizationSecretStore implements OrganizationSecretStore {
  private readonly directory: string;

  constructor(directory: string) {
    if (resolve(directory) !== directory) {
      throw new Error(
        'organization integration secret directory must be an absolute normalized path',
      );
    }
    const existed = existsSync(directory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!existed) chmodSync(directory, 0o700);
    assertPrivateDirectory(directory);
    // Persist both the directory inode and its parent's namespace entry before
    // any opaque handle is returned. Repeating these syncs also lets a retry
    // finish a prior attempt whose durability outcome was uncertain.
    fsyncDirectory(directory);
    fsyncDirectory(dirname(directory));
    this.directory = directory;
  }

  private path(reference: OrganizationSecretReference): string {
    if (
      reference.secret_backend_id !== AUTHORITY_FILE_SECRET_BACKEND ||
      !SECRET_HANDLE_PATTERN.test(reference.secret_handle_id)
    ) {
      throw new Error('organization integration secret reference is invalid');
    }
    return join(this.directory, `${reference.secret_handle_id}.secret`);
  }

  create(secret: string): OrganizationSecretReference {
    const normalized = normalizeSecret(secret);
    const reference: OrganizationSecretReference = {
      secret_backend_id: AUTHORITY_FILE_SECRET_BACKEND,
      secret_handle_id: `sch_${randomUUID()}`,
    };
    const path = this.path(reference);
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    const descriptor = openSync(
      path,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY |
        noFollow,
      0o600,
    );
    const failures: unknown[] = [];
    try {
      writeFileSync(descriptor, normalized, 'utf8');
      fsyncSync(descriptor);
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        closeSync(descriptor);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 0) {
      try {
        // fsync(file) persists bytes; fsync(directory) persists the new name.
        fsyncDirectory(this.directory);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      try {
        unlinkSync(path);
        fsyncDirectory(this.directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          failures.push(error);
        }
      }
      if (failures.length === 1) throw failures[0];
      throw new AggregateError(
        failures,
        'organization integration secret could not be created durably',
      );
    }
    return Object.freeze(reference);
  }

  read(reference: OrganizationSecretReference): string {
    const path = this.path(reference);
    const state = lstatSync(path);
    const currentUid = process.getuid?.();
    if (
      state.isSymbolicLink() ||
      !state.isFile() ||
      state.size <= 0 ||
      state.size > MAXIMUM_SECRET_BYTES ||
      realpathSync(path) !== path ||
      (currentUid !== undefined && state.uid !== currentUid) ||
      (state.mode & 0o777) !== 0o600
    ) {
      throw new Error(
        'organization integration secret must be a bounded current-user 0600 canonical file',
      );
    }
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    const descriptor = openSync(path, fsConstants.O_RDONLY | noFollow);
    try {
      const opened = fstatSync(descriptor);
      if (opened.dev !== state.dev || opened.ino !== state.ino) {
        throw new Error(
          'organization integration secret changed while opening',
        );
      }
      return normalizeSecret(readFileSync(descriptor, 'utf8'));
    } finally {
      closeSync(descriptor);
    }
  }

  listReferences(): readonly OrganizationSecretReference[] {
    assertPrivateDirectory(this.directory);
    return Object.freeze(
      readdirSync(this.directory)
        .map((entry) => SECRET_FILE_PATTERN.exec(entry)?.[1])
        .filter((handle): handle is string => handle !== undefined)
        .sort()
        .map((secret_handle_id) =>
          Object.freeze({
            secret_backend_id: AUTHORITY_FILE_SECRET_BACKEND,
            secret_handle_id,
          }),
        ),
    );
  }

  remove(reference: OrganizationSecretReference): void {
    const path = this.path(reference);
    let removed = false;
    try {
      unlinkSync(path);
      removed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (removed) fsyncDirectory(this.directory);
  }
}
