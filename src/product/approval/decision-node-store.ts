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
import { acquireProcessFileLock } from '../../infrastructure/filesystem/process-file-lock.js';
import { assertFounderProvenanceRetired } from '../retired-founder-provenance.js';
import {
  assertDecisionOrganizationRecordEnvelopeEvent,
  assertDecisionOrganizationRecordReceipt,
  assertDecisionOrganizationRecordRejectionEvent,
  assertDecisionPublishedEvent,
  assertDecisionRequestedEvent,
  assertDecisionResolvedEvent,
  assertDecisionSourceLocator,
  decisionApprovalId,
  foldDecisionNode,
  ORGANIZATION_RECORD_SURFACE,
  type DecisionNodeEvents,
  type DecisionNodeState,
  type DecisionOrganizationRecordEnvelopeEvent,
  type DecisionOrganizationRecordReceipt,
  type DecisionOrganizationRecordRejectionEvent,
  type DecisionPublishedEvent,
  type DecisionRequestedEvent,
  type DecisionResolvedEvent,
} from './decision-node.js';
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 20;
const APPROVAL_ID_RE = /^[a-f0-9]{64}$/;
const REQUESTED_FILE = 'requested.json';
const RESOLVED_FILE = 'resolved.json';
const ORGANIZATION_RECORD_ENVELOPE_FILE = 'organization-record-envelope.json';
const ORGANIZATION_RECORD_REJECTED_FILE = 'organization-record-rejected.json';
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

export interface CreateOrganizationRecordEnvelopeInput {
  approvalId: string;
  recordEventType: 'approval' | 'rejection';
  envelopeId: string;
  idempotencyKey: string;
  envelopeSha256: string;
  envelope: JsonObject;
}

export interface RecordOrganizationRecordReceiptInput {
  approvalId: string;
  receipt: DecisionOrganizationRecordReceipt;
}

export interface RecordOrganizationRecordRejectionInput {
  approvalId: string;
  reasonCode: string;
  reason: string;
}

export type DecisionNodeSkipReason = 'retired_federation' | 'unreadable';

export interface DecisionNodeSkip {
  approval_id: string;
  reason: DecisionNodeSkipReason;
  detail: string;
}

export interface DecisionNodeSubmissionListing {
  nodes: readonly DecisionNodeState[];
  skipped: readonly DecisionNodeSkip[];
}

/**
 * Append-only decision node store. Every node is a directory of immutable
 * slot files (`requested.json`, `published-<surface>.json`,
 * `resolved.json`); slots are created exactly once and never rewritten.
 * The organization-authorized Slack surface is the V1 resolver; the product
 * CLI exposes this shared local store for durable inspection only.
 */
export class DecisionNodeStore {
  readonly directory: string;
  private readonly stateDirectory: string;
  private readonly locksDirectory: string;
  private readonly now: () => string;
  private readonly createId: () => string;
  private initialized = false;

  constructor(stateDirectory: string, options: DecisionNodeStoreOptions = {}) {
    this.stateDirectory = resolve(stateDirectory);
    this.directory = resolve(this.stateDirectory, 'decisions');
    this.locksDirectory = resolve(this.directory, '.locks');
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? randomUUID;
  }

  async initialize(): Promise<void> {
    // Before the memoized early return and before any directory is created.
    // Founder material can appear between operations on an already-initialized
    // store, so the retirement fence stays ahead of the memoized early return.
    assertFounderProvenanceRetired(this.stateDirectory);
    if (this.initialized) return;
    this.ensureDirectory(this.stateDirectory, 'decision store state root');
    this.ensureDirectory(this.directory, 'decision store');
    this.ensureDirectory(this.locksDirectory, 'decision store locks');
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
      assertFounderProvenanceRetired(this.stateDirectory);
      if (!existsSync(requestedPath)) {
        // The core cycle recompiles the brief with a fresh id on every
        // pending retry. The first stored request is the reviewed artifact;
        // retry differences are intentionally ignored.
        //
        // The source locator is persisted here, at the one moment the meeting
        // provenance is in hand, so no later consumer has to reconstruct it
        // from the opaque processing key.
        const provenance = request.meeting?.provenance;
        const source = assertDecisionSourceLocator(
          {
            adapter_id: provenance?.source?.adapter_id,
            instance_id: provenance?.source?.instance_id,
            external_id: provenance?.external_id,
          },
          requestedPath,
        );
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
          source,
        };
        this.ensureDirectory(nodeDirectory, 'decision node');
        this.createSlot(requestedPath, event);
      }
      const events = this.readEvents(approvalId);
      this.assertNoRetiredFederation(events);
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
      assertFounderProvenanceRetired(this.stateDirectory);
      const events = this.readEvents(approvalId);
      this.assertNoRetiredFederation(events);
      const state = foldDecisionNode(events);
      const path = join(
        this.nodePath(approvalId),
        `published-${input.surface}.json`,
      );
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
      } else {
        return state;
      }
      const updated = this.readEvents(approvalId);
      this.assertNoRetiredFederation(updated);
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
      assertFounderProvenanceRetired(this.stateDirectory);
      const events = this.readEvents(approvalId);
      this.assertNoRetiredFederation(events);
      const current = foldDecisionNode(events);
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
      const reviewedAt = this.now();
      const reason = input.reason ?? null;
      const event: DecisionResolvedEvent = {
        schema_version: 1,
        event_type: 'resolved',
        node_id: current.node_id,
        status: input.status,
        reviewed_at: reviewedAt,
        reviewed_by: input.reviewedBy,
        reason,
        surface: input.surface,
        metadata: input.metadata ?? {},
      };
      assertDecisionResolvedEvent(event, path);
      this.createSlot(path, event);
      const updated = this.readEvents(approvalId);
      this.assertNoRetiredFederation(updated);
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
    this.assertNoRetiredFederation(events);
    return foldDecisionNode(events);
  }

  async list(): Promise<readonly DecisionNodeState[]> {
    await this.initialize();
    const events = readdirSync(this.directory)
      .filter((entry) => APPROVAL_ID_RE.test(entry))
      .sort()
      .map((entry) => this.readEvents(entry));
    for (const item of events) this.assertNoRetiredFederation(item);
    return events.map(foldDecisionNode);
  }

  /**
   * Submitter-specific enumeration. `list()` stays fail-closed for operators:
   * one historical federation node poisons the whole listing, which is the
   * correct answer for an inspection command. A sweep instead needs every
   * healthy node plus a structured account of what it could not read, so a
   * single unreadable node cannot stall organization ingest for the rest.
   */
  async listForSubmission(): Promise<DecisionNodeSubmissionListing> {
    await this.initialize();
    const nodes: DecisionNodeState[] = [];
    const skipped: DecisionNodeSkip[] = [];
    for (const approvalId of readdirSync(this.directory)
      .filter((entry) => APPROVAL_ID_RE.test(entry))
      .sort()) {
      try {
        const events = this.readEvents(approvalId);
        this.assertNoRetiredFederation(events);
        nodes.push(foldDecisionNode(events));
      } catch (error) {
        const detail = (error as Error).message;
        skipped.push({
          approval_id: approvalId,
          reason: detail.includes('retired federation metadata')
            ? 'retired_federation'
            : 'unreadable',
          detail,
        });
      }
    }
    return { nodes, skipped };
  }

  /**
   * Freeze the exact outbound envelope exactly once. Creation is refused once
   * either terminal slot exists, so a completed append can never grow a second
   * envelope, and a repeat call returns the frozen original rather than
   * rebuilding it: retries must resend the same bytes under the same
   * idempotency key.
   */
  async createOrganizationRecordEnvelope(
    input: CreateOrganizationRecordEnvelopeInput,
  ): Promise<DecisionOrganizationRecordEnvelopeEvent> {
    await this.initialize();
    const approvalId = this.assertApprovalId(input.approvalId);
    if (input.idempotencyKey !== approvalId) {
      throw new Error(
        `organization record idempotency key must be the approval id (${approvalId})`,
      );
    }
    const release = await this.acquireLock(approvalId);
    try {
      assertFounderProvenanceRetired(this.stateDirectory);
      const events = this.readEvents(approvalId);
      this.assertNoRetiredFederation(events);
      const state = foldDecisionNode(events);
      // The event type is not the caller's to choose: it is fixed by the
      // immutable local resolution. An approved decision can only ever produce
      // an approval act and a rejected one a rejection act, so a direct caller
      // cannot mislabel what the human did.
      const expectedEventType =
        state.status === 'approved'
          ? 'approval'
          : state.status === 'rejected'
            ? 'rejection'
            : null;
      if (expectedEventType === null) {
        throw new Error(
          `decision node is not eligible for an organization record envelope: ${state.organization_record.status} (${approvalId})`,
        );
      }
      if (input.recordEventType !== expectedEventType) {
        throw new Error(
          `organization record event type must be '${expectedEventType}' for a ${state.status} decision node (${approvalId})`,
        );
      }
      const existing = state.organization_record.envelope;
      if (existing !== null) return existing;
      const path = join(
        this.nodePath(approvalId),
        ORGANIZATION_RECORD_ENVELOPE_FILE,
      );
      const event = assertDecisionOrganizationRecordEnvelopeEvent(
        {
          schema_version: 1,
          event_type: 'organization-record-envelope',
          node_id: state.node_id,
          record_event_type: input.recordEventType,
          envelope_id: input.envelopeId,
          idempotency_key: input.idempotencyKey,
          envelope_sha256: input.envelopeSha256,
          envelope: input.envelope,
          created_at: this.now(),
        },
        path,
      );
      this.createSlot(path, event);
      return assertDecisionOrganizationRecordEnvelopeEvent(
        this.readSlot(path),
        path,
      );
    } finally {
      await release();
    }
  }

  /**
   * File a verified append receipt through the ordinary create-once published
   * slot. The receipt must bind the frozen envelope: a receipt for other bytes
   * or another idempotency key is never accepted as this node's outcome.
   */
  async recordOrganizationRecordReceipt(
    input: RecordOrganizationRecordReceiptInput,
  ): Promise<DecisionNodeState> {
    await this.initialize();
    const approvalId = this.assertApprovalId(input.approvalId);
    const release = await this.acquireLock(approvalId);
    try {
      assertFounderProvenanceRetired(this.stateDirectory);
      const events = this.readEvents(approvalId);
      this.assertNoRetiredFederation(events);
      const state = foldDecisionNode(events);
      const { envelope, rejection } = state.organization_record;
      if (envelope === null) {
        throw new Error(
          `decision node has no frozen organization record envelope (${approvalId})`,
        );
      }
      if (rejection !== null) {
        throw new Error(
          `decision node organization record is already rejected (${approvalId})`,
        );
      }
      const receipt = assertDecisionOrganizationRecordReceipt(
        input.receipt,
        `published-${ORGANIZATION_RECORD_SURFACE}.json`,
      );
      if (
        receipt.envelope_id !== envelope.envelope_id ||
        receipt.envelope_sha256 !== envelope.envelope_sha256 ||
        receipt.idempotency_key !== envelope.idempotency_key
      ) {
        throw new Error(
          `organization record receipt does not bind this node's frozen envelope (${approvalId})`,
        );
      }
      // Create-once: a filed receipt is never replaced, even by a matching one.
      if (state.organization_record.status === 'published') return state;
      const path = join(
        this.nodePath(approvalId),
        `published-${ORGANIZATION_RECORD_SURFACE}.json`,
      );
      const event: DecisionPublishedEvent = {
        schema_version: 1,
        event_type: 'published',
        node_id: state.node_id,
        surface: ORGANIZATION_RECORD_SURFACE,
        posted_at: this.now(),
        reference: receipt as unknown as JsonObject,
      };
      assertDecisionPublishedEvent(event, path);
      this.createSlot(path, event);
      const updated = this.readEvents(approvalId);
      this.assertNoRetiredFederation(updated);
      return foldDecisionNode(updated);
    } finally {
      await release();
    }
  }

  /**
   * File the terminal permanent rejection. Only schema, signature, or evidence
   * refusals reach here: transient transport failures deliberately create no
   * slot so the next cycle retries the same frozen bytes.
   */
  async recordOrganizationRecordRejection(
    input: RecordOrganizationRecordRejectionInput,
  ): Promise<DecisionOrganizationRecordRejectionEvent> {
    await this.initialize();
    const approvalId = this.assertApprovalId(input.approvalId);
    const release = await this.acquireLock(approvalId);
    try {
      assertFounderProvenanceRetired(this.stateDirectory);
      const events = this.readEvents(approvalId);
      this.assertNoRetiredFederation(events);
      const state = foldDecisionNode(events);
      const existing = state.organization_record.rejection;
      if (existing !== null) return existing;
      const envelope = this.assertOutboundEnvelope(state, approvalId);
      const path = join(
        this.nodePath(approvalId),
        ORGANIZATION_RECORD_REJECTED_FILE,
      );
      const event = assertDecisionOrganizationRecordRejectionEvent(
        {
          schema_version: 1,
          event_type: 'organization-record-rejected',
          node_id: state.node_id,
          envelope_id: envelope.envelope_id,
          idempotency_key: envelope.idempotency_key,
          envelope_sha256: envelope.envelope_sha256,
          reason_code: input.reasonCode,
          reason: input.reason,
          rejected_at: this.now(),
        },
        path,
      );
      this.createSlot(path, event);
      return assertDecisionOrganizationRecordRejectionEvent(
        this.readSlot(path),
        path,
      );
    } finally {
      await release();
    }
  }

  private assertOutboundEnvelope(
    state: DecisionNodeState,
    approvalId: string,
  ): DecisionOrganizationRecordEnvelopeEvent {
    const { status, envelope } = state.organization_record;
    if (envelope === null) {
      throw new Error(
        `decision node has no frozen organization record envelope (${approvalId})`,
      );
    }
    if (status === 'rejected' || status === 'published') {
      throw new Error(
        `decision node organization record is already ${status} (${approvalId})`,
      );
    }
    return envelope;
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
    const envelopePath = join(
      nodeDirectory,
      ORGANIZATION_RECORD_ENVELOPE_FILE,
    );
    const organizationRecordEnvelope = existsSync(envelopePath)
      ? assertDecisionOrganizationRecordEnvelopeEvent(
          this.readSlot(envelopePath),
          envelopePath,
        )
      : undefined;
    const rejectedPath = join(
      nodeDirectory,
      ORGANIZATION_RECORD_REJECTED_FILE,
    );
    const organizationRecordRejection = existsSync(rejectedPath)
      ? assertDecisionOrganizationRecordRejectionEvent(
          this.readSlot(rejectedPath),
          rejectedPath,
        )
      : undefined;
    return {
      approval_id: approvalId,
      requested,
      published,
      resolved,
      organization_record_envelope: organizationRecordEnvelope,
      organization_record_rejection: organizationRecordRejection,
    };
  }

  private assertNoRetiredFederation(events: DecisionNodeEvents): void {
    // Only requested metadata classifies a historical node. Surface references
    // and resolution metadata stay opaque local payloads even when they happen
    // to contain a similarly named field.
    if (Object.hasOwn(events.requested.metadata, 'federation')) {
      throw new Error(
        'decision node uses retired federation metadata and cannot be read or mutated',
      );
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
