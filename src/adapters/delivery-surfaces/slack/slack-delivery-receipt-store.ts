import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import {
  acquireProcessFileLock,
  ProcessFileLockError,
} from '../../../util/process-file-lock.js';

const MAX_RECORD_BYTES = 64 * 1024;
const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_STALE_MS = 30_000;

export type SlackStoredDelivery =
  | {
      schema_version: 1;
      record_type: 'echo-brain.slack-delivery';
      idempotency_key: string;
      status: 'delivered';
      channel_id: string;
      message_ts: string;
      recorded_at: string;
    }
  | {
      schema_version: 1;
      record_type: 'echo-brain.slack-delivery';
      idempotency_key: string;
      status: 'unknown';
      channel_id: null;
      message_ts: null;
      recorded_at: string;
      message: string;
    };

export type SlackDeliveryReceiptStoreErrorCode = 'busy' | 'unsafe' | 'io';

export class SlackDeliveryReceiptStoreError extends Error {
  constructor(
    public readonly code: SlackDeliveryReceiptStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SlackDeliveryReceiptStoreError';
  }
}

export interface SlackDeliveryReceiptStore {
  healthCheck(): Promise<void>;
  runExclusive<T>(
    idempotencyKey: string,
    operation: () => Promise<T>,
  ): Promise<T>;
  get(idempotencyKey: string): Promise<SlackStoredDelivery | undefined>;
  createAttempt(record: SlackStoredDelivery & { status: 'unknown' }): Promise<void>;
  recordOutcome(record: SlackStoredDelivery): Promise<void>;
  clearAttempt(idempotencyKey: string): Promise<void>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizedTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const milliseconds = new Date(value).getTime();
  return Number.isNaN(milliseconds)
    ? null
    : new Date(milliseconds).toISOString();
}

function errno(error: unknown): string | undefined {
  return isPlainObject(error) && typeof error['code'] === 'string'
    ? error['code']
    : undefined;
}

function assertStoredDelivery(
  value: unknown,
  expectedKey: string,
): asserts value is SlackStoredDelivery {
  if (!isPlainObject(value)) throw new Error('record must be an object');
  if (
    value['schema_version'] !== 1 ||
    value['record_type'] !== 'echo-brain.slack-delivery' ||
    value['idempotency_key'] !== expectedKey ||
    normalizedTimestamp(value['recorded_at']) !== value['recorded_at']
  ) {
    throw new Error('record identity is invalid');
  }
  if (value['status'] === 'delivered') {
    if (
      !isNonEmptyString(value['channel_id']) ||
      !isNonEmptyString(value['message_ts']) ||
      value['message'] !== undefined
    ) {
      throw new Error('delivered record is invalid');
    }
    return;
  }
  if (
    value['status'] !== 'unknown' ||
    value['channel_id'] !== null ||
    value['message_ts'] !== null ||
    !isNonEmptyString(value['message'])
  ) {
    throw new Error('unknown record is invalid');
  }
}

function recordName(idempotencyKey: string): string {
  return `${createHash('sha256').update(idempotencyKey).digest('hex')}.json`;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAndSync(handle: FileHandle, value: string): Promise<void> {
  await handle.writeFile(value, 'utf8');
  await handle.sync();
}

/**
 * Private, crash-conservative Slack delivery journal.
 *
 * The adapter writes an `unknown` attempt before making the network call and
 * replaces it only after Slack returns a channel/timestamp. A crash can
 * therefore stop delivery, but cannot silently turn an uncertain attempt into
 * a duplicate post on restart.
 */
export class FileSlackDeliveryReceiptStore
  implements SlackDeliveryReceiptStore
{
  private readonly root: string;
  private readonly directoryChain: readonly string[];

  constructor(stateDirectory: string, instanceId: string) {
    if (
      !isAbsolute(stateDirectory) ||
      normalize(stateDirectory) !== stateDirectory ||
      !/^[a-z][a-z0-9-]*$/.test(instanceId)
    ) {
      throw new SlackDeliveryReceiptStoreError(
        'unsafe',
        'Slack delivery receipt store path is invalid',
      );
    }
    const deliverySurfacesDirectory = join(stateDirectory, 'delivery-surfaces');
    const slackDirectory = join(deliverySurfacesDirectory, 'slack');
    this.root = join(slackDirectory, instanceId);
    this.directoryChain = Object.freeze([
      stateDirectory,
      deliverySurfacesDirectory,
      slackDirectory,
      this.root,
    ]);
  }

  async healthCheck(): Promise<void> {
    await this.ensureReady();
  }

  async runExclusive<T>(
    idempotencyKey: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    await this.ensureReady();
    const digest = createHash('sha256').update(idempotencyKey).digest('hex');
    let release: (() => Promise<void>) | undefined;
    try {
      release = await acquireProcessFileLock(join(this.root, `${digest}.lock`), {
        timeoutMs: LOCK_TIMEOUT_MS,
        staleMs: LOCK_STALE_MS,
        retryMs: LOCK_RETRY_MS,
      });
      return await operation();
    } catch (error) {
      if (error instanceof SlackDeliveryReceiptStoreError) throw error;
      if (error instanceof ProcessFileLockError) {
        throw new SlackDeliveryReceiptStoreError(
          error.code === 'busy' ? 'busy' : error.code === 'io' ? 'io' : 'unsafe',
          error.code === 'busy'
            ? 'Slack delivery receipt store is busy'
            : 'Slack delivery receipt store lock is unavailable',
        );
      }
      throw error;
    } finally {
      if (release !== undefined) {
        try {
          await release();
        } catch {
          throw new SlackDeliveryReceiptStoreError(
            'io',
            'Slack delivery receipt store lock release failed',
          );
        }
      }
    }
  }

  async get(idempotencyKey: string): Promise<SlackStoredDelivery | undefined> {
    await this.ensureReady();
    const path = join(this.root, recordName(idempotencyKey));
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        path,
        constants.O_RDONLY |
          (constants.O_NOFOLLOW ?? 0) |
          (constants.O_NONBLOCK ?? 0),
      );
      const before = await handle.stat();
      if (
        !before.isFile() ||
        (before.mode & 0o077) !== 0 ||
        before.size < 1 ||
        before.size > MAX_RECORD_BYTES
      ) {
        throw new SlackDeliveryReceiptStoreError(
          'unsafe',
          'Slack delivery receipt record is unsafe',
        );
      }
      const contents = await handle.readFile('utf8');
      const after = await handle.stat();
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs
      ) {
        throw new SlackDeliveryReceiptStoreError(
          'io',
          'Slack delivery receipt changed while being read',
        );
      }
      const parsed: unknown = JSON.parse(contents);
      assertStoredDelivery(parsed, idempotencyKey);
      return parsed;
    } catch (error) {
      if (errno(error) === 'ENOENT') return undefined;
      if (error instanceof SlackDeliveryReceiptStoreError) throw error;
      throw new SlackDeliveryReceiptStoreError(
        errno(error) === 'ELOOP' ? 'unsafe' : 'io',
        'Slack delivery receipt could not be read',
      );
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async createAttempt(
    record: SlackStoredDelivery & { status: 'unknown' },
  ): Promise<void> {
    await this.ensureReady();
    const path = join(this.root, recordName(record.idempotency_key));
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      await writeAndSync(handle, `${JSON.stringify(record)}\n`);
      await handle.close();
      handle = undefined;
      await syncDirectory(this.root);
    } catch (error) {
      throw new SlackDeliveryReceiptStoreError(
        errno(error) === 'EEXIST' || errno(error) === 'ELOOP' ? 'unsafe' : 'io',
        'Slack delivery attempt could not be recorded',
      );
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async recordOutcome(record: SlackStoredDelivery): Promise<void> {
    await this.ensureReady();
    const finalPath = join(this.root, recordName(record.idempotency_key));
    const temporaryPath = join(
      this.root,
      `.${recordName(record.idempotency_key)}.${randomUUID()}.tmp`,
    );
    let handle: FileHandle | undefined;
    try {
      const current = await lstat(finalPath);
      if (current.isSymbolicLink() || !current.isFile()) {
        throw new SlackDeliveryReceiptStoreError(
          'unsafe',
          'Slack delivery attempt record is unsafe',
        );
      }
      handle = await open(
        temporaryPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      await writeAndSync(handle, `${JSON.stringify(record)}\n`);
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, finalPath);
      await syncDirectory(this.root);
    } catch (error) {
      if (error instanceof SlackDeliveryReceiptStoreError) throw error;
      throw new SlackDeliveryReceiptStoreError(
        errno(error) === 'ELOOP' ? 'unsafe' : 'io',
        'Slack delivery outcome could not be recorded',
      );
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  async clearAttempt(idempotencyKey: string): Promise<void> {
    await this.ensureReady();
    try {
      await unlink(join(this.root, recordName(idempotencyKey)));
      await syncDirectory(this.root);
    } catch (error) {
      throw new SlackDeliveryReceiptStoreError(
        errno(error) === 'ELOOP' ? 'unsafe' : 'io',
        'Slack delivery attempt could not be cleared',
      );
    }
  }

  private async ensureReady(): Promise<void> {
    try {
      for (const [index, directory] of this.directoryChain.entries()) {
        if (index > 0) {
          try {
            await mkdir(directory, { mode: 0o700 });
          } catch (error) {
            if (errno(error) !== 'EEXIST') throw error;
          }
        }
        const state = await lstat(directory);
        const currentUid = process.getuid?.();
        if (
          state.isSymbolicLink() ||
          !state.isDirectory() ||
          (state.mode & 0o077) !== 0 ||
          (currentUid !== undefined && state.uid !== currentUid)
        ) {
          throw new SlackDeliveryReceiptStoreError(
            'unsafe',
            'Slack delivery receipt store directory is unsafe',
          );
        }
        await access(
          directory,
          constants.R_OK | constants.W_OK | constants.X_OK,
        );
      }
    } catch (error) {
      if (error instanceof SlackDeliveryReceiptStoreError) throw error;
      throw new SlackDeliveryReceiptStoreError(
        errno(error) === 'ELOOP' ? 'unsafe' : 'io',
        'Slack delivery receipt store is unavailable',
      );
    }
  }
}
