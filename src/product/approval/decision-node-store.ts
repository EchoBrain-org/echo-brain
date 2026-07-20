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
import { ActiveIdentityBundleStore } from '../federation/identity/active-identity-bundle-store.js';
import { requiresFounderFederation } from '../federation/cutover-fence.js';
import {
  assertDecisionPublishedEvent,
  assertDecisionRequestedEvent,
  assertDecisionResolvedEvent,
  decisionApprovalId,
  foldDecisionNode,
  type DecisionNodeEvents,
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
const LEGACY_IMPORT_MARKER = '.legacy-approvals-imported-v1';
const PUBLISHED_FILE_RE = /^published-([a-z][a-z0-9-]*)\.json$/;

function isFederatedDecisionNode(events: DecisionNodeEvents): boolean {
  return Object.hasOwn(events.requested.metadata, 'federation');
}

export interface DecisionNodeStoreOptions {
  now?: () => string;
  createId?: () => string;
  federationCapture?: DecisionNodeFederationCapture;
}

export interface RecordPublishedInput {
  processingKey: string;
  surface: string;
  reference: JsonObject;
  /** Provider evidence used only by identity-enabled capture. */
  presentationEvidence?: JsonObject;
}

export interface ResolveDecisionNodeInput {
  approvalId: string;
  status: 'approved' | 'rejected';
  reviewedBy: string;
  reason?: string | null;
  surface: string;
  metadata?: JsonObject;
  /** Provider actor/tool evidence used only by identity-enabled capture. */
  resolutionEvidence?: JsonObject;
}

export interface DecisionNodeFederationCapture {
  captureRequested(request: ApprovalRequest): Promise<JsonObject>;
  validateRequested(
    event: DecisionRequestedEvent,
    request?: ApprovalRequest,
  ): Promise<void>;
  capturePublished(input: {
    events: DecisionNodeEvents;
    surface: string;
    reference: JsonObject;
    presentationEvidence?: JsonObject;
    postedAt: string;
  }): Promise<JsonObject>;
  validatePublished(input: {
    events: DecisionNodeEvents;
    event: DecisionPublishedEvent;
  }): Promise<void>;
  captureResolved(input: {
    events: DecisionNodeEvents;
    status: 'approved' | 'rejected';
    reviewedAt: string;
    reviewedBy: string;
    reason: string | null;
    surface: string;
    legacyMetadata: JsonObject;
    resolutionEvidence?: JsonObject;
  }): Promise<JsonObject>;
  validateResolved(input: {
    events: DecisionNodeEvents;
    event: DecisionResolvedEvent;
  }): Promise<void>;
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
  private readonly federationCapture: DecisionNodeFederationCapture | undefined;
  private initialized = false;

  constructor(stateDirectory: string, options: DecisionNodeStoreOptions = {}) {
    this.stateDirectory = resolve(stateDirectory);
    this.directory = resolve(this.stateDirectory, 'decisions');
    this.locksDirectory = resolve(this.directory, '.locks');
    this.legacyDirectory = resolve(this.stateDirectory, 'approvals');
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? randomUUID;
    this.federationCapture = options.federationCapture;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.ensureDirectory(this.stateDirectory, 'decision store state root');
    this.ensureDirectory(this.directory, 'decision store');
    this.ensureDirectory(this.locksDirectory, 'decision store locks');
    const identityEnabled = this.assertFederationCaptureAvailable();
    if (!identityEnabled) await this.importLegacyRecords();
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
      this.assertFederationCaptureAvailable();
      if (!existsSync(requestedPath)) {
        // The core cycle recompiles the brief with a fresh id on every
        // pending retry. The first stored request is the reviewed artifact;
        // retry differences are intentionally ignored.
        const metadata =
          this.federationCapture === undefined
            ? {}
            : await this.federationCapture.captureRequested(request);
        const event: DecisionRequestedEvent = {
          schema_version: 1,
          event_type: 'requested',
          node_id: this.createId(),
          processing_key: request.processing_key,
          requested_at: request.requested_at,
          brief: request.brief,
          alternatives: [],
          links: { parent: null, supersedes: null },
          metadata,
        };
        if (this.federationCapture !== undefined) {
          await this.federationCapture.validateRequested(event, request);
        }
        this.ensureDirectory(nodeDirectory, 'decision node');
        this.createSlot(requestedPath, event);
      } else if (this.federationCapture !== undefined) {
        const existing = assertDecisionRequestedEvent(
          this.readSlot(requestedPath),
          requestedPath,
        );
        await this.federationCapture.validateRequested(existing, request);
      }
      const events = this.readEvents(approvalId);
      await this.validateCapturedEvents(events);
      return foldDecisionNode(events);
    } finally {
      await release();
    }
  }

  async recordPublished(
    input: RecordPublishedInput,
  ): Promise<DecisionNodeState> {
    await this.initialize();
    const approvalId = decisionApprovalId(input.processingKey);
    const release = await this.acquireLock(approvalId);
    try {
      const identityEnabled = this.assertFederationCaptureAvailable();
      const events = this.readEvents(approvalId);
      await this.validateCapturedEvents(events);
      if (identityEnabled && !isFederatedDecisionNode(events)) {
        throw new Error(
          'pre-cutover decision node is immutable after identity activation',
        );
      }
      const state = foldDecisionNode(events);
      const path = join(
        this.nodePath(approvalId),
        `published-${input.surface}.json`,
      );
      if (!existsSync(path)) {
        const postedAt = this.now();
        const reference =
          this.federationCapture === undefined
            ? input.reference
            : await this.federationCapture.capturePublished({
                events,
                surface: input.surface,
                reference: input.reference,
                ...(input.presentationEvidence === undefined
                  ? {}
                  : { presentationEvidence: input.presentationEvidence }),
                postedAt,
              });
        const event: DecisionPublishedEvent = {
          schema_version: 1,
          event_type: 'published',
          node_id: state.node_id,
          surface: input.surface,
          posted_at: postedAt,
          reference,
        };
        assertDecisionPublishedEvent(event, path);
        if (this.federationCapture !== undefined) {
          await this.federationCapture.validatePublished({
            events: { ...events, published: [...events.published, event] },
            event,
          });
        }
        this.createSlot(path, event);
      } else {
        // `validateCapturedEvents(events)` above already authenticated this
        // immutable slot. Return those exact bytes without a redundant second
        // read/validation pass.
        return state;
      }
      const updated = this.readEvents(approvalId);
      await this.validateCapturedEvents(updated);
      return foldDecisionNode(updated);
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
      const identityEnabled = this.assertFederationCaptureAvailable();
      const events = this.readEvents(approvalId);
      await this.validateCapturedEvents(events);
      if (identityEnabled && !isFederatedDecisionNode(events)) {
        throw new Error(
          'pre-cutover decision node is immutable after identity activation',
        );
      }
      const current = foldDecisionNode(events);
      if (current.status !== 'pending') {
        // The full requested/published/resolved history was authenticated by
        // `validateCapturedEvents` immediately above.
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
      const reviewedAt = this.now();
      const reason = input.reason ?? null;
      const legacyMetadata = input.metadata ?? {};
      const metadata =
        this.federationCapture === undefined
          ? legacyMetadata
          : await this.federationCapture.captureResolved({
              events,
              status: input.status,
              reviewedAt,
              reviewedBy: input.reviewedBy,
              reason,
              surface: input.surface,
              legacyMetadata,
              ...(input.resolutionEvidence === undefined
                ? {}
                : { resolutionEvidence: input.resolutionEvidence }),
            });
      const event: DecisionResolvedEvent = {
        schema_version: 1,
        event_type: 'resolved',
        node_id: current.node_id,
        status: input.status,
        reviewed_at: reviewedAt,
        reviewed_by: input.reviewedBy,
        reason,
        surface: input.surface,
        metadata,
      };
      assertDecisionResolvedEvent(event, path);
      if (this.federationCapture !== undefined) {
        await this.federationCapture.validateResolved({
          events: { ...events, resolved: event },
          event,
        });
      }
      this.createSlot(path, event);
      const updated = this.readEvents(approvalId);
      await this.validateCapturedEvents(updated);
      return foldDecisionNode(updated);
    } finally {
      await release();
    }
  }

  async getState(
    processingKey: string,
  ): Promise<DecisionNodeState | undefined> {
    await this.initialize();
    const approvalId = decisionApprovalId(processingKey);
    if (!existsSync(join(this.nodePath(approvalId), REQUESTED_FILE))) {
      return undefined;
    }
    const events = this.readEvents(approvalId);
    await this.validateCapturedEvents(events);
    return foldDecisionNode(events);
  }

  async list(): Promise<readonly DecisionNodeState[]> {
    await this.initialize();
    const events = readdirSync(this.directory)
      .filter((entry) => APPROVAL_ID_RE.test(entry))
      .sort()
      .map((entry) => this.readEvents(entry));
    for (const item of events) await this.validateCapturedEvents(item);
    return events.map(foldDecisionNode);
  }

  /**
   * Enumerate only structurally federated nodes for integrity/reconciliation
   * checks. Pre-cutover nodes intentionally have no `metadata.federation` and
   * remain local disposable/legacy evidence after identity activation, so a
   * verifier must not reinterpret or reject them as native records.
   */
  async listFederated(): Promise<readonly DecisionNodeState[]> {
    await this.initialize();
    const events = readdirSync(this.directory)
      .filter((entry) => APPROVAL_ID_RE.test(entry))
      .sort()
      .map((entry) => this.readEvents(entry))
      .filter(isFederatedDecisionNode);
    for (const item of events) await this.validateCapturedEvents(item);
    return events.map(foldDecisionNode);
  }

  private assertApprovalId(id: string): string {
    if (!APPROVAL_ID_RE.test(id)) {
      throw new Error(
        'approval id must be a 64-character lowercase hex digest',
      );
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

  private readEvents(approvalId: string): DecisionNodeEvents {
    const nodeDirectory = this.nodePath(approvalId);
    const requestedPath = join(nodeDirectory, REQUESTED_FILE);
    const requested = assertDecisionRequestedEvent(
      this.readSlot(requestedPath),
      requestedPath,
    );
    if (decisionApprovalId(requested.processing_key) !== approvalId) {
      throw new Error(
        `decision node directory identity mismatch: ${approvalId}`,
      );
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
    return {
      approval_id: approvalId,
      requested,
      published,
      resolved,
    };
  }

  private assertFederationCaptureAvailable(): boolean {
    const identity = new ActiveIdentityBundleStore(this.stateDirectory);
    const required = requiresFounderFederation(this.stateDirectory, identity);
    if (required && this.federationCapture === undefined) {
      throw new Error(
        'identity-enabled decision capture is unavailable; legacy approval mutation is forbidden',
      );
    }
    return required;
  }

  private async validateCapturedEvents(
    events: DecisionNodeEvents,
  ): Promise<void> {
    if (!isFederatedDecisionNode(events)) {
      // The immutable requested event is the classification boundary. Later
      // surface references and resolution metadata are opaque legacy fields;
      // a federation-shaped value there must never retroactively promote a
      // pre-cutover node into the federated/exportable record set.
      return;
    }
    if (this.federationCapture === undefined) {
      throw new Error(
        'stored federated approval cannot be read without identity capture validation',
      );
    }
    await this.federationCapture.validateRequested(events.requested);
    for (const event of events.published) {
      await this.federationCapture.validatePublished({ events, event });
    }
    if (events.resolved !== undefined) {
      await this.federationCapture.validateResolved({
        events,
        event: events.resolved,
      });
    }
  }

  /**
   * One-time conversion of pre-store `<state>/approvals/*.json` records.
   * Idempotent: a node that already has a requested slot is never touched,
   * so re-running an import can only fill gaps, not overwrite decisions.
   * Old binaries must be stopped during cutover; the legacy files are left
   * in place afterwards and ignored.
   */
  private async importLegacyRecords(): Promise<void> {
    const markerPath = join(this.directory, LEGACY_IMPORT_MARKER);
    if (existsSync(markerPath)) return;
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
    atomicCreate({
      filePath: markerPath,
      content: `${JSON.stringify({ schema_version: 1, imported_at: this.now() })}\n`,
    });
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
