import { lstatSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '@echo-brain/federation-protocol';
import { atomicWrite } from '../../infrastructure/filesystem/atomic-write.js';
import {
  assertDisjointPaths,
  assertPrivateOwnedDirectory,
  assertPrivateOwnedRegularFile,
  canonicalLocalPath,
  ensureDirectory,
  fsyncDirectory,
  pathEntryExists,
  readFileNoFollow,
  writeFileExclusive,
} from '../secure-local-files.js';
import {
  InternalLiveUpdateError,
  parseInternalLiveUpdateTransaction,
  type InternalLiveUpdateReceiptV1,
  type InternalLiveUpdateStore,
  type InternalLiveUpdateTransactionV1,
} from './internal-live-update.js';

const ACTIVE_TRANSACTION_FILE = 'active-transaction.v1.json';
const RECEIPTS_DIRECTORY = 'receipts';
const MAX_DURABLE_DOCUMENT_BYTES = 64 * 1024;

export interface FileInternalLiveUpdateStoreOptions {
  /** A private directory outside stateDir, so state rollback cannot erase it. */
  directory: string;
  stateDir: string;
}

function invalidPrivateFile(label: string): never {
  throw new InternalLiveUpdateError(
    'invalid_transaction',
    `${label} must be a current-user mode-0600 regular file`,
  );
}

function readBoundedPrivateJson(path: string, label: string): unknown {
  assertPrivateOwnedRegularFile(path, 0o600, () => invalidPrivateFile(label));
  if (lstatSync(path).size > MAX_DURABLE_DOCUMENT_BYTES) {
    throw new InternalLiveUpdateError(
      'invalid_transaction',
      `${label} exceeds the durable document size limit`,
    );
  }
  try {
    return JSON.parse(readFileNoFollow(path, label).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof InternalLiveUpdateError) throw error;
    throw new InternalLiveUpdateError(
      'invalid_transaction',
      `${label} is invalid JSON: ${(error as Error).message}`,
    );
  }
}

function serialized(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Durable local update state. This store intentionally lives outside the
 * product state tree: restoring a pre-update product backup must not rewind
 * the update transaction that authorized that restore.
 */
export class FileInternalLiveUpdateStore implements InternalLiveUpdateStore {
  private readonly directory: string;
  private readonly activePath: string;
  private readonly receiptsDirectory: string;

  constructor(options: FileInternalLiveUpdateStoreOptions) {
    const stateDir = canonicalLocalPath(
      options.stateDir,
      'product state directory',
      true,
    );
    const requestedDirectory = canonicalLocalPath(
      options.directory,
      'internal-live update directory',
      false,
    );
    assertDisjointPaths(
      stateDir,
      requestedDirectory,
      'product state directory',
      'internal-live update directory',
    );
    ensureDirectory(requestedDirectory);
    this.directory = canonicalLocalPath(
      requestedDirectory,
      'internal-live update directory',
      true,
    );
    assertPrivateOwnedDirectory(
      this.directory,
      'internal-live update directory',
    );
    this.receiptsDirectory = join(this.directory, RECEIPTS_DIRECTORY);
    ensureDirectory(this.receiptsDirectory);
    assertPrivateOwnedDirectory(
      this.receiptsDirectory,
      'internal-live update receipts directory',
    );
    this.activePath = join(this.directory, ACTIVE_TRANSACTION_FILE);
  }

  async loadActive(): Promise<InternalLiveUpdateTransactionV1 | null> {
    if (!pathEntryExists(this.activePath)) return null;
    return parseInternalLiveUpdateTransaction(
      readBoundedPrivateJson(this.activePath, 'internal-live update transaction'),
    );
  }

  async saveActive(
    transaction: InternalLiveUpdateTransactionV1,
  ): Promise<void> {
    const validated = parseInternalLiveUpdateTransaction(transaction);
    atomicWrite({
      filePath: this.activePath,
      content: serialized(validated),
      secretSensitive: true,
    });
  }

  async saveReceipt(receipt: InternalLiveUpdateReceiptV1): Promise<void> {
    const path = join(
      this.receiptsDirectory,
      `${receipt.transaction_id}.receipt.v1.json`,
    );
    const content = serialized(receipt);
    if (pathEntryExists(path)) {
      const existing = readBoundedPrivateJson(path, 'internal-live update receipt');
      if (canonicalJson(existing) !== canonicalJson(receipt)) {
        throw new InternalLiveUpdateError(
          'invalid_transaction',
          'an immutable update receipt already exists with different content',
        );
      }
      return;
    }
    try {
      writeFileExclusive(path, content, 0o600);
      fsyncDirectory(this.receiptsDirectory);
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'EEXIST'
      ) {
        const existing = readBoundedPrivateJson(
          path,
          'internal-live update receipt',
        );
        if (canonicalJson(existing) === canonicalJson(receipt)) return;
      }
      throw error;
    }
  }

  /**
   * Clear a successfully reported rollback so a later explicit invocation can
   * retry the same approved release with a fresh transaction identifier.
   */
  async clearReportedRollback(transactionId: string): Promise<void> {
    const active = await this.loadActive();
    if (
      active === null ||
      active.transaction_id !== transactionId ||
      active.phase !== 'rolled_back'
    ) {
      throw new InternalLiveUpdateError(
        'invalid_transaction',
        'reported rollback does not match the active transaction',
      );
    }
    unlinkSync(this.activePath);
    fsyncDirectory(this.directory);
  }
}
