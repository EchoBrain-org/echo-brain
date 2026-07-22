import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, open, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, normalize } from 'node:path';
import { createInterface } from 'node:readline';
import type {
  AdapterConfig,
  AdapterConfigValidation,
  AdapterHealth,
  AdapterOperationContext,
  DeliverySurfaceAdapter,
  DeliveryEnvelope,
  DeliveryReceipt,
} from '../../../core/index.js';
import {
  AdapterError,
  assertCanonicalDeliveryEnvelope,
} from '../../../core/index.js';
import {
  acquireProcessFileLock,
  ProcessFileLockError,
} from '../../../infrastructure/filesystem/process-file-lock.js';

export const JSONL_OUTBOX_DELIVERY_SURFACE_ADAPTER_ID = 'jsonl-outbox';
export const JSONL_OUTBOX_DELIVERY_SURFACE_ADAPTER_VERSION = '1.0.0';

const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_STALE_MS = 30_000;

export interface JsonlOutboxDeliverySurfaceOptions {
  now?: () => string;
}

export interface JsonlOutboxRecord {
  schema_version: 1;
  record_type: 'echo-brain.delivery';
  idempotency_key: string;
  external_id: string;
  recorded_at: string;
  envelope: DeliveryEnvelope;
}

interface JsonlOutboxSettings {
  path: string;
  destinationId: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizedTimestamp(value: string): string | null {
  const milliseconds = new Date(value).getTime();
  return Number.isNaN(milliseconds)
    ? null
    : new Date(milliseconds).toISOString();
}

function settingsFrom(config: AdapterConfig): JsonlOutboxSettings {
  const configuredPath = config.settings['path'];
  const configuredDestination = config.settings['destination_id'];
  return {
    path: typeof configuredPath === 'string' ? configuredPath : '',
    destinationId:
      typeof configuredDestination === 'string'
        ? configuredDestination.trim()
        : `outbox:${config.instance_id}`,
  };
}

function stableExternalId(idempotencyKey: string): string {
  const digest = createHash('sha256').update(idempotencyKey).digest('hex');
  return `jsonl-outbox:sha256:${digest}`;
}

function isJsonlOutboxRecord(value: unknown): value is JsonlOutboxRecord {
  if (!isPlainObject(value)) return false;
  const envelope = value['envelope'];
  return (
    value['schema_version'] === 1 &&
    value['record_type'] === 'echo-brain.delivery' &&
    isNonEmptyString(value['idempotency_key']) &&
    isNonEmptyString(value['external_id']) &&
    typeof value['recorded_at'] === 'string' &&
    normalizedTimestamp(value['recorded_at']) === value['recorded_at'] &&
    isPlainObject(envelope) &&
    envelope['schema_version'] === 1 &&
    envelope['idempotency_key'] === value['idempotency_key']
  );
}

function errnoCode(error: unknown): string | undefined {
  return isPlainObject(error) && typeof error['code'] === 'string'
    ? error['code']
    : undefined;
}

function mapFilesystemError(
  error: unknown,
  outcomeMayBeUnknown = false,
): AdapterError {
  if (error instanceof AdapterError) return error;
  const code = errnoCode(error);
  if (
    code === 'EACCES' ||
    code === 'EPERM' ||
    code === 'EROFS' ||
    code === 'ENOENT' ||
    code === 'ENOTDIR' ||
    code === 'ELOOP'
  ) {
    return new AdapterError(
      'permanently_rejected',
      'JSONL outbox path cannot be used securely',
      false,
    );
  }
  return new AdapterError(
    outcomeMayBeUnknown ? 'unknown_outcome' : 'temporarily_unavailable',
    outcomeMayBeUnknown
      ? 'JSONL outbox delivery outcome is unknown'
      : 'JSONL outbox is temporarily unavailable',
    true,
  );
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class JsonlOutboxDeliverySurface implements DeliverySurfaceAdapter {
  readonly identity: DeliverySurfaceAdapter['identity'];
  readonly destination: DeliverySurfaceAdapter['destination'];
  private readonly settings: JsonlOutboxSettings;
  private readonly now: () => string;

  constructor(
    private readonly config: AdapterConfig,
    options: JsonlOutboxDeliverySurfaceOptions = {},
  ) {
    this.settings = settingsFrom(config);
    this.identity = Object.freeze({
      kind: 'delivery-surface' as const,
      adapter_id: JSONL_OUTBOX_DELIVERY_SURFACE_ADAPTER_ID,
      instance_id: config.instance_id,
      version: JSONL_OUTBOX_DELIVERY_SURFACE_ADAPTER_VERSION,
    });
    this.destination = Object.freeze({
      adapter_id: this.identity.adapter_id,
      instance_id: this.identity.instance_id,
      external_id: this.settings.destinationId,
    });
    this.now = options.now ?? (() => new Date().toISOString());
  }

  validateConfig(config: AdapterConfig): AdapterConfigValidation {
    const errors: string[] = [];
    if (config.adapter_id !== JSONL_OUTBOX_DELIVERY_SURFACE_ADAPTER_ID) {
      errors.push(
        `adapter_id must be '${JSONL_OUTBOX_DELIVERY_SURFACE_ADAPTER_ID}'`,
      );
    }
    if (!/^[a-z][a-z0-9-]*$/.test(config.instance_id)) {
      errors.push(
        'instance_id must use lowercase letters, numbers, and hyphens',
      );
    } else if (config.instance_id !== this.identity.instance_id) {
      errors.push('instance_id does not match the registered adapter instance');
    }
    if (config.credential_ref !== undefined) {
      errors.push('credential_ref is not supported by this local adapter');
    }
    const allowedSettings = new Set(['path', 'destination_id']);
    for (const key of Object.keys(config.settings)) {
      if (!allowedSettings.has(key))
        errors.push(`settings.${key} is not supported`);
    }
    const filePath = config.settings['path'];
    if (
      !isNonEmptyString(filePath) ||
      filePath.includes('\0') ||
      !isAbsolute(filePath) ||
      normalize(filePath) !== filePath
    ) {
      errors.push('settings.path must be a normalized absolute file path');
    }
    const destinationId = config.settings['destination_id'];
    if (
      destinationId !== undefined &&
      (!isNonEmptyString(destinationId) ||
        destinationId.length > 256 ||
        /[\u0000-\u001f\u007f]/.test(destinationId))
    ) {
      errors.push(
        'settings.destination_id must be a non-empty printable string',
      );
    }
    return { ok: errors.length === 0, errors };
  }

  async healthCheck(
    operation?: AdapterOperationContext,
  ): Promise<AdapterHealth> {
    this.assertNotCancelled(operation?.signal, 'health check');
    const validation = this.validateConfig(this.config);
    const timestamp = normalizedTimestamp(this.now());
    const checkedAt = timestamp ?? new Date().toISOString();
    if (!validation.ok) {
      return {
        status: 'unavailable',
        checked_at: checkedAt,
        message: 'JSONL outbox configuration is invalid',
        details: { error_count: validation.errors.length },
      };
    }
    if (timestamp === null) {
      return {
        status: 'degraded',
        checked_at: checkedAt,
        message: 'JSONL outbox clock is invalid',
      };
    }
    try {
      await this.assertFilesystemReady();
      this.assertNotCancelled(operation?.signal, 'health check');
      return { status: 'healthy', checked_at: checkedAt };
    } catch (error) {
      const mapped = mapFilesystemError(error);
      return {
        status: mapped.retryable ? 'degraded' : 'unavailable',
        checked_at: checkedAt,
        message: mapped.message,
        details: { retryable: mapped.retryable },
      };
    }
  }

  async publish(
    envelope: DeliveryEnvelope,
    operation?: AdapterOperationContext,
  ): Promise<DeliveryReceipt> {
    this.assertNotCancelled(operation?.signal, 'delivery');
    const validation = this.validateConfig(this.config);
    if (!validation.ok) {
      throw new AdapterError(
        'invalid_config',
        'JSONL outbox configuration is invalid',
        false,
      );
    }
    this.assertEnvelope(envelope);
    const recordedAt = normalizedTimestamp(this.now());
    if (recordedAt === null) {
      throw new AdapterError(
        'temporarily_unavailable',
        'JSONL outbox clock is invalid',
        true,
      );
    }

    await this.assertFilesystemReady();
    this.assertNotCancelled(operation?.signal, 'delivery');
    const release = await this.acquireLock();
    let appendStarted = false;
    try {
      // Check again while holding the process-wide file lock. This makes the
      // idempotency check and append one critical section across adapter
      // instances and processes that honor this format.
      await this.assertFilesystemReady();
      this.assertNotCancelled(operation?.signal, 'delivery');
      const fileExisted = await this.fileExists();
      const handle = await this.openOutbox();
      try {
        await this.repairIncompleteTail(handle, operation?.signal);
        const existing = await this.findRecord(
          handle,
          envelope.idempotency_key,
          operation?.signal,
        );
        if (existing !== undefined) {
          return this.receipt(
            envelope.id,
            existing.external_id,
            existing.recorded_at,
          );
        }

        const record: JsonlOutboxRecord = {
          schema_version: 1,
          record_type: 'echo-brain.delivery',
          idempotency_key: envelope.idempotency_key,
          external_id: stableExternalId(envelope.idempotency_key),
          recorded_at: recordedAt,
          envelope,
        };
        const bytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
        if (bytes.byteLength > MAX_RECORD_BYTES) {
          return this.rejectedReceipt(
            envelope.id,
            recordedAt,
            `JSONL outbox records may not exceed ${MAX_RECORD_BYTES} bytes`,
          );
        }
        appendStarted = true;
        await this.writeAll(handle, bytes);
        await handle.sync();
        if (!fileExisted) await syncDirectory(dirname(this.settings.path));
        return this.receipt(
          envelope.id,
          record.external_id,
          record.recorded_at,
        );
      } finally {
        await handle.close();
      }
    } catch (error) {
      // Preserve adapter-domain failures; filesystem failures are normalized
      // below so callers never receive host paths or platform-specific detail.
      if (error instanceof AdapterError) throw error;
      throw mapFilesystemError(error, appendStarted);
    } finally {
      await release();
    }
  }

  private receipt(
    envelopeId: string,
    externalId: string,
    recordedAt: string,
  ): DeliveryReceipt {
    return {
      schema_version: 1,
      envelope_id: envelopeId,
      status: 'delivered',
      external_id: externalId,
      recorded_at: recordedAt,
      retryable: false,
    };
  }

  private rejectedReceipt(
    envelopeId: string,
    recordedAt: string,
    message: string,
  ): DeliveryReceipt {
    return {
      schema_version: 1,
      envelope_id: envelopeId,
      status: 'rejected',
      external_id: null,
      recorded_at: recordedAt,
      retryable: false,
      message,
    };
  }

  private assertNotCancelled(
    signal: AbortSignal | undefined,
    operation: string,
  ): void {
    if (signal?.aborted === true) {
      throw new AdapterError(
        'timeout',
        `JSONL outbox ${operation} was cancelled`,
        true,
      );
    }
  }

  private assertEnvelope(envelope: DeliveryEnvelope): void {
    try {
      assertCanonicalDeliveryEnvelope(envelope);
    } catch {
      throw new AdapterError(
        'permanently_rejected',
        'delivery envelope is not canonical',
        false,
      );
    }
    if (
      envelope.destination.adapter_id !== this.destination.adapter_id ||
      envelope.destination.instance_id !== this.destination.instance_id ||
      envelope.destination.external_id !== this.destination.external_id
    ) {
      throw new AdapterError(
        'permanently_rejected',
        'delivery envelope does not match the JSONL outbox destination',
        false,
      );
    }
  }

  private async assertFilesystemReady(): Promise<void> {
    try {
      const parent = dirname(this.settings.path);
      const parentStat = await lstat(parent);
      if (!parentStat.isDirectory()) {
        throw new AdapterError(
          'permanently_rejected',
          'JSONL outbox parent is not a directory',
          false,
        );
      }
      await access(parent, constants.W_OK | constants.X_OK);
      try {
        const fileStat = await lstat(this.settings.path);
        if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
          throw new AdapterError(
            'permanently_rejected',
            'JSONL outbox must be a regular file and may not be a symbolic link',
            false,
          );
        }
        if ((fileStat.mode & 0o077) !== 0) {
          throw new AdapterError(
            'permanently_rejected',
            'JSONL outbox permissions may not grant group or other access',
            false,
          );
        }
        const uid = process.getuid?.();
        if (uid !== undefined && fileStat.uid !== uid) {
          throw new AdapterError(
            'permanently_rejected',
            'JSONL outbox must be owned by the current user',
            false,
          );
        }
        await access(this.settings.path, constants.R_OK | constants.W_OK);
      } catch (error) {
        if (errnoCode(error) !== 'ENOENT') throw error;
      }
    } catch (error) {
      throw mapFilesystemError(error);
    }
  }

  private async fileExists(): Promise<boolean> {
    try {
      await lstat(this.settings.path);
      return true;
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') return false;
      throw error;
    }
  }

  private async openOutbox(): Promise<FileHandle> {
    const flags =
      constants.O_RDWR |
      constants.O_APPEND |
      constants.O_CREAT |
      constants.O_NOFOLLOW;
    const handle = await open(this.settings.path, flags, 0o600);
    try {
      const fileStat = await handle.stat();
      if (!fileStat.isFile() || (fileStat.mode & 0o077) !== 0) {
        throw new AdapterError(
          'permanently_rejected',
          'JSONL outbox file is not secure',
          false,
        );
      }
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private async findRecord(
    handle: FileHandle,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<JsonlOutboxRecord | undefined> {
    const input = handle.createReadStream({
      autoClose: false,
      start: 0,
      encoding: 'utf8',
    });
    const lines = createInterface({ input, crlfDelay: Infinity });
    let lineNumber = 0;
    let existing: JsonlOutboxRecord | undefined;
    try {
      for await (const line of lines) {
        this.assertNotCancelled(signal, 'delivery');
        lineNumber += 1;
        if (line.trim().length === 0) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          throw new AdapterError(
            'permanently_rejected',
            `JSONL outbox contains invalid JSON at line ${lineNumber}`,
            false,
          );
        }
        if (!isJsonlOutboxRecord(parsed)) {
          throw new AdapterError(
            'permanently_rejected',
            `JSONL outbox contains an unsupported record at line ${lineNumber}`,
            false,
          );
        }
        if (
          parsed.idempotency_key === idempotencyKey &&
          existing === undefined
        ) {
          existing = parsed;
        }
      }
      return existing;
    } finally {
      lines.close();
    }
  }

  private async repairIncompleteTail(
    handle: FileHandle,
    signal?: AbortSignal,
  ): Promise<void> {
    this.assertNotCancelled(signal, 'delivery');
    const state = await handle.stat();
    if (state.size === 0) return;
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, state.size - 1);
    if (last[0] === 0x0a) return;

    const chunkSize = 64 * 1024;
    let tailStart = 0;
    let end = state.size;
    while (end > 0) {
      this.assertNotCancelled(signal, 'delivery');
      const length = Math.min(chunkSize, end);
      const start = end - length;
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await handle.read(chunk, 0, length, start);
      const newline = chunk.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (newline !== -1) {
        tailStart = start + newline + 1;
        break;
      }
      end = start;
    }

    const tailLength = state.size - tailStart;
    if (tailLength > MAX_RECORD_BYTES) {
      throw new AdapterError(
        'permanently_rejected',
        'JSONL outbox contains an oversized final record',
        false,
      );
    }
    const tail = Buffer.alloc(tailLength);
    let offset = 0;
    while (offset < tail.byteLength) {
      const { bytesRead } = await handle.read(
        tail,
        offset,
        tail.byteLength - offset,
        tailStart + offset,
      );
      if (bytesRead === 0) {
        throw new AdapterError(
          'unknown_outcome',
          'JSONL outbox final record could not be recovered safely',
          true,
        );
      }
      offset += bytesRead;
    }

    // A fully written JSON record can exist without its delimiter when a
    // process exits between the record write and newline visibility. Preserve
    // it and restore the delimiter so the idempotency scan can see it.
    let completeJson = false;
    try {
      JSON.parse(tail.toString('utf8')) as unknown;
      completeJson = true;
    } catch {
      // The fragment-recovery path below handles invalid JSON.
    }
    if (completeJson) {
      await this.writeAll(handle, Buffer.from('\n', 'utf8'));
      await handle.sync();
      return;
    }

    // Only an unparseable fragment is discarded. Surface an unknown outcome
    // for this invocation; the next retry can safely append after the repaired
    // delimiter without silently treating the interrupted write as delivered.
    await handle.truncate(tailStart);
    await handle.sync();
    throw new AdapterError(
      'unknown_outcome',
      'JSONL outbox recovered an incomplete prior delivery record',
      true,
    );
  }

  private async writeAll(handle: FileHandle, bytes: Buffer): Promise<void> {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.write(
        bytes,
        offset,
        bytes.byteLength - offset,
        null,
      );
      if (result.bytesWritten === 0) {
        throw new AdapterError(
          'unknown_outcome',
          'JSONL outbox write made no progress',
          true,
        );
      }
      offset += result.bytesWritten;
    }
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    try {
      const release = await acquireProcessFileLock(
        `${this.settings.path}.lock`,
        {
          timeoutMs: LOCK_TIMEOUT_MS,
          staleMs: LOCK_STALE_MS,
          retryMs: LOCK_RETRY_MS,
        },
      );
      return async () => {
        try {
          await release();
        } catch {
          throw new AdapterError(
            'unknown_outcome',
            'JSONL outbox lock release could not be verified',
            true,
          );
        }
      };
    } catch (error) {
      if (!(error instanceof ProcessFileLockError)) {
        throw mapFilesystemError(error);
      }
      if (error.code === 'busy' || error.code === 'io') {
        throw new AdapterError(
          'temporarily_unavailable',
          'JSONL outbox is busy',
          true,
        );
      }
      throw new AdapterError(
        'invalid_config',
        'JSONL outbox lock path is unsafe',
        false,
      );
    }
  }
}

export function createJsonlOutboxDeliverySurface(
  config: AdapterConfig,
  options: JsonlOutboxDeliverySurfaceOptions = {},
): JsonlOutboxDeliverySurface {
  return new JsonlOutboxDeliverySurface(config, options);
}
