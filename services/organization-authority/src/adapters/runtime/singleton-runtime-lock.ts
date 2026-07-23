import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { basename, dirname, join } from 'node:path';

interface LockRecord {
  schema_version: 1;
  pid: number;
  token: string;
  guard_port: number;
  runtime_fingerprint_sha256: `sha256:${string}` | null;
}

interface ReadLock {
  record: LockRecord;
  device: number;
  inode: number;
}

interface OwnedLock {
  path: string;
  lock: ReadLock;
  guard: Server;
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
  guard_port: number;
  runtime_fingerprint_sha256: `sha256:${string}` | null;
  token: string;
}): LockRecord {
  return {
    schema_version: 1,
    pid: process.pid,
    token: input.token,
    guard_port: input.guard_port,
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

/** Publishes only a complete, fsynced lock inode at the public pathname. */
function createLock(path: string, record: LockRecord): ReadLock {
  const parent = dirname(path);
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const preparedPath = `${path}.prepare-${randomBytes(16).toString('hex')}`;
  const file = openSync(
    preparedPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow,
    0o600,
  );
  let prepared: ReadLock;
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
      Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(',') !==
        'guard_port,pid,runtime_fingerprint_sha256,schema_version,token'
    ) {
      throw new Error(`${label} has an invalid shape`);
    }
    const record = parsed as Record<string, unknown>;
    if (
      record.schema_version !== 1 ||
      !Number.isSafeInteger(record.pid) ||
      (record.pid as number) < 1 ||
      typeof record.token !== 'string' ||
      !/^[a-f0-9]{64}$/.test(record.token) ||
      !Number.isSafeInteger(record.guard_port) ||
      (record.guard_port as number) < 1 ||
      (record.guard_port as number) > 65_535 ||
      (record.runtime_fingerprint_sha256 !== null &&
        (typeof record.runtime_fingerprint_sha256 !== 'string' ||
          !/^sha256:[a-f0-9]{64}$/.test(record.runtime_fingerprint_sha256)))
    ) {
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
    left.record.pid === right.record.pid &&
    left.record.token === right.record.token &&
    left.record.guard_port === right.record.guard_port &&
    left.record.runtime_fingerprint_sha256 ===
      right.record.runtime_fingerprint_sha256
  );
}

async function closeGuard(server: Server): Promise<void> {
  if (!server.listening) return;
  const closed = once(server, 'close');
  server.close();
  await closed;
}

async function abandonGuard(server: Server): Promise<void> {
  // Abandonment is used only when protected-resource cleanup is uncertain.
  // Stop the guard from keeping a terminal process alive, but retain kernel
  // exclusion until that process actually exits.
  server.unref();
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
  record: LockRecord,
): Promise<GuardProbe> {
  return await new Promise((resolve) => {
    const nonce = randomBytes(32).toString('hex');
    const expectedProof = Buffer.from(guardProof(record.token, nonce), 'hex');
    const socket = connect({ host: '127.0.0.1', port: record.guard_port });
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
      if (!connected && error.code === 'ECONNREFUSED') {
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
 * The authenticated loopback listener is the kernel-released ownership
 * primitive. Port occupancy alone is not ownership: the listener must answer
 * a fresh HMAC challenge with the private token published in the lock file.
 */
async function acquireGuard(
  token: string,
  port: number,
  excludedPort?: number,
): Promise<{ server: Server; port: number }> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const server = createAuthenticatedGuard(token);
    server.listen({ host: '127.0.0.1', port, exclusive: true });
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') {
      await closeGuard(server);
      throw new Error('authority kernel ownership guard did not bind TCP');
    }
    if (port === 0 && address.port === excludedPort) {
      await closeGuard(server);
      continue;
    }
    return { server, port: address.port };
  }
  throw new Error('authority kernel ownership guard could not avoid listener');
}

function recoveryGuardToken(path: string, existing: ReadLock): string {
  return createHmac('sha256', Buffer.from(existing.record.token, 'hex'))
    .update('echo-organization-authority-lock-recovery-v1\0', 'utf8')
    .update(path, 'utf8')
    .update('\0', 'utf8')
    .update(String(existing.device), 'ascii')
    .update(':', 'ascii')
    .update(String(existing.inode), 'ascii')
    .digest('hex');
}

function recoveryGuardPort(token: string, attempt: number): number {
  const digest = createHmac('sha256', Buffer.from(token, 'hex'))
    .update('echo-organization-authority-lock-recovery-port-v1\0', 'utf8')
    .update(String(attempt), 'ascii')
    .digest();
  return 20_000 + (digest.readUInt16BE(0) % 45_536);
}

/**
 * Serializes recovery when an unrelated process occupies the recorded port.
 * Every contender for the same stale inode derives the same authenticated
 * alternate guard. Only its kernel owner may pass the later unlink/create
 * sequence; unrelated collisions advance the shared deterministic sequence.
 */
async function acquireRecoveryGuard(
  path: string,
  existing: ReadLock,
  activeMessage: string,
  excludedPort?: number,
): Promise<{ server: Server; port: number; token: string }> {
  const token = recoveryGuardToken(path, existing);
  const attemptedPorts = new Set<number>();
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const port = recoveryGuardPort(token, attempt);
    if (
      attemptedPorts.has(port) ||
      port === existing.record.guard_port ||
      port === excludedPort
    ) {
      continue;
    }
    attemptedPorts.add(port);
    const candidate: LockRecord = {
      ...existing.record,
      token,
      guard_port: port,
    };
    for (let raceAttempt = 0; raceAttempt < 4; raceAttempt += 1) {
      const probe = await probeAuthenticatedGuard(candidate);
      if (probe.kind === 'verified') {
        throw new Error(
          `${activeMessage} (authenticated stale-lock recovery is active)`,
        );
      }
      if (probe.kind === 'ambiguous') {
        throw new Error(
          `${activeMessage} (recovery guard could not be authenticated safely: ${probe.detail})`,
        );
      }
      if (probe.kind === 'invalid') break;
      try {
        const guard = await acquireGuard(token, port, excludedPort);
        return { ...guard, token };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
          throw error;
        }
      }
    }
  }
  throw new Error(
    `${activeMessage} (no unambiguous authenticated recovery guard was available)`,
  );
}

async function acquireOwnedLock(
  path: string,
  activeMessage: string,
  runtimeFingerprint: `sha256:${string}` | null,
  excludedGuardPort?: number,
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
      existingProbe = await probeAuthenticatedGuard(existing.record);
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
    }

    let token: string;
    let guard: { server: Server; port: number };
    if (existing === undefined) {
      token = randomBytes(32).toString('hex');
      guard = await acquireGuard(token, 0, excludedGuardPort);
    } else if (
      existingProbe?.kind === 'absent' &&
      existing.record.guard_port !== excludedGuardPort
    ) {
      // Reusing the published token turns the recorded port into the recovery
      // mutex: any losing contender authenticates this winner and cannot reach
      // the unlink window.
      token = existing.record.token;
      try {
        guard = await acquireGuard(
          token,
          existing.record.guard_port,
          excludedGuardPort,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') continue;
        throw error;
      }
    } else {
      const recovery = await acquireRecoveryGuard(
        path,
        existing,
        activeMessage,
        excludedGuardPort,
      );
      token = recovery.token;
      guard = recovery;
    }
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
        unlinkSync(path);
        fsyncDirectory(dirname(path));
        if (guard.port === excludedGuardPort) continue;
      }

      const record = lockRecord({
        guard_port: guard.port,
        runtime_fingerprint_sha256: runtimeFingerprint,
        token,
      });
      try {
        const lock = createLock(path, record);
        retained = true;
        return { path, lock, guard: guard.server };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    } finally {
      if (!retained) await closeGuard(guard.server);
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
  return join(stateDirectory, '.echo-authority-runtime.lock');
}

function authorityInitializationLockPaths(
  configPath: string,
  stateDirectory: string,
): readonly string[] {
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
  listenerPort: number,
): Promise<AuthorityRuntimeLockHandle> {
  if (!/^sha256:[a-f0-9]{64}$/.test(runtimeFingerprint)) {
    throw new Error('authority runtime fingerprint must be a SHA-256 digest');
  }
  if (
    !Number.isSafeInteger(listenerPort) ||
    listenerPort < 0 ||
    listenerPort > 65_535
  ) {
    throw new Error('authority listener port is invalid for runtime ownership');
  }
  const owned = await acquireOwnedLock(
    authorityRuntimeLockPath(stateDirectory),
    'organization authority is already running for this state directory',
    runtimeFingerprint,
    listenerPort === 0 ? undefined : listenerPort,
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
    const probe = await probeAuthenticatedGuard(lock.record);
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
    if (probe.kind === 'ambiguous') {
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
