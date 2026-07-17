import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  assertCanonicalDecisionBrief,
  isCanonicalTimestamp,
  type ApprovalDecision,
  type ApprovalGate,
  type ApprovalRequest,
  type DecisionBrief,
} from '../core/index.js';
import { atomicWrite } from '../echo-home/adapters/atomic-write.js';
import { parseJson } from '../util/json.js';
import { acquireProcessFileLock } from '../util/process-file-lock.js';

export interface ManualApprovalRecord {
  schema_version: 1;
  approval_id: string;
  processing_key: string;
  status: ApprovalDecision['status'];
  requested_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  reason: string | null;
  brief: DecisionBrief;
}

export interface ResolveManualApprovalInput {
  approvalId: string;
  status: 'approved' | 'rejected';
  reviewedBy: string;
  reason?: string | null;
}

export interface ManualApprovalQueueOptions {
  now?: () => string;
}

const APPROVAL_LOCK_TIMEOUT_MS = 2_000;
const APPROVAL_LOCK_STALE_MS = 30_000;
const APPROVAL_LOCK_RETRY_MS = 20;

function approvalId(processingKey: string): string {
  return createHash('sha256').update(processingKey).digest('hex');
}

function isIsoTimestamp(value: unknown): value is string {
  return isCanonicalTimestamp(value);
}

function assertRecord(value: unknown, file: string): ManualApprovalRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid manual approval record: ${file}`);
  }
  const record = value as Partial<ManualApprovalRecord>;
  if (
    record.schema_version !== 1 ||
    typeof record.approval_id !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.approval_id) ||
    typeof record.processing_key !== 'string' ||
    !['pending', 'approved', 'rejected'].includes(record.status ?? '') ||
    !isIsoTimestamp(record.requested_at) ||
    record.brief === null ||
    typeof record.brief !== 'object'
  ) {
    throw new Error(`invalid manual approval record: ${file}`);
  }
  if (record.status === 'pending') {
    if (
      record.reviewed_at !== null ||
      record.reviewed_by !== null ||
      record.reason !== null
    ) {
      throw new Error(`invalid pending manual approval record: ${file}`);
    }
  } else if (
    !isIsoTimestamp(record.reviewed_at) ||
    typeof record.reviewed_by !== 'string' ||
    record.reviewed_by.length === 0 ||
    !(record.reason === null || typeof record.reason === 'string')
  ) {
    throw new Error(`invalid resolved manual approval record: ${file}`);
  }
  try {
    assertCanonicalDecisionBrief(record.brief);
  } catch {
    throw new Error(`invalid decision brief in manual approval record: ${file}`);
  }
  return record as ManualApprovalRecord;
}

export class ManualApprovalQueue implements ApprovalGate {
  readonly directory: string;
  private readonly stateDirectory: string;
  private readonly now: () => string;

  constructor(stateDirectory: string, options: ManualApprovalQueueOptions = {}) {
    this.stateDirectory = resolve(stateDirectory);
    this.directory = resolve(this.stateDirectory, 'approvals');
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private ensureDirectory(): void {
    mkdirSync(this.stateDirectory, { recursive: true, mode: 0o700 });
    const root = lstatSync(this.stateDirectory);
    if (root.isSymbolicLink() || !root.isDirectory()) {
      throw new Error('manual approval state root must be a direct directory');
    }
    chmodSync(this.stateDirectory, 0o700);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const approvals = lstatSync(this.directory);
    if (approvals.isSymbolicLink() || !approvals.isDirectory()) {
      throw new Error('manual approval queue must be a direct directory');
    }
    chmodSync(this.directory, 0o700);
  }

  private recordPath(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) {
      throw new Error('approval id must be a 64-character lowercase hex digest');
    }
    return join(this.directory, `${id}.json`);
  }

  private read(path: string): ManualApprovalRecord {
    return assertRecord(parseJson(readFileSync(path, 'utf8')), path);
  }

  private write(path: string, record: ManualApprovalRecord): void {
    atomicWrite({
      filePath: path,
      content: `${JSON.stringify(record, null, 2)}\n`,
      secretSensitive: true,
    });
  }

  private async acquireLock(id: string): Promise<() => Promise<void>> {
    return await acquireProcessFileLock(`${this.recordPath(id)}.lock`, {
      timeoutMs: APPROVAL_LOCK_TIMEOUT_MS,
      staleMs: APPROVAL_LOCK_STALE_MS,
      retryMs: APPROVAL_LOCK_RETRY_MS,
    });
  }

  async review(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.ensureDirectory();
    if (
      typeof request.processing_key !== 'string' ||
      request.processing_key.trim() === '' ||
      !isCanonicalTimestamp(request.requested_at)
    ) {
      throw new Error('manual approval request identity or timestamp is invalid');
    }
    assertCanonicalDecisionBrief(request.brief);
    const id = approvalId(request.processing_key);
    const path = this.recordPath(id);
    const release = await this.acquireLock(id);
    try {
      if (!existsSync(path)) {
        this.write(path, {
          schema_version: 1,
          approval_id: id,
          processing_key: request.processing_key,
          status: 'pending',
          requested_at: request.requested_at,
          reviewed_at: null,
          reviewed_by: null,
          reason: null,
          brief: request.brief,
        });
        return {
          status: 'pending',
          reviewed_at: null,
          reviewed_by: null,
          reason: null,
          approved_brief: null,
        };
      }

      const record = this.read(path);
      if (
        record.approval_id !== id ||
        record.processing_key !== request.processing_key
      ) {
        throw new Error(`manual approval identity mismatch: ${path}`);
      }
      if (record.status === 'pending') {
        return {
          status: 'pending',
          reviewed_at: null,
          reviewed_by: null,
          reason: null,
          approved_brief: null,
        };
      }
      return record.status === 'approved'
        ? {
            status: 'approved',
            reviewed_at: record.reviewed_at as string,
            reviewed_by: record.reviewed_by as string,
            reason: record.reason,
            approved_brief: record.brief,
          }
        : {
            status: 'rejected',
            reviewed_at: record.reviewed_at as string,
            reviewed_by: record.reviewed_by as string,
            reason: record.reason,
            approved_brief: null,
          };
    } finally {
      await release();
    }
  }

  list(): readonly ManualApprovalRecord[] {
    this.ensureDirectory();
    return readdirSync(this.directory)
      .filter((entry) => /^[a-f0-9]{64}\.json$/.test(entry))
      .sort()
      .map((entry) => {
        const record = this.read(join(this.directory, entry));
        if (`${record.approval_id}.json` !== entry) {
          throw new Error(`manual approval filename identity mismatch: ${entry}`);
        }
        return record;
      });
  }

  async resolve(
    input: ResolveManualApprovalInput,
  ): Promise<ManualApprovalRecord> {
    this.ensureDirectory();
    const path = this.recordPath(input.approvalId);
    if (!existsSync(path)) {
      throw new Error(`manual approval request not found: ${input.approvalId}`);
    }
    const release = await this.acquireLock(input.approvalId);
    try {
      const current = this.read(path);
      if (current.approval_id !== input.approvalId) {
        throw new Error(`manual approval identity mismatch: ${path}`);
      }
      if (current.status !== 'pending') {
        if (
          current.status === input.status &&
          current.reviewed_by === input.reviewedBy &&
          current.reason === (input.reason ?? null)
        ) {
          return current;
        }
        throw new Error(
          `manual approval request is already ${current.status}`,
        );
      }
      const resolved: ManualApprovalRecord = {
        ...current,
        status: input.status,
        reviewed_at: this.now(),
        reviewed_by: input.reviewedBy,
        reason: input.reason ?? null,
      };
      this.write(path, resolved);
      return resolved;
    } finally {
      await release();
    }
  }
}
