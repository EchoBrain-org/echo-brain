import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  validateOrganizationPersonSession,
  type OrganizationPersonSessionV2,
} from '@echo-brain/organization-api';

const MAXIMUM_SESSION_FILE_BYTES = 64 * 1024;
const SESSION_DIRECTORY_PARTS = [
  '.local',
  'share',
  'echo-brain',
  'person',
] as const;

export interface StoredPersonClientSessionV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-person-client-session';
  readonly authority_origin: string;
  readonly authority_id: string;
  readonly session: OrganizationPersonSessionV2;
}

export interface PersonSessionStorePaths {
  readonly directory: string;
  readonly live: string;
  readonly refreshing: string;
  readonly refresh_claim: string;
  readonly logging_out: string;
  readonly logout_claim: string;
}

export interface PersonSessionRefreshClaim {
  readonly claim_id: string;
  readonly stored: StoredPersonClientSessionV1;
}

export class PersonClientSessionUnavailableError extends Error {
  constructor(message = 'Person session is unavailable; sign in again') {
    super(message);
    this.name = 'PersonClientSessionUnavailableError';
  }
}

export function personSessionStorePaths(
  homeDirectory: string,
): PersonSessionStorePaths {
  if (
    !isAbsolute(homeDirectory) ||
    resolve(homeDirectory) !== homeDirectory ||
    homeDirectory === resolve('/')
  ) {
    throw new Error('Person client home directory must be an absolute path');
  }
  const directory = join(homeDirectory, ...SESSION_DIRECTORY_PARTS);
  return Object.freeze({
    directory,
    live: join(directory, 'session.v1.json'),
    refreshing: join(directory, 'session.v1.refreshing.json'),
    refresh_claim: join(directory, 'session.v1.refresh.claim'),
    logging_out: join(directory, 'session.v1.logging-out.json'),
    logout_claim: join(directory, 'session.v1.logout.claim'),
  });
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
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
      'Person session directory must be a current-user 0700 canonical directory',
    );
  }
}

function ensurePrivateDirectory(path: string): void {
  const existed = existsSync(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!existed) fsyncDirectory(resolve(path, '..'));
  assertPrivateDirectory(path);
}

function assertPrivateFile(path: string): void {
  const state = lstatSync(path);
  const currentUid = process.getuid?.();
  if (
    state.isSymbolicLink() ||
    !state.isFile() ||
    state.size <= 0 ||
    state.size > MAXIMUM_SESSION_FILE_BYTES ||
    realpathSync(path) !== path ||
    (currentUid !== undefined && state.uid !== currentUid) ||
    (state.mode & 0o777) !== 0o600
  ) {
    throw new Error(
      'Person session file must be a bounded current-user 0600 canonical file',
    );
  }
}

function readPrivateFile(path: string): string {
  assertPrivateFile(path);
  const before = lstatSync(path);
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('Person session file changed while opening');
    }
    const value = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      value.byteLength === 0 ||
      value.byteLength > MAXIMUM_SESSION_FILE_BYTES ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new Error('Person session file changed while reading');
    }
    return value.toString('utf8');
  } finally {
    closeSync(descriptor);
  }
}

function exactAuthorityOrigin(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Person session Authority origin is invalid');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Person session Authority origin is invalid');
  }
  if (
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        (url.hostname === '127.0.0.1' || url.hostname === '[::1]')
      )) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    (url.pathname !== '' && url.pathname !== '/')
  ) {
    throw new Error(
      'Person session Authority origin must be one HTTPS or development loopback origin',
    );
  }
  url.pathname = '/';
  return url.origin;
}

function storedSession(value: unknown): StoredPersonClientSessionV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Person session store is invalid');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',') !==
      'authority_id,authority_origin,kind,schema_version,session' ||
    record.schema_version !== 1 ||
    record.kind !== 'echo-person-client-session'
  ) {
    throw new Error('Person session store is invalid');
  }
  if (
    typeof record.authority_id !== 'string' ||
    !/^oau_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      record.authority_id,
    )
  ) {
    throw new Error('Person session Authority ID is invalid');
  }
  return Object.freeze({
    schema_version: 1,
    kind: 'echo-person-client-session',
    authority_origin: exactAuthorityOrigin(record.authority_origin),
    authority_id: record.authority_id,
    session: validateOrganizationPersonSession(record.session),
  });
}

function parseStoredSession(contents: string): StoredPersonClientSessionV1 {
  try {
    return storedSession(JSON.parse(contents) as unknown);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Person session')) {
      throw error;
    }
    throw new Error('Person session store is invalid', { cause: error });
  }
}

function removeIfPresent(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export class PersonSessionStore {
  readonly paths: PersonSessionStorePaths;

  constructor(homeDirectory: string) {
    this.paths = personSessionStorePaths(homeDirectory);
  }

  private writeLive(
    value: StoredPersonClientSessionV1,
    exclusive = false,
  ): void {
    ensurePrivateDirectory(this.paths.directory);
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
    if (bytes.byteLength > MAXIMUM_SESSION_FILE_BYTES) {
      throw new Error('Person session exceeds its private file bound');
    }
    const temporary = join(
      this.paths.directory,
      `.session.v1.${randomUUID()}.tmp`,
    );
    const descriptor = openSync(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    let installed = false;
    try {
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
      closeSync(descriptor);
      if (exclusive) {
        linkSync(temporary, this.paths.live);
        unlinkSync(temporary);
      } else {
        renameSync(temporary, this.paths.live);
      }
      fsyncDirectory(this.paths.directory);
      assertPrivateFile(this.paths.live);
      installed = true;
    } finally {
      if (!installed) {
        try {
          closeSync(descriptor);
        } catch {
          // The descriptor may already be closed after a later failure.
        }
        removeIfPresent(temporary);
      }
    }
  }

  private cleanupTransitions(): void {
    let changed = false;
    for (const path of [
      this.paths.refreshing,
      this.paths.refresh_claim,
      this.paths.logging_out,
      this.paths.logout_claim,
    ]) {
      changed = removeIfPresent(path) || changed;
    }
    if (changed) fsyncDirectory(this.paths.directory);
  }

  install(
    authorityOrigin: string,
    authorityId: string,
    session: OrganizationPersonSessionV2,
  ): StoredPersonClientSessionV1 {
    const value = storedSession({
      schema_version: 1,
      kind: 'echo-person-client-session',
      authority_origin: authorityOrigin,
      authority_id: authorityId,
      session,
    });
    this.writeLive(value);
    this.cleanupTransitions();
    return value;
  }

  read(): StoredPersonClientSessionV1 {
    if (!existsSync(this.paths.live)) {
      throw new PersonClientSessionUnavailableError();
    }
    if (existsSync(this.paths.refresh_claim)) {
      if (existsSync(this.paths.refreshing)) {
        let value: StoredPersonClientSessionV1;
        try {
          value = parseStoredSession(readPrivateFile(this.paths.live));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new PersonClientSessionUnavailableError(
              'Person session refresh is in progress; sign in again if it was interrupted',
            );
          }
          throw error;
        }
        this.cleanupTransitions();
        return value;
      }
      throw new PersonClientSessionUnavailableError(
        'Person session refresh was interrupted; sign in again',
      );
    }
    if (existsSync(this.paths.logout_claim)) {
      throw new PersonClientSessionUnavailableError(
        'Person session logout was interrupted; sign in again',
      );
    }
    return parseStoredSession(readPrivateFile(this.paths.live));
  }

  private createClaim(path: string): string {
    ensurePrivateDirectory(this.paths.directory);
    const claimId = randomUUID();
    const descriptor = openSync(
      path,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      writeFileSync(descriptor, `${claimId}\n`, 'utf8');
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    fsyncDirectory(this.paths.directory);
    return claimId;
  }

  claimRefresh(): PersonSessionRefreshClaim {
    try {
      const claimId = this.createClaim(this.paths.refresh_claim);
      renameSync(this.paths.live, this.paths.refreshing);
      fsyncDirectory(this.paths.directory);
      return Object.freeze({
        claim_id: claimId,
        stored: parseStoredSession(readPrivateFile(this.paths.refreshing)),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new PersonClientSessionUnavailableError(
          'Person session refresh is already claimed; sign in again if it was interrupted',
        );
      }
      throw error;
    }
  }

  completeRefresh(
    claimed: PersonSessionRefreshClaim,
    session: OrganizationPersonSessionV2,
  ): StoredPersonClientSessionV1 {
    if (
      existsSync(this.paths.live) ||
      !existsSync(this.paths.refresh_claim) ||
      !existsSync(this.paths.refreshing) ||
      readPrivateFile(this.paths.refresh_claim) !== `${claimed.claim_id}\n` ||
      JSON.stringify(
        parseStoredSession(readPrivateFile(this.paths.refreshing)),
      ) !== JSON.stringify(claimed.stored)
    ) {
      throw new PersonClientSessionUnavailableError(
        'Person session refresh claim changed; refusing a stale completion',
      );
    }
    const value = storedSession({
      schema_version: 1,
      kind: 'echo-person-client-session',
      authority_origin: claimed.stored.authority_origin,
      authority_id: claimed.stored.authority_id,
      session,
    });
    try {
      this.writeLive(value, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new PersonClientSessionUnavailableError(
          'Person session refresh claim changed; refusing a stale completion',
        );
      }
      throw error;
    }
    this.cleanupTransitions();
    return value;
  }

  claimLogout(): StoredPersonClientSessionV1 {
    try {
      this.createClaim(this.paths.logout_claim);
      renameSync(this.paths.live, this.paths.logging_out);
      fsyncDirectory(this.paths.directory);
      return parseStoredSession(readPrivateFile(this.paths.logging_out));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new PersonClientSessionUnavailableError(
          'Person session logout is already claimed',
        );
      }
      throw error;
    }
  }

  finishLogout(): void {
    ensurePrivateDirectory(this.paths.directory);
    let changed = false;
    for (const path of [this.paths.logging_out, this.paths.logout_claim]) {
      changed = removeIfPresent(path) || changed;
    }
    if (changed) fsyncDirectory(this.paths.directory);
  }
}
