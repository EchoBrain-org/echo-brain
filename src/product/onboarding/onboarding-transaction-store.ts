import { lstatSync } from 'node:fs';
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
  OnboardingTransactionError,
  parseOnboardingReceipt,
  parseOnboardingTransaction,
  type OnboardingReceiptV1,
  type OnboardingTransactionV1,
} from './onboarding-transaction.js';

const ACTIVE_TRANSACTION_FILE = 'active-transaction.v1.json';
const RECEIPTS_DIRECTORY = 'receipts';
const MAX_DURABLE_DOCUMENT_BYTES = 64 * 1024;

export interface FileOnboardingTransactionStoreOptions {
  /** A private directory outside stateDir, so state restore cannot erase it. */
  directory: string;
  stateDir: string;
}

function invalidPrivateFile(label: string): never {
  throw new OnboardingTransactionError(
    'invalid_transaction',
    `${label} must be a current-user mode-0600 regular file`,
  );
}

function readBoundedPrivateJson(path: string, label: string): unknown {
  assertPrivateOwnedRegularFile(path, 0o600, () => invalidPrivateFile(label));
  if (lstatSync(path).size > MAX_DURABLE_DOCUMENT_BYTES) {
    throw new OnboardingTransactionError(
      'invalid_transaction',
      `${label} exceeds the durable document size limit`,
    );
  }
  try {
    return JSON.parse(readFileNoFollow(path, label).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof OnboardingTransactionError) throw error;
    throw new OnboardingTransactionError(
      'invalid_transaction',
      `${label} is invalid JSON: ${(error as Error).message}`,
    );
  }
}

function serialized(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Durable local onboarding state. The store lives outside the product state
 * tree so a later state restore can never rewind or erase the onboarding
 * transaction that authorized it, and it never holds a secret: invitation,
 * challenge, credential, and key material stay in their private stores.
 */
export class FileOnboardingTransactionStore {
  private readonly directory: string;
  private readonly activePath: string;
  private readonly receiptsDirectory: string;

  constructor(options: FileOnboardingTransactionStoreOptions) {
    // Onboarding starts before the state directory exists; the canonical
    // path is needed only to prove the store lives outside it.
    const stateDir = canonicalLocalPath(
      options.stateDir,
      'product state directory',
      false,
    );
    const requestedDirectory = canonicalLocalPath(
      options.directory,
      'onboarding transaction directory',
      false,
    );
    assertDisjointPaths(
      stateDir,
      requestedDirectory,
      'product state directory',
      'onboarding transaction directory',
    );
    ensureDirectory(requestedDirectory);
    this.directory = canonicalLocalPath(
      requestedDirectory,
      'onboarding transaction directory',
      true,
    );
    assertPrivateOwnedDirectory(
      this.directory,
      'onboarding transaction directory',
    );
    this.receiptsDirectory = join(this.directory, RECEIPTS_DIRECTORY);
    ensureDirectory(this.receiptsDirectory);
    assertPrivateOwnedDirectory(
      this.receiptsDirectory,
      'onboarding receipts directory',
    );
    this.activePath = join(this.directory, ACTIVE_TRANSACTION_FILE);
  }

  async loadActive(): Promise<OnboardingTransactionV1 | null> {
    if (!pathEntryExists(this.activePath)) return null;
    return parseOnboardingTransaction(
      readBoundedPrivateJson(this.activePath, 'onboarding transaction'),
    );
  }

  async saveActive(transaction: OnboardingTransactionV1): Promise<void> {
    const validated = parseOnboardingTransaction(transaction);
    atomicWrite({
      filePath: this.activePath,
      content: serialized(validated),
      secretSensitive: true,
    });
  }

  async saveReceipt(receipt: OnboardingReceiptV1): Promise<void> {
    const validated = parseOnboardingReceipt(receipt);
    const path = join(
      this.receiptsDirectory,
      `${validated.flow_id}.receipt.v1.json`,
    );
    const content = serialized(validated);
    const conflict = (): never => {
      throw new OnboardingTransactionError(
        'invalid_transaction',
        'an immutable onboarding receipt already exists with different content',
      );
    };
    if (pathEntryExists(path)) {
      const existing = readBoundedPrivateJson(path, 'onboarding receipt');
      if (canonicalJson(existing) !== canonicalJson(validated)) conflict();
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
        const existing = readBoundedPrivateJson(path, 'onboarding receipt');
        if (canonicalJson(existing) === canonicalJson(validated)) return;
        conflict();
      }
      throw error;
    }
  }
}
