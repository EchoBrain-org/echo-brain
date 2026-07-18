import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  assertCanonicalDecisionBrief,
  isCanonicalTimestamp,
  type ApprovalRequest,
  type JsonObject,
} from '../../core/index.js';
import { atomicCreate } from '../../infrastructure/filesystem/atomic-create.js';
import { parseJson } from '../../util/json.js';
import { acquireProcessFileLock } from '../../util/process-file-lock.js';
import {
  assertDecisionPublishedEvent,
  assertDecisionRequestedEvent,
  assertDecisionResolvedEvent,
  decisionApprovalId,
  foldDecisionNode,
  type DecisionNodeState,
  type DecisionPublishedEvent,
  type DecisionRequestedEvent,
  type DecisionResolvedEvent,
} from './decision-node.js';
import { readLegacyManualApprovalRecords } from './legacy-manual-approval-import.js';

const LOCK_TIMEOUT_MS = 2_000;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 20;
const APPROVAL_ID_RE = /^[a-f0-9]{64}$/;
const REQUESTED_FILE = 'requested.json';
const RESOLVED_FILE = 'resolved.json';
const PUBLISHED_FILE_RE = /^published-([a-z][a-z0-9-]*)\.json$/;

export interface DecisionNodeStoreOptions {
  now?: () => string;
  createId?: () => string;
}

export interface RecordPublishedInput {
  processingKey: string;
  surface: string;
  reference: JsonObject;
}

export interface ResolveDecisionNodeInput {
  approvalId: string;
  status: 'approved' | 'rejected';
  reviewedBy: string;
  reason?: string | null;
  surface: string;
  metadata?: JsonObject;
}

/**
 * Append-only decision node store. Every node is a directory of immutable
 * slot files (`requested.json`, `published-<surface>.json`,
 * `resolved.json`); slots are created exactly once and never rewritten.
 * Any approval surface (CLI, Slack, ...) resolves against this same store,
 * so no single surface outage can block approval.
 */
export class DecisionNodeStore {
  readonly directory: string;
  private readonly stateDirectory: string;
  private readonly locksDirectory: string;
  private readonly legacyDirectory: string;
  private readonly now: () => string;
  private readonly createId: () => string;
  private initialized = false;

  constructor(stateDirectory: string, options: DecisionNodeStoreOptions = {}) {
    this.stateDirectory = resolve(stateDirectory);
    this.directory = resolve(this.stateDirectory, 'decisions');
    this.locksDirectory = resolve(this.directory, '.locks');
    this.legacyDirectory = resolve(this.stateDirectory, 'approvals');
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? randomUUID;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.ensureDirectory(this.stateDirectory, 'decision store state root');
    this.ensureDirectory(this.directory, 'decision store');
    this.ensureDirectory(this.locksDirectory, 'decision store locks');
    await this.importLegacyRecords();
    this.initialized = true;
  }

  async ensureRequested(request: ApprovalRequest): Promise<DecisionNodeState> {
    await this.initialize();
    if (
      typeof request.processing_key !== 'string' ||
      request.processing_key.trim() === '' ||
      !isCanonicalTimestamp(request.requested_at)
    ) {
      throw new Error('decision node request identity or timestamp is invalid');
    }
    assertCanonicalDecisionBrief(request.brief);
    const approvalId = decisionApprovalId(request.processing_key);
    const release = await this.acquireLock(approvalId);
    try {
      const nodeDirectory = this.nodePath(approvalId);
      const requestedPath = join(nodeDirectory, REQUESTED_FILE);
      if (!existsSync(requestedPath)) {
        this.ensureDirectory(nodeDirectory, 'decision node');
        // The core cycle recompiles the brief with a fresh id on every
        // pending retry. The first stored request is the reviewed artifact;
        // retry differences are intentionally ignored.
        const event: DecisionRequestedEvent = {
          schema_version: 1,
          event_type: 'requested',
          node_id: this.createId(),
          processing_key: request.processing_key,
          requested_at: request.requested_at,
          brief: request.brief,
          alternatives: [],
          links: { parent: null, supersedes: null },
          metadata: {},
        };
        this.createSlot(requestedPath, event);
      }
      return this.fold(approvalId);
    } finally {
      await release();
    }
  }

  async recordPublished(input: RecordPublishedInput): Promise<DecisionNodeState> {
    await this.initialize();
    const approvalId = decisionApprovalId(input.processingKey);
    const release = await this.acquireLock(approvalId);
    try {
      const state = this.fold(approvalId);
      const path = join(this.nodePath(approvalId), `published-${input.surface}.json`);
      if (!existsSync(path)) {
        const event: DecisionPublishedEvent = {
          schema_version: 1,
          event_type: 'published',
          node_id: state.node_id,
          surface: input.surface,
          posted_at: this.now(),
          reference: input.reference,
        };
        assertDecisionPublishedEvent(event, path);
        this.createSlot(path, event);
      }
      return this.fold(approvalId);
    } finally {
      await release();
    }
  }

  async resolve(input: ResolveDecisionNodeInput): Promise<DecisionNodeState> {
    await this.initialize();
    const approvalId = this.assertApprovalId(input.approvalId);
    const release = await this.acquireLock(approvalId);
    try {
      if (!existsSync(join(this.nodePath(approvalId), REQUESTED_FILE))) {
        throw new Error(`decision node not found: ${approvalId}`);
      }
      const current = this.fold(approvalId);
      if (current.status !== 'pending') {
        // Same idempotent-retry contract as the pre-store manual queue:
        // repeating the winning resolution succeeds, conflicting ones fail.
        if (
          current.status === input.status &&
          current.reviewed_by === input.reviewedBy &&
          current.reason === (input.reason ?? null)
        ) {
          return current;
        }
        throw new Error(`decision node is already ${current.status}`);
      }
      const path = join(this.nodePath(approvalId), RESOLVED_FILE);
      const event: DecisionResolvedEvent = {
        schema_version: 1,
        event_type: 'resolved',
        node_id: current.node_id,
        status: input.status,
        reviewed_at: this.now(),
        reviewed_by: input.reviewedBy,
        reason: input.reason ?? null,
        surface: input.surface,
        metadata: input.metadata ?? {},
      };
      assertDecisionResolvedEvent(event, path);
      this.createSlot(path, event);
      return this.fold(approvalId);
    } finally {
      await release();
    }
  }

  async getState(processingKey: string): Promise<DecisionNodeState | undefined> {
    await this.initialize();
    const approvalId = decisionApprovalId(processingKey);
    if (!existsSync(join(this.nodePath(approvalId), REQUESTED_FILE))) {
      return undefined;
    }
    return this.fold(approvalId);
  }

  async list(): Promise<readonly DecisionNodeState[]> {
    await this.initialize();
    return readdirSync(this.directory)
      .filter((entry) => APPROVAL_ID_RE.test(entry))
      .sort()
      .map((entry) => this.fold(entry));
  }

  private assertApprovalId(id: string): string {
    if (!APPROVAL_ID_RE.test(id)) {
      throw new Error('approval id must be a 64-character lowercase hex digest');
    }
    return id;
  }

  private nodePath(approvalId: string): string {
    return join(this.directory, this.assertApprovalId(approvalId));
  }

  private ensureDirectory(path: string, label: string): void {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const state = lstatSync(path);
    if (state.isSymbolicLink() || !state.isDirectory()) {
      throw new Error(`${label} must be a direct directory`);
    }
    chmodSync(path, 0o700);
  }

  private createSlot(path: string, event: unknown): void {
    atomicCreate({
      filePath: path,
      content: `${JSON.stringify(event, null, 2)}\n`,
    });
  }

  private readSlot(path: string): unknown {
    return parseJson(readFileSync(path, 'utf8'));
  }

  private fold(approvalId: string): DecisionNodeState {
    const nodeDirectory = this.nodePath(approvalId);
    const requestedPath = join(nodeDirectory, REQUESTED_FILE);
    const requested = assertDecisionRequestedEvent(
      this.readSlot(requestedPath),
      requestedPath,
    );
    if (decisionApprovalId(requested.processing_key) !== approvalId) {
      throw new Error(`decision node directory identity mismatch: ${approvalId}`);
    }
    const published = readdirSync(nodeDirectory)
      .filter((entry) => PUBLISHED_FILE_RE.test(entry))
      .sort()
      .map((entry) => {
        const path = join(nodeDirectory, entry);
        const event = assertDecisionPublishedEvent(this.readSlot(path), path);
        if (`published-${event.surface}.json` !== entry) {
          throw new Error(`decision node published slot mismatch: ${path}`);
        }
        return event;
      });
    const resolvedPath = join(nodeDirectory, RESOLVED_FILE);
    const resolved = existsSync(resolvedPath)
      ? assertDecisionResolvedEvent(this.readSlot(resolvedPath), resolvedPath)
      : undefined;
    return foldDecisionNode({
      approval_id: approvalId,
      requested,
      published,
      resolved,
    });
  }

  /**
   * One-time conversion of pre-store `<state>/approvals/*.json` records.
   * Idempotent: a node that already has a requested slot is never touched,
   * so re-running an import can only fill gaps, not overwrite decisions.
   * Old binaries must be stopped during cutover; the legacy files are left
   * in place afterwards and ignored.
   */
  private async importLegacyRecords(): Promise<void> {
    const records = readLegacyManualApprovalRecords(this.legacyDirectory);
    for (const record of records) {
      const nodeDirectory = this.nodePath(record.approval_id);
      const requestedPath = join(nodeDirectory, REQUESTED_FILE);
      const release = await this.acquireLock(record.approval_id);
      try {
        if (!existsSync(requestedPath)) {
          this.ensureDirectory(nodeDirectory, 'decision node');
          const requested: DecisionRequestedEvent = {
            schema_version: 1,
            event_type: 'requested',
            node_id: record.approval_id,
            processing_key: record.processing_key,
            requested_at: record.requested_at,
            brief: record.brief,
            alternatives: [],
            links: { parent: null, supersedes: null },
            metadata: { imported_from: 'manual-approval-queue' },
          };
          this.createSlot(requestedPath, requested);
        }
        const resolvedPath = join(nodeDirectory, RESOLVED_FILE);
        if (record.status !== 'pending' && !existsSync(resolvedPath)) {
          const resolved: DecisionResolvedEvent = {
            schema_version: 1,
            event_type: 'resolved',
            node_id: record.approval_id,
            status: record.status,
            reviewed_at: record.reviewed_at as string,
            reviewed_by: record.reviewed_by as string,
            reason: record.reason,
            surface: 'cli',
            metadata: { imported_from: 'manual-approval-queue' },
          };
          this.createSlot(resolvedPath, resolved);
        }
      } finally {
        await release();
      }
    }
  }

  private async acquireLock(approvalId: string): Promise<() => Promise<void>> {
    return await acquireProcessFileLock(
      join(this.locksDirectory, this.assertApprovalId(approvalId)),
      {
        timeoutMs: LOCK_TIMEOUT_MS,
        staleMs: LOCK_STALE_MS,
        retryMs: LOCK_RETRY_MS,
      },
    );
  }
}
