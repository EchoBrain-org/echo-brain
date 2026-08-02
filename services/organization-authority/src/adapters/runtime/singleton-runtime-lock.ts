import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { once } from 'node:events';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

interface CurrentLockRecord {
  schema_version: 2;
  pid: number;
  token: string;
  guard_socket: string;
  runtime_fingerprint_sha256: `sha256:${string}` | null;
}

interface LegacyLockRecord {
  schema_version: 1;
  pid: number;
  token: string;
  guard_port: number;
  runtime_fingerprint_sha256: `sha256:${string}` | null;
}

type LockRecord = CurrentLockRecord | LegacyLockRecord;

interface ReadLock<T extends LockRecord = LockRecord> {
  record: T;
  device: number;
  inode: number;
}

interface OwnedLock {
  path: string;
  lock: ReadLock<CurrentLockRecord>;
  guard: OwnedGuard;
}

interface OwnedGuard {
  server: Server;
  socketPath: string;
  socketName: string;
}

type GuardProbe =
  | { kind: 'verified' }
  | { kind: 'absent' }
  | { kind: 'invalid'; detail: string }
  | { kind: 'ambiguous'; detail: string };

const GUARD_CHALLENGE_PREFIX = 'echo-organization-authority-guard/1 challenge ';
const GUARD_PROOF_PREFIX = 'echo-organization-authority-guard/1 proof ';
const GUARD_CHALLENGE_DEADLINE_MS = 500;
const MAX_GUARD_MESSAGE_BYTES = 256;
const MAX_GUARD_SOCKET_PATH_BYTES = 103;
const GUARD_SOCKET_PATTERN = /^\.g-[a-f0-9]{6}$/;
const COORDINATION_ROOT_ENV = 'ECHO_AUTHORITY_COORDINATION_ROOT';

export interface AuthorityRuntimeLockInspection {
  present: boolean;
  active: boolean;
  pid?: number;
  challenge_secret?: string;
  runtime_fingerprint_sha256?: `sha256:${string}`;
}

export type ReleaseAuthorityOperatorLock = () => Promise<void>;

export interface AuthorityRuntimeLockHandle {
  challenge_secret: string;
  runtime_fingerprint_sha256: `sha256:${string}`;
  release(): Promise<void>;
  abandon(): Promise<void>;
}

function lockRecord(input: {
  guard_socket: string;
  runtime_fingerprint_sha256: `sha256:${string}` | null;
  token: string;
}): CurrentLockRecord {
  return {
    schema_version: 2,
    pid: process.pid,
    token: input.token,
    guard_socket: input.guard_socket,
    runtime_fingerprint_sha256: input.runtime_fingerprint_sha256,
  };
}

function encodeLock(record: LockRecord): string {
  return `${JSON.stringify(record)}\n`;
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, fsConstants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function assertPrivateCoordinationDirectory(path: string): void {
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
      'authority coordination directory must be a current-user 0700 canonical directory',
    );
  }
}

function configuredCoordinationRoot(): string | null {
  const root = process.env[COORDINATION_ROOT_ENV];
  if (root === undefined) return null;
  if (
    root.length === 0 ||
    root.includes('\0') ||
    !isAbsolute(root) ||
    resolve(root) !== root
  ) {
    throw new Error(
      `${COORDINATION_ROOT_ENV} must be a normalized absolute path`,
    );
  }
  const state = lstatSync(root);
  if (
    state.isSymbolicLink() ||
    !state.isDirectory() ||
    realpathSync(root) !== root ||
    (state.mode & 0o1777) !== 0o1777
  ) {
    throw new Error(
      'authority coordination root must be a canonical sticky mode-1777 directory',
    );
  }
  return root;
}

function authorityCoordinationDirectory(stateDirectory: string): string {
  const root = configuredCoordinationRoot();
  if (root === null) return stateDirectory;
  const identity = createHash('sha256')
    .update(`${resolve(stateDirectory)}\n`)
    .digest('hex')
    .slice(0, 24);
  const directory = join(root, `authority-${identity}`);
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  assertPrivateCoordinationDirectory(directory);
  return directory;
}

/** Publishes only a complete, fsynced lock inode at the public pathname. */
function createLock(
  path: string,
  record: CurrentLockRecord,
): ReadLock<CurrentLockRecord> {
  const parent = dirname(path);
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const preparedPath = `${path}.prepare-${randomBytes(16).toString('hex')}`;
  const file = openSync(
    preparedPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow,
    0o600,
  );
  let prepared: ReadLock<CurrentLockRecord>;
  try {
    writeFileSync(file, encodeLock(record), 'utf8');
    fsyncSync(file);
    const state = fstatSync(file);
    prepared = { record, device: state.dev, inode: state.ino };
  } catch (error) {
    try {
      closeSync(file);
    } catch {}
    try {
      unlinkSync(preparedPath);
    } catch {}
    throw error;
  }
  closeSync(file);
  let published = false;
  try {
    linkSync(preparedPath, path);
    published = true;
    fsyncDirectory(parent);
    return prepared;
  } catch (error) {
    if (published) {
      try {
        const current = readLock(path, 'authority operator lock');
        if (sameLock(prepared, current)) unlinkSync(path);
      } catch {}
    }
    throw error;
  } finally {
    try {
      unlinkSync(preparedPath);
      fsyncDirectory(parent);
    } catch {}
  }
}

function readLock(path: string, label: string): ReadLock {
  const state = lstatSync(path);
  const currentUid = process.getuid?.();
  if (
    state.isSymbolicLink() ||
    !state.isFile() ||
    state.size <= 0 ||
    state.size > 2048 ||
    (currentUid !== undefined && state.uid !== currentUid) ||
    (state.mode & 0o777) !== 0o600
  ) {
    throw new Error(`${label} is not a private current-user lock file`);
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const file = openSync(path, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(file);
    if (opened.dev !== state.dev || opened.ino !== state.ino) {
      throw new Error(`${label} changed while opening`);
    }
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      throw new Error(`${label} has an invalid shape`);
    }
    const record = parsed as Record<string, unknown>;
    const commonValid =
      !Number.isSafeInteger(record.pid) ||
      (record.pid as number) < 1 ||
      typeof record.token !== 'string' ||
      !/^[a-f0-9]{64}$/.test(record.token) ||
      (record.runtime_fingerprint_sha256 !== null &&
        (typeof record.runtime_fingerprint_sha256 !== 'string' ||
          !/^sha256:[a-f0-9]{64}$/.test(record.runtime_fingerprint_sha256)));
    const current =
      record.schema_version === 2 &&
      Object.keys(record).sort().join(',') ===
        'guard_socket,pid,runtime_fingerprint_sha256,schema_version,token' &&
      typeof record.guard_socket === 'string' &&
      GUARD_SOCKET_PATTERN.test(record.guard_socket);
    const legacy =
      record.schema_version === 1 &&
      Object.keys(record).sort().join(',') ===
        'guard_port,pid,runtime_fingerprint_sha256,schema_version,token' &&
      Number.isSafeInteger(record.guard_port) &&
      (record.guard_port as number) >= 1 &&
      (record.guard_port as number) <= 65_535;
    if (commonValid || (!current && !legacy)) {
      throw new Error(`${label} has invalid ownership data`);
    }
    return {
      record: record as unknown as LockRecord,
      device: state.dev,
      inode: state.ino,
    };
  } finally {
    closeSync(file);
  }
}

function sameLock(left: ReadLock, right: ReadLock): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    JSON.stringify(left.record) === JSON.stringify(right.record)
  );
}

function guardSocketPath(lockPath: string, socketName: string): string {
  if (!GUARD_SOCKET_PATTERN.test(socketName)) {
    throw new Error('authority ownership guard socket name is invalid');
  }
  return join(dirname(lockPath), socketName);
}

function removeGuardSocket(socketPath: string): void {
  try {
    unlinkSync(socketPath);
    fsyncDirectory(dirname(socketPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function closeGuard(guard: OwnedGuard): Promise<void> {
  if (guard.server.listening) {
    const closed = once(guard.server, 'close');
    guard.server.close();
    await closed;
  }
  removeGuardSocket(guard.socketPath);
}

async function abandonGuard(guard: OwnedGuard): Promise<void> {
  // Abandonment is used only when protected-resource cleanup is uncertain.
  // Stop the guard from keeping a terminal process alive, but retain kernel
  // exclusion until that process actually exits.
  guard.server.unref();
}

function guardProof(token: string, nonce: string): string {
  return createHmac('sha256', Buffer.from(token, 'hex'))
    .update('echo-organization-authority-kernel-guard-v1\0', 'utf8')
    .update(nonce, 'ascii')
    .digest('hex');
}

function serveGuardChallenge(socket: Socket, token: string): void {
  let input = Buffer.alloc(0);
  let settled = false;
  const finish = (response?: string): void => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    if (response === undefined) socket.destroy();
    else socket.end(response);
  };
  const deadline = setTimeout(() => finish(), GUARD_CHALLENGE_DEADLINE_MS);
  deadline.unref?.();
  socket.setNoDelay(true);
  socket.once('error', () => finish());
  socket.once('end', () => finish());
  socket.on('data', (chunk: Buffer) => {
    if (settled) return;
    input = Buffer.concat([input, chunk]);
    if (input.length > MAX_GUARD_MESSAGE_BYTES) {
      finish();
      return;
    }
    const newline = input.indexOf(0x0a);
    if (newline < 0) return;
    if (newline !== input.length - 1) {
      finish();
      return;
    }
    const challenge = input.subarray(0, newline).toString('ascii');
    if (!challenge.startsWith(GUARD_CHALLENGE_PREFIX)) {
      finish();
      return;
    }
    const nonce = challenge.slice(GUARD_CHALLENGE_PREFIX.length);
    if (!/^[a-f0-9]{64}$/.test(nonce)) {
      finish();
      return;
    }
    finish(`${GUARD_PROOF_PREFIX}${guardProof(token, nonce)}\n`);
  });
}

function createAuthenticatedGuard(token: string): Server {
  return createServer((socket) => serveGuardChallenge(socket, token));
}

async function probeAuthenticatedGuard(
  lockPath: string,
  record: LockRecord,
): Promise<GuardProbe> {
  return await new Promise((resolve) => {
    const nonce = randomBytes(32).toString('hex');
    const expectedProof = Buffer.from(guardProof(record.token, nonce), 'hex');
    const socket =
      record.schema_version === 2
        ? connect(guardSocketPath(lockPath, record.guard_socket))
        : connect({ host: '127.0.0.1', port: record.guard_port });
    let connected = false;
    let receivedBytes = false;
    let response = Buffer.alloc(0);
    let settled = false;
    const finish = (result: GuardProbe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve(result);
    };
    const deadline = setTimeout(
      () =>
        finish({
          kind: 'ambiguous',
          detail: 'guard challenge exceeded its absolute deadline',
        }),
      GUARD_CHALLENGE_DEADLINE_MS,
    );
    deadline.unref?.();
    socket.setNoDelay(true);
    socket.once('connect', () => {
      connected = true;
      socket.write(`${GUARD_CHALLENGE_PREFIX}${nonce}\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      if (settled) return;
      receivedBytes = true;
      response = Buffer.concat([response, chunk]);
      if (response.length > MAX_GUARD_MESSAGE_BYTES) {
        finish({ kind: 'invalid', detail: 'guard proof exceeded size limit' });
        return;
      }
      const newline = response.indexOf(0x0a);
      if (newline < 0) return;
      if (newline !== response.length - 1) {
        finish({ kind: 'invalid', detail: 'guard proof had trailing data' });
        return;
      }
      const line = response.subarray(0, newline).toString('ascii');
      if (!line.startsWith(GUARD_PROOF_PREFIX)) {
        finish({ kind: 'invalid', detail: 'guard used an unknown protocol' });
        return;
      }
      const proofHex = line.slice(GUARD_PROOF_PREFIX.length);
      if (!/^[a-f0-9]{64}$/.test(proofHex)) {
        finish({ kind: 'invalid', detail: 'guard proof was malformed' });
        return;
      }
      const proof = Buffer.from(proofHex, 'hex');
      finish(
        timingSafeEqual(proof, expectedProof)
          ? { kind: 'verified' }
          : { kind: 'invalid', detail: 'guard proof did not match lock token' },
      );
    });
    socket.once('end', () => {
      if (settled) return;
      finish(
        receivedBytes
          ? { kind: 'invalid', detail: 'guard proof was incomplete' }
          : {
              kind: 'ambiguous',
              detail: 'guard accepted the challenge but gave no response',
            },
      );
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      if (
        !connected &&
        (error.code === 'ECONNREFUSED' ||
          (record.schema_version === 2 && error.code === 'ENOENT'))
      ) {
        finish({ kind: 'absent' });
        return;
      }
      finish({
        kind: 'ambiguous',
        detail: `guard challenge failed without a proof: ${error.message}`,
      });
    });
  });
}

/**
 * Schema 2 uses an authenticated Unix socket as the kernel-released ownership
 * primitive. Schema 1 TCP guards are read only so a direct-install upgrade can
 * authenticate a live old owner or replace a proven-stale legacy lock.
 * Its pathname lives beside the lock, so every process that can see shared
 * authority state reaches the same guard across container network namespaces.
 * Socket occupancy alone is not ownership: the listener must answer a fresh
 * HMAC challenge with the private token published in the lock file.
 */
async function acquireGuard(
  lockPath: string,
  token: string,
): Promise<OwnedGuard> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const socketName = `.g-${randomBytes(3).toString('hex')}`;
    const socketPath = guardSocketPath(lockPath, socketName);
    if (Buffer.byteLength(socketPath, 'utf8') > MAX_GUARD_SOCKET_PATH_BYTES) {
      throw new Error(
        'authority coordination directory path is too long for a portable Unix ownership socket',
      );
    }
    const server = createAuthenticatedGuard(token);
    try {
      server.listen({ path: socketPath, exclusive: true });
      await once(server, 'listening');
      if (server.address() !== socketPath) {
        throw new Error(
          'authority kernel ownership guard did not bind its Unix socket',
        );
      }
      fsyncDirectory(dirname(socketPath));
      return { server, socketPath, socketName };
    } catch (error) {
      if (server.listening) {
        await closeGuard({ server, socketPath, socketName });
      }
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') continue;
      throw error;
    }
  }
  throw new Error(
    'authority kernel ownership guard could not allocate a unique Unix socket',
  );
}

async function acquireOwnedLock(
  path: string,
  activeMessage: string,
  runtimeFingerprint: `sha256:${string}` | null,
): Promise<OwnedLock> {
  assertPrivateCoordinationDirectory(dirname(path));
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let existing: ReadLock | undefined;
    try {
      existing = readLock(path, 'existing authority operator lock');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    let existingProbe: GuardProbe | undefined;
    if (existing !== undefined) {
      existingProbe = await probeAuthenticatedGuard(path, existing.record);
      if (existingProbe.kind === 'verified') {
        throw new Error(
          `${activeMessage} (authenticated kernel ownership guard is active)`,
        );
      }
      if (existingProbe.kind === 'ambiguous') {
        throw new Error(
          `${activeMessage} (kernel ownership guard could not be authenticated safely: ${existingProbe.detail})`,
        );
      }
      if (existingProbe.kind === 'invalid') {
        throw new Error(
          `${activeMessage} (kernel ownership guard returned an invalid proof: ${existingProbe.detail})`,
        );
      }
      if (existing.record.schema_version === 2) {
        removeGuardSocket(
          guardSocketPath(path, existing.record.guard_socket),
        );
      } else if (configuredCoordinationRoot() !== null) {
        throw new Error(
          `${activeMessage} (a legacy TCP ownership lock cannot be recovered safely across container network namespaces; stop the old deployment before upgrading)`,
        );
      }
    }

    const token = randomBytes(32).toString('hex');
    const guard = await acquireGuard(path, token);
    let retained = false;
    try {
      if (existing !== undefined) {
        let current: ReadLock;
        try {
          current = readLock(path, 'existing authority operator lock');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        if (!sameLock(existing, current)) continue;
        try {
          unlinkSync(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        fsyncDirectory(dirname(path));
      }

      const record = lockRecord({
        guard_socket: guard.socketName,
        runtime_fingerprint_sha256: runtimeFingerprint,
        token,
      });
      try {
        const lock = createLock(path, record);
        retained = true;
        return { path, lock, guard };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    } finally {
      if (!retained) await closeGuard(guard);
    }
  }
  throw new Error('authority operator lock changed repeatedly; retry later');
}

async function releaseOwnedLock(owned: OwnedLock): Promise<void> {
  let failure: unknown;
  try {
    const current = readLock(owned.path, 'authority operator lock');
    if (!sameLock(owned.lock, current)) {
      throw new Error('authority operator lock ownership changed');
    }
    unlinkSync(owned.path);
    fsyncDirectory(dirname(owned.path));
  } catch (error) {
    failure = error;
  }
  try {
    await closeGuard(owned.guard);
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) throw failure;
}

async function releaseOwnedLocks(ownedLocks: OwnedLock[]): Promise<void> {
  const failures: unknown[] = [];
  for (const owned of [...ownedLocks].reverse()) {
    try {
      await releaseOwnedLock(owned);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      'authority operator lock release failed',
    );
  }
}

export function authorityRuntimeLockPath(stateDirectory: string): string {
  return join(
    authorityCoordinationDirectory(stateDirectory),
    '.echo-authority-runtime.lock',
  );
}

function authorityInitializationLockPaths(
  configPath: string,
  stateDirectory: string,
): readonly string[] {
  const coordinationDirectory =
    configuredCoordinationRoot() === null
      ? null
      : authorityCoordinationDirectory(stateDirectory);
  if (coordinationDirectory !== null) {
    const configIdentity = createHash('sha256')
      .update(`${resolve(configPath)}\n`)
      .digest('hex')
      .slice(0, 24);
    return [
      join(
        coordinationDirectory,
        `.config-${configIdentity}.echo-authority-initialization.lock`,
      ),
      join(
        coordinationDirectory,
        '.state.echo-authority-initialization.lock',
      ),
    ].sort();
  }
  return [
    join(
      dirname(configPath),
      `.${basename(configPath)}.echo-authority-initialization.lock`,
    ),
    join(
      dirname(stateDirectory),
      `.${basename(stateDirectory)}.echo-authority-initialization.lock`,
    ),
  ].sort();
}

export async function acquireAuthorityInitializationLock(
  configPath: string,
  stateDirectory: string,
): Promise<ReleaseAuthorityOperatorLock> {
  const acquired: OwnedLock[] = [];
  try {
    for (const path of authorityInitializationLockPaths(
      configPath,
      stateDirectory,
    )) {
      if (acquired.some((entry) => entry.path === path)) continue;
      acquired.push(
        await acquireOwnedLock(
          path,
          'organization authority initialization is already running',
          null,
        ),
      );
    }
  } catch (error) {
    try {
      await releaseOwnedLocks(acquired);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'authority initialization lock acquisition and cleanup failed',
      );
    }
    throw error;
  }
  let releasePromise: Promise<void> | undefined;
  return (): Promise<void> => {
    releasePromise ??= releaseOwnedLocks(acquired);
    return releasePromise;
  };
}

export async function acquireAuthorityRuntimeLock(
  stateDirectory: string,
  runtimeFingerprint: `sha256:${string}`,
): Promise<AuthorityRuntimeLockHandle> {
  if (!/^sha256:[a-f0-9]{64}$/.test(runtimeFingerprint)) {
    throw new Error('authority runtime fingerprint must be a SHA-256 digest');
  }
  const owned = await acquireOwnedLock(
    authorityRuntimeLockPath(stateDirectory),
    'organization authority is already running for this state directory',
    runtimeFingerprint,
  );
  let settlement: Promise<void> | undefined;
  return {
    challenge_secret: owned.lock.record.token,
    runtime_fingerprint_sha256: runtimeFingerprint,
    release(): Promise<void> {
      settlement ??= releaseOwnedLock(owned);
      return settlement;
    },
    abandon(): Promise<void> {
      // Once abandonment begins it is no longer safe for a later caller to
      // unlink the pathname, so release and abandon share one settlement.
      settlement ??= abandonGuard(owned.guard);
      return settlement;
    },
  };
}

export async function inspectAuthorityRuntimeLock(
  stateDirectory: string,
): Promise<AuthorityRuntimeLockInspection> {
  const path = authorityRuntimeLockPath(stateDirectory);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let lock: ReadLock;
    try {
      lock = readLock(path, 'organization authority runtime lock');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { present: false, active: false };
      }
      throw error;
    }
    const probe = await probeAuthenticatedGuard(path, lock.record);
    let current: ReadLock;
    try {
      current = readLock(path, 'organization authority runtime lock');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { present: false, active: false };
      }
      throw error;
    }
    if (!sameLock(lock, current)) continue;
    if (probe.kind === 'ambiguous' || probe.kind === 'invalid') {
      throw new Error(
        `authority runtime ownership could not be authenticated safely: ${probe.detail}`,
      );
    }
    return {
      present: true,
      active: probe.kind === 'verified',
      pid: lock.record.pid,
      challenge_secret: lock.record.token,
      ...(lock.record.runtime_fingerprint_sha256 === null
        ? {}
        : {
            runtime_fingerprint_sha256: lock.record.runtime_fingerprint_sha256,
          }),
    };
  }
  throw new Error(
    'authority runtime ownership changed repeatedly during inspection',
  );
}
