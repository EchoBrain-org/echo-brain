import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { canonicalJson } from '@echo-brain/federation-protocol';
import { openAuthorityDatabase } from '../../adapters/persistence/sqlite/open-database.js';
import type {
  ApprovalDecision,
  ApprovalGate,
  ApprovalRequest,
} from '../core/approval/approval-gate.js';
import type { AdapterIdentity } from '../core/contracts/adapter.js';
import type { DecisionSet } from '../core/contracts/decision.js';
import type {
  DeliveryEnvelope,
  DeliveryReceipt,
} from '../core/contracts/delivery.js';
import type {
  AdapterCursor,
  MeetingDocument,
} from '../core/contracts/meeting.js';
import type {
  CoreStateStore,
  MeetingPreRecordAdmission,
} from '../core/storage/core-state-store.js';

const DECISION_SLOT = 'decision-set';
const APPROVAL_REQUEST_SLOT = 'approval-request';
const PENDING_APPROVAL_LIMIT = 100;
const TERMINAL_CLEANUP_LIMIT = 100;
const RETENTION_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;

export interface AuthorityProcessingStoreBinding {
  readonly organization_id: string;
  readonly principal_id: string;
  readonly membership_id: string;
  readonly membership_type: 'owner' | 'employee';
  readonly source_adapter_id: string;
  readonly source_instance_id: string;
}

export interface SqliteAuthorityProcessingStoreOptions {
  readonly fileMustExist?: boolean;
  readonly now?: () => string;
}

export type AuthorityProcessingMemberExclusion =
  | {
      readonly scope: 'source';
      readonly source_adapter_id: string;
      readonly source_instance_id: string;
    }
  | {
      readonly scope: 'meeting';
      readonly source_adapter_id: string;
      readonly source_instance_id: string;
      readonly external_id: string;
    };

export interface AuthorityProcessingCandidate {
  readonly processing_key: string;
  readonly admitted_at: string;
  readonly meeting: MeetingDocument;
  readonly first_decision: DecisionSet | null;
  readonly first_request: ApprovalRequest | null;
}

export interface PendingApprovalCursor {
  readonly requested_at: string;
  readonly approval_id: string;
  readonly processing_key: string;
}

export interface PendingAuthorityApproval extends AuthorityProcessingCandidate {
  readonly requested_at: string;
  readonly approval_id: string;
}

export interface ListPendingAuthorityApprovalsInput {
  readonly after?: PendingApprovalCursor;
  readonly limit?: number;
}

export interface AuthorityTerminalProcessingResolution {
  readonly status: 'approved' | 'rejected';
  readonly resolved_at: string;
  readonly document: unknown;
}

export interface CleanupTerminalCandidatesInput {
  readonly now: string;
  readonly limit?: number;
}

interface CursorRow {
  cursor: string;
  source_version: string;
}

interface CandidateRow {
  processing_key: string;
  admitted_at: string;
  raw_document_json: string;
  decision_json: string | null;
  request_json: string | null;
}

interface PendingRow extends CandidateRow {
  request_order_at: string;
  request_approval_id: string;
}

interface JsonRow {
  document_json: string;
  document_sha256: string;
}

interface ResolutionRow {
  terminal_status: string;
  resolution_json: string;
  resolution_sha256: string;
  resolved_at: string;
  retain_until: string;
}

interface RawCandidateRow {
  source_adapter_id: string;
  source_instance_id: string;
  external_id: string;
  meeting_revision: string;
  meeting_id: string;
  raw_document_json: string;
}

interface ExistingReceiptRow {
  envelope_sha256: string;
  status: string;
  recorded_at: string;
  retryable: number;
}

function digestCanonicalJson(json: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(json, 'utf8').digest('hex')}`;
}

function exactJson(value: unknown): {
  readonly json: string;
  readonly sha256: `sha256:${string}`;
} {
  const json = canonicalJson(value as never);
  return { json, sha256: digestCanonicalJson(json) };
}

function canonicalMeetingIgnoringSourceVersion(
  meeting: MeetingDocument,
): string {
  const source = meeting.provenance.source;
  return canonicalJson({
    ...meeting,
    provenance: {
      ...meeting.provenance,
      source: {
        kind: source.kind,
        adapter_id: source.adapter_id,
        instance_id: source.instance_id,
      },
    },
  });
}

function assertCanonicalTimestamp(value: string, field: string): string {
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${field} must be a canonical timestamp`);
  }
  return value;
}

function approvalId(processingKey: string): string {
  return createHash('sha256').update(processingKey, 'utf8').digest('hex');
}

function boundedLimit(value: number | undefined, maximum: number, field: string): number {
  const resolved = value ?? maximum;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new Error(`${field} must be an integer from 1 through ${maximum}`);
  }
  return resolved;
}

/**
 * The Authority's durable pre-record and processing state for one member-owned
 * meeting source. This class intentionally has no administrator/read-serving
 * surface: its content-bearing reads are capabilities of the processing
 * runtime bound to the exact membership and source passed to the constructor.
 */
export class SqliteAuthorityProcessingStore implements CoreStateStore {
  private readonly database: Database.Database;
  private readonly now: () => string;
  private initialized = false;

  constructor(
    databasePath: string,
    private readonly binding: AuthorityProcessingStoreBinding,
    options: SqliteAuthorityProcessingStoreOptions = {},
  ) {
    for (const [field, value] of Object.entries(binding)) {
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`authority processing binding ${field} is required`);
      }
    }
    this.database = openAuthorityDatabase(databasePath, {
      fileMustExist: options.fileMustExist,
    });
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Creates or verifies the permanent exact source-owner binding. */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.immediate(() => {
      this.assertActiveMembership();
      const boundAt = assertCanonicalTimestamp(this.now(), 'bound_at');
      this.database
        .prepare(
          `INSERT INTO authority_processing_source_owner_bindings (
             source_adapter_id, source_instance_id, organization_id,
             principal_id, membership_id, membership_type, bound_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (source_adapter_id, source_instance_id) DO NOTHING`,
        )
        .run(
          this.binding.source_adapter_id,
          this.binding.source_instance_id,
          this.binding.organization_id,
          this.binding.principal_id,
          this.binding.membership_id,
          this.binding.membership_type,
          boundAt,
        );
      this.assertActiveBinding();
    });
    this.initialized = true;
  }

  async getSourceCursor(
    source: AdapterIdentity & { kind: 'meeting-source' },
  ): Promise<AdapterCursor | undefined> {
    await this.initialize();
    this.assertSource(source);
    this.assertActiveBinding();
    const row = this.database
      .prepare(
        `SELECT source_version, cursor
           FROM authority_processing_source_cursors
          WHERE source_adapter_id = ? AND source_instance_id = ?`,
      )
      .get(
        this.binding.source_adapter_id,
        this.binding.source_instance_id,
      ) as CursorRow | undefined;
    return row?.source_version === source.version ? row.cursor : undefined;
  }

  async setSourceCursor(
    source: AdapterIdentity & { kind: 'meeting-source' },
    cursor: AdapterCursor,
  ): Promise<void> {
    await this.initialize();
    this.assertSource(source);
    if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 8192) {
      throw new Error('authority processing source cursor is invalid');
    }
    this.immediate(() => {
      this.assertActiveBinding();
      this.database
        .prepare(
          `INSERT INTO authority_processing_source_cursors (
             source_adapter_id, source_instance_id, source_version, cursor,
             updated_at
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (source_adapter_id, source_instance_id) DO UPDATE SET
             source_version = excluded.source_version,
             cursor = excluded.cursor,
             updated_at = excluded.updated_at`,
        )
        .run(
          this.binding.source_adapter_id,
          this.binding.source_instance_id,
          source.version,
          cursor,
          assertCanonicalTimestamp(this.now(), 'updated_at'),
        );
    });
  }

  async hasProcessed(processingKey: string): Promise<boolean> {
    await this.initialize();
    this.assertProcessingKey(processingKey);
    this.assertActiveBinding();
    return (
      this.database
        .prepare(
          `SELECT 1
             FROM authority_processing_processed_markers
            WHERE processing_key = ?
              AND source_adapter_id = ? AND source_instance_id = ?`,
        )
        .get(
          processingKey,
          this.binding.source_adapter_id,
          this.binding.source_instance_id,
        ) !== undefined
    );
  }

  async admitAndSaveMeeting(
    meeting: MeetingDocument,
    processingKey: string,
  ): Promise<MeetingPreRecordAdmission> {
    await this.initialize();
    this.assertProcessingKey(processingKey);
    this.assertMeetingSource(meeting);
    const raw = exactJson(meeting);
    return this.immediate(() => {
      this.assertActiveBinding();
      const excluded = this.database
        .prepare(
          `SELECT 1
             FROM authority_processing_member_exclusions
            WHERE organization_id = ? AND principal_id = ?
              AND membership_id = ? AND membership_type = ?
              AND source_adapter_id = ? AND source_instance_id = ?
              AND (
                (scope_kind = 'source' AND external_id = '') OR
                (scope_kind = 'meeting' AND external_id = ?)
              )
            LIMIT 1`,
        )
        .get(
          this.binding.organization_id,
          this.binding.principal_id,
          this.binding.membership_id,
          this.binding.membership_type,
          this.binding.source_adapter_id,
          this.binding.source_instance_id,
          meeting.provenance.external_id,
        );
      if (excluded !== undefined) return 'excluded';
      if (
        this.database
          .prepare(
            `SELECT 1 FROM authority_processing_processed_markers
              WHERE processing_key = ?`,
          )
          .get(processingKey) !== undefined
      ) {
        throw new Error('authority processing candidate is already processed');
      }
      const admittedAt = assertCanonicalTimestamp(this.now(), 'admitted_at');
      this.database
        .prepare(
          `INSERT INTO authority_processing_candidates (
             processing_key, source_adapter_id, source_instance_id,
             source_version, external_id, meeting_revision, meeting_id,
             raw_document_sha256, raw_document_json, admitted_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (processing_key) DO NOTHING`,
        )
        .run(
          processingKey,
          this.binding.source_adapter_id,
          this.binding.source_instance_id,
          meeting.provenance.source.version,
          meeting.provenance.external_id,
          meeting.provenance.canonical_revision,
          meeting.id,
          raw.sha256,
          raw.json,
          admittedAt,
        );
      const stored = this.rawCandidate(processingKey);
      if (
        stored === undefined ||
        stored.source_adapter_id !== this.binding.source_adapter_id ||
        stored.source_instance_id !== this.binding.source_instance_id ||
        stored.external_id !== meeting.provenance.external_id ||
        stored.meeting_revision !== meeting.provenance.canonical_revision ||
        stored.meeting_id !== meeting.id ||
        canonicalMeetingIgnoringSourceVersion(
          JSON.parse(stored.raw_document_json) as MeetingDocument,
        ) !== canonicalMeetingIgnoringSourceVersion(meeting)
      ) {
        throw new Error(
          'authority processing key already binds a different raw candidate',
        );
      }
      return 'saved';
    });
  }

  async getDecisionSet(
    processingKey: string,
    meeting: MeetingDocument,
    processor: AdapterIdentity & { kind: 'decision-processor' },
  ): Promise<DecisionSet | undefined> {
    await this.initialize();
    this.assertCandidateMeeting(processingKey, meeting);
    const row = this.slot(processingKey, DECISION_SLOT);
    if (row === undefined) return undefined;
    const decision = JSON.parse(row.document_json) as DecisionSet;
    if (
      decision.meeting_id !== meeting.id ||
      decision.meeting_revision !== meeting.provenance.canonical_revision ||
      decision.processor.kind !== 'decision-processor' ||
      decision.processor.adapter_id !== processor.adapter_id ||
      decision.processor.instance_id !== processor.instance_id ||
      decision.processor.version !== processor.version
    ) {
      throw new Error('authority processing decision slot binding is invalid');
    }
    return decision;
  }

  async saveDecisionSet(
    processingKey: string,
    meeting: MeetingDocument,
    decisions: DecisionSet,
  ): Promise<void> {
    await this.initialize();
    this.assertCandidateMeeting(processingKey, meeting);
    if (
      decisions.meeting_id !== meeting.id ||
      decisions.meeting_revision !== meeting.provenance.canonical_revision
    ) {
      throw new Error('authority processing decision does not bind its meeting');
    }
    this.createDecisionSlot(processingKey, decisions);
  }

  async getApproval(
    processingKey: string,
  ): Promise<ApprovalDecision | undefined> {
    await this.initialize();
    this.assertOwnedCandidate(processingKey);
    const resolution = this.resolution(processingKey);
    return resolution === undefined
      ? undefined
      : (JSON.parse(resolution.resolution_json) as ApprovalDecision);
  }

  async saveApproval(
    processingKey: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    await this.initialize();
    if (decision.status === 'pending') {
      this.assertOwnedCandidate(processingKey);
      if (this.slot(processingKey, APPROVAL_REQUEST_SLOT) === undefined) {
        throw new Error(
          'authority processing pending approval has no staged request',
        );
      }
      return;
    }
    await this.resolveCandidate(processingKey, {
      status: decision.status,
      resolved_at: decision.reviewed_at,
      document: decision,
    });
  }

  async saveDeliveryReceipt(
    processingKey: string,
    envelope: DeliveryEnvelope,
    receipt: DeliveryReceipt,
  ): Promise<void> {
    await this.initialize();
    this.assertOwnedCandidate(processingKey);
    if (receipt.envelope_id !== envelope.id) {
      throw new Error('delivery receipt does not match its envelope');
    }
    const envelopeDocument = exactJson(envelope);
    const receiptDocument = exactJson(receipt);
    this.immediate(() => {
      this.assertActiveBinding();
      this.assertOwnedCandidate(processingKey);
      this.database
        .prepare(
          `INSERT INTO authority_processing_delivery_receipts (
             envelope_id, processing_key, idempotency_key, envelope_sha256,
             receipt_sha256, status, recorded_at, retryable
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (
             processing_key, idempotency_key, envelope_id, receipt_sha256
           ) DO NOTHING`,
        )
        .run(
          envelope.id,
          processingKey,
          envelope.idempotency_key,
          envelopeDocument.sha256,
          receiptDocument.sha256,
          receipt.status,
          receipt.recorded_at,
          receipt.retryable ? 1 : 0,
        );
      const stored = this.database
        .prepare(
          `SELECT envelope_sha256, status, recorded_at, retryable
             FROM authority_processing_delivery_receipts
            WHERE processing_key = ? AND idempotency_key = ?
              AND envelope_id = ? AND receipt_sha256 = ?`,
        )
        .get(
          processingKey,
          envelope.idempotency_key,
          envelope.id,
          receiptDocument.sha256,
        ) as ExistingReceiptRow | undefined;
      if (
        stored === undefined ||
        stored.envelope_sha256 !== envelopeDocument.sha256 ||
        stored.status !== receipt.status ||
        stored.recorded_at !== receipt.recorded_at ||
        stored.retryable !== (receipt.retryable ? 1 : 0)
      ) {
        throw new Error(
          'authority processing delivery receipt conflicts with stored observation',
        );
      }
    });
  }

  async markProcessed(processingKey: string): Promise<void> {
    await this.initialize();
    this.assertProcessingKey(processingKey);
    this.immediate(() => {
      this.assertActiveBinding();
      if (
        this.database
          .prepare(
            `SELECT 1 FROM authority_processing_processed_markers
              WHERE processing_key = ? AND source_adapter_id = ?
                AND source_instance_id = ?`,
          )
          .get(
            processingKey,
            this.binding.source_adapter_id,
            this.binding.source_instance_id,
          ) !== undefined
      ) {
        return;
      }
      this.assertOwnedCandidate(processingKey);
      if (this.resolution(processingKey) === undefined) {
        throw new Error(
          'authority processing candidate cannot be marked before terminal resolution',
        );
      }
      this.database
        .prepare(
          `INSERT INTO authority_processing_processed_markers (
             processing_key, source_adapter_id, source_instance_id,
             processed_at
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(
          processingKey,
          this.binding.source_adapter_id,
          this.binding.source_instance_id,
          assertCanonicalTimestamp(this.now(), 'processed_at'),
        );
    });
  }

  /** Freezes the request and its real approval queue order exactly once. */
  async stageApprovalRequest(request: ApprovalRequest): Promise<string> {
    await this.initialize();
    assertCanonicalTimestamp(request.requested_at, 'requested_at');
    const requestedDecisions = exactJson(request.decisions);
    const id = approvalId(request.processing_key);
    const encoded = exactJson(request);
    return this.immediate(() => {
      this.assertActiveBinding();
      this.assertCandidateMeeting(request.processing_key, request.meeting);
      const storedDecisions = this.slot(request.processing_key, DECISION_SLOT);
      if (
        storedDecisions === undefined ||
        storedDecisions.document_sha256 !== requestedDecisions.sha256 ||
        storedDecisions.document_json !== requestedDecisions.json
      ) {
        throw new Error(
          'authority processing approval request does not bind the frozen decision',
        );
      }
      // The core rebuilds brief.id and requested_at on a pending retry. BEGIN
      // IMMEDIATE makes the first valid request the queue item; any contender
      // then returns that first frozen request instead of comparing retry bytes.
      this.database
        .prepare(
          `INSERT INTO authority_processing_slots (
             processing_key, slot_name, document_sha256, document_json,
             request_order_at, request_approval_id, created_at
           ) VALUES (?, '${APPROVAL_REQUEST_SLOT}', ?, ?, ?, ?, ?)
           ON CONFLICT (processing_key, slot_name) DO NOTHING`,
        )
        .run(
          request.processing_key,
          encoded.sha256,
          encoded.json,
          request.requested_at,
          id,
          assertCanonicalTimestamp(this.now(), 'slot created_at'),
        );
      const stored = this.database
        .prepare(
          `SELECT request_approval_id
             FROM authority_processing_slots
            WHERE processing_key = ? AND slot_name = '${APPROVAL_REQUEST_SLOT}'`,
        )
        .get(request.processing_key) as
        | { request_approval_id: string }
        | undefined;
      if (stored?.request_approval_id !== id) {
        throw new Error(
          'authority processing approval request has a different approval id',
        );
      }
      return id;
    });
  }

  async getCandidate(
    processingKey: string,
  ): Promise<AuthorityProcessingCandidate | undefined> {
    await this.initialize();
    this.assertProcessingKey(processingKey);
    this.assertActiveBinding();
    const row = this.candidateRow(processingKey);
    return row === undefined ? undefined : this.decodeCandidate(row);
  }

  /** Lists only staged, unresolved requests in stable request-time order. */
  async listPendingApprovals(
    input: ListPendingAuthorityApprovalsInput = {},
  ): Promise<readonly PendingAuthorityApproval[]> {
    await this.initialize();
    this.assertActiveBinding();
    const limit = boundedLimit(
      input.limit,
      PENDING_APPROVAL_LIMIT,
      'pending approval limit',
    );
    if (input.after !== undefined) {
      assertCanonicalTimestamp(input.after.requested_at, 'after.requested_at');
      if (!/^[0-9a-f]{64}$/.test(input.after.approval_id)) {
        throw new Error('after.approval_id is invalid');
      }
      this.assertProcessingKey(input.after.processing_key);
    }
    const rows = this.database
      .prepare(
        `SELECT c.processing_key, c.admitted_at, c.raw_document_json,
                d.document_json AS decision_json,
                q.document_json AS request_json,
                q.request_order_at, q.request_approval_id
           FROM authority_processing_slots q
           JOIN authority_processing_candidates c
             ON c.processing_key = q.processing_key
           LEFT JOIN authority_processing_slots d
             ON d.processing_key = c.processing_key
            AND d.slot_name = '${DECISION_SLOT}'
           LEFT JOIN authority_processing_resolutions r
             ON r.processing_key = c.processing_key
          WHERE q.slot_name = '${APPROVAL_REQUEST_SLOT}'
            AND c.source_adapter_id = ? AND c.source_instance_id = ?
            AND r.processing_key IS NULL
            AND (
              ? IS NULL OR
              (q.request_order_at, q.request_approval_id, c.processing_key)
                > (?, ?, ?)
            )
          ORDER BY q.request_order_at, q.request_approval_id, c.processing_key
          LIMIT ?`,
      )
      .all(
        this.binding.source_adapter_id,
        this.binding.source_instance_id,
        input.after?.requested_at ?? null,
        input.after?.requested_at ?? '',
        input.after?.approval_id ?? '',
        input.after?.processing_key ?? '',
        limit,
      ) as PendingRow[];
    return rows.map((row) => ({
      ...this.decodeCandidate(row),
      requested_at: row.request_order_at,
      approval_id: row.request_approval_id,
    }));
  }

  /** First terminal resolution wins; an exact replay is idempotent. */
  async resolveCandidate(
    processingKey: string,
    resolution: AuthorityTerminalProcessingResolution,
  ): Promise<void> {
    await this.initialize();
    this.assertProcessingKey(processingKey);
    if (!['approved', 'rejected'].includes(resolution.status)) {
      throw new Error('authority processing terminal status is invalid');
    }
    if (
      typeof resolution.document !== 'object' ||
      resolution.document === null ||
      !('status' in resolution.document) ||
      resolution.document.status !== resolution.status
    ) {
      throw new Error(
        'authority processing terminal document does not match its status',
      );
    }
    const resolvedAt = assertCanonicalTimestamp(
      resolution.resolved_at,
      'resolved_at',
    );
    const resolutionDocument = exactJson(resolution.document);
    const retainUntil = new Date(
      Date.parse(resolvedAt) + RETENTION_MILLISECONDS,
    ).toISOString();
    this.immediate(() => {
      this.assertActiveBinding();
      this.assertOwnedCandidate(processingKey);
      this.database
        .prepare(
          `INSERT INTO authority_processing_resolutions (
             processing_key, terminal_status, resolution_sha256,
             resolution_json, resolved_at, retain_until
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (processing_key) DO NOTHING`,
        )
        .run(
          processingKey,
          resolution.status,
          resolutionDocument.sha256,
          resolutionDocument.json,
          resolvedAt,
          retainUntil,
        );
      const stored = this.resolution(processingKey);
      if (
        stored === undefined ||
        stored.terminal_status !== resolution.status ||
        stored.resolution_sha256 !== resolutionDocument.sha256 ||
        stored.resolution_json !== resolutionDocument.json ||
        stored.resolved_at !== resolvedAt ||
        stored.retain_until !== retainUntil
      ) {
        throw new Error(
          'authority processing candidate already has a different terminal resolution',
        );
      }
    });
  }

  /** Deletes at most 100 retention-expired terminal candidates per call. */
  async cleanupTerminalCandidates(
    input: CleanupTerminalCandidatesInput,
  ): Promise<readonly string[]> {
    await this.initialize();
    const now = assertCanonicalTimestamp(input.now, 'cleanup now');
    const limit = boundedLimit(
      input.limit,
      TERMINAL_CLEANUP_LIMIT,
      'terminal cleanup limit',
    );
    return this.immediate(() => {
      this.assertActiveBinding();
      const keys = (
        this.database
          .prepare(
            `SELECT c.processing_key
               FROM authority_processing_resolutions r
               JOIN authority_processing_candidates c
                 ON c.processing_key = r.processing_key
               JOIN authority_processing_processed_markers p
                 ON p.processing_key = c.processing_key
                AND p.source_adapter_id = c.source_adapter_id
                AND p.source_instance_id = c.source_instance_id
              WHERE c.source_adapter_id = ? AND c.source_instance_id = ?
                AND r.retain_until <= ?
              ORDER BY r.retain_until, c.processing_key
              LIMIT ?`,
          )
          .all(
            this.binding.source_adapter_id,
            this.binding.source_instance_id,
            now,
            limit,
          ) as Array<{ processing_key: string }>
      ).map(({ processing_key }) => processing_key);
      const remove = this.database.prepare(
        `DELETE FROM authority_processing_candidates
          WHERE processing_key = ?
            AND source_adapter_id = ? AND source_instance_id = ?`,
      );
      for (const key of keys) {
        remove.run(
          key,
          this.binding.source_adapter_id,
          this.binding.source_instance_id,
        );
      }
      return keys;
    });
  }

  async addOwnExclusion(
    exclusion: AuthorityProcessingMemberExclusion,
  ): Promise<boolean> {
    await this.initialize();
    this.assertExclusion(exclusion);
    return this.immediate(() => {
      this.assertActiveBinding();
      const result = this.database
        .prepare(
          `INSERT INTO authority_processing_member_exclusions (
             organization_id, principal_id, membership_id, membership_type,
             source_adapter_id, source_instance_id, scope_kind, external_id,
             created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (
             membership_id, source_adapter_id, source_instance_id, scope_kind,
             external_id
           ) DO NOTHING`,
        )
        .run(
          this.binding.organization_id,
          this.binding.principal_id,
          this.binding.membership_id,
          this.binding.membership_type,
          this.binding.source_adapter_id,
          this.binding.source_instance_id,
          exclusion.scope,
          exclusion.scope === 'source' ? '' : exclusion.external_id,
          assertCanonicalTimestamp(this.now(), 'created_at'),
        );
      return result.changes === 1;
    });
  }

  async removeOwnExclusion(
    exclusion: AuthorityProcessingMemberExclusion,
  ): Promise<boolean> {
    await this.initialize();
    this.assertExclusion(exclusion);
    return this.immediate(() => {
      this.assertActiveBinding();
      const result = this.database
        .prepare(
          `DELETE FROM authority_processing_member_exclusions
            WHERE organization_id = ? AND principal_id = ?
              AND membership_id = ? AND membership_type = ?
              AND source_adapter_id = ? AND source_instance_id = ?
              AND scope_kind = ? AND external_id = ?`,
        )
        .run(
          this.binding.organization_id,
          this.binding.principal_id,
          this.binding.membership_id,
          this.binding.membership_type,
          this.binding.source_adapter_id,
          this.binding.source_instance_id,
          exclusion.scope,
          exclusion.scope === 'source' ? '' : exclusion.external_id,
        );
      return result.changes === 1;
    });
  }

  async listOwnExclusions(): Promise<readonly AuthorityProcessingMemberExclusion[]> {
    await this.initialize();
    this.assertActiveBinding();
    const rows = this.database
      .prepare(
        `SELECT scope_kind, external_id
           FROM authority_processing_member_exclusions
          WHERE organization_id = ? AND principal_id = ?
            AND membership_id = ? AND membership_type = ?
            AND source_adapter_id = ? AND source_instance_id = ?
          ORDER BY scope_kind, external_id`,
      )
      .all(
        this.binding.organization_id,
        this.binding.principal_id,
        this.binding.membership_id,
        this.binding.membership_type,
        this.binding.source_adapter_id,
        this.binding.source_instance_id,
      ) as Array<{ scope_kind: 'source' | 'meeting'; external_id: string }>;
    return rows.map((row) =>
      row.scope_kind === 'source'
        ? {
            scope: 'source' as const,
            source_adapter_id: this.binding.source_adapter_id,
            source_instance_id: this.binding.source_instance_id,
          }
        : {
            scope: 'meeting' as const,
            source_adapter_id: this.binding.source_adapter_id,
            source_instance_id: this.binding.source_instance_id,
            external_id: row.external_id,
          },
    );
  }

  close(): void {
    if (this.database.open) this.database.close();
  }

  private immediate<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {}
      throw error;
    }
  }

  private assertActiveMembership(): void {
    if (
      this.database
        .prepare(
          `SELECT 1
             FROM authority_memberships
            WHERE organization_id = ? AND principal_id = ?
              AND membership_id = ? AND membership_type = ?
              AND status = 'active'`,
        )
        .get(
          this.binding.organization_id,
          this.binding.principal_id,
          this.binding.membership_id,
          this.binding.membership_type,
        ) === undefined
    ) {
      throw new Error(
        'authority processing source owner is not the exact active membership',
      );
    }
  }

  private assertActiveBinding(): void {
    if (
      this.database
        .prepare(
          `SELECT 1
             FROM authority_processing_source_owner_bindings b
             JOIN authority_memberships m
               ON m.membership_id = b.membership_id
              AND m.organization_id = b.organization_id
              AND m.principal_id = b.principal_id
              AND m.membership_type = b.membership_type
            WHERE b.source_adapter_id = ? AND b.source_instance_id = ?
              AND b.organization_id = ? AND b.principal_id = ?
              AND b.membership_id = ? AND b.membership_type = ?
              AND m.status = 'active'`,
        )
        .get(
          this.binding.source_adapter_id,
          this.binding.source_instance_id,
          this.binding.organization_id,
          this.binding.principal_id,
          this.binding.membership_id,
          this.binding.membership_type,
        ) === undefined
    ) {
      throw new Error(
        'authority processing source is not bound to the exact active membership',
      );
    }
  }

  private assertSource(source: AdapterIdentity): void {
    if (
      source.kind !== 'meeting-source' ||
      source.adapter_id !== this.binding.source_adapter_id ||
      source.instance_id !== this.binding.source_instance_id
    ) {
      throw new Error('authority processing store received a different source');
    }
  }

  private assertMeetingSource(meeting: MeetingDocument): void {
    this.assertSource(meeting.provenance.source);
  }

  private assertProcessingKey(processingKey: string): void {
    if (
      typeof processingKey !== 'string' ||
      processingKey.length === 0 ||
      processingKey.length > 8192
    ) {
      throw new Error('authority processing key is invalid');
    }
  }

  private assertExclusion(exclusion: AuthorityProcessingMemberExclusion): void {
    if (
      exclusion.source_adapter_id !== this.binding.source_adapter_id ||
      exclusion.source_instance_id !== this.binding.source_instance_id ||
      !['source', 'meeting'].includes(exclusion.scope) ||
      (exclusion.scope === 'meeting' &&
        (exclusion.external_id.length === 0 || exclusion.external_id.length > 4096))
    ) {
      throw new Error('authority processing member exclusion is invalid');
    }
  }

  private rawCandidate(processingKey: string): RawCandidateRow | undefined {
    return this.database
      .prepare(
        `SELECT source_adapter_id, source_instance_id, external_id,
                meeting_revision, meeting_id, raw_document_json
           FROM authority_processing_candidates
          WHERE processing_key = ?`,
      )
      .get(processingKey) as RawCandidateRow | undefined;
  }

  private assertOwnedCandidate(processingKey: string): RawCandidateRow {
    this.assertProcessingKey(processingKey);
    this.assertActiveBinding();
    const stored = this.rawCandidate(processingKey);
    if (
      stored === undefined ||
      stored.source_adapter_id !== this.binding.source_adapter_id ||
      stored.source_instance_id !== this.binding.source_instance_id
    ) {
      throw new Error('authority processing candidate is not owned by this source');
    }
    return stored;
  }

  private assertCandidateMeeting(
    processingKey: string,
    meeting: MeetingDocument,
  ): void {
    this.assertMeetingSource(meeting);
    const stored = this.assertOwnedCandidate(processingKey);
    if (
      stored.external_id !== meeting.provenance.external_id ||
      stored.meeting_revision !== meeting.provenance.canonical_revision ||
      stored.meeting_id !== meeting.id ||
      canonicalMeetingIgnoringSourceVersion(
        JSON.parse(stored.raw_document_json) as MeetingDocument,
      ) !== canonicalMeetingIgnoringSourceVersion(meeting)
    ) {
      throw new Error('authority processing candidate meeting differs from raw');
    }
  }

  private createDecisionSlot(
    processingKey: string,
    document: DecisionSet,
  ): void {
    const encoded = exactJson(document);
    this.immediate(() => {
      this.assertActiveBinding();
      this.assertOwnedCandidate(processingKey);
      this.database
        .prepare(
          `INSERT INTO authority_processing_slots (
             processing_key, slot_name, document_sha256, document_json,
             request_order_at, request_approval_id, created_at
           ) VALUES (?, '${DECISION_SLOT}', ?, ?, NULL, NULL, ?)
           ON CONFLICT (processing_key, slot_name) DO NOTHING`,
        )
        .run(
          processingKey,
          encoded.sha256,
          encoded.json,
          assertCanonicalTimestamp(this.now(), 'slot created_at'),
        );
      const stored = this.slot(processingKey, DECISION_SLOT);
      if (
        stored === undefined ||
        stored.document_sha256 !== encoded.sha256 ||
        stored.document_json !== encoded.json
      ) {
        throw new Error(
          'authority processing decision slot already contains different bytes',
        );
      }
    });
  }

  private slot(processingKey: string, slotName: string): JsonRow | undefined {
    return this.database
      .prepare(
        `SELECT document_json, document_sha256
           FROM authority_processing_slots
          WHERE processing_key = ? AND slot_name = ?`,
      )
      .get(processingKey, slotName) as JsonRow | undefined;
  }

  private resolution(processingKey: string): ResolutionRow | undefined {
    return this.database
      .prepare(
        `SELECT terminal_status, resolution_json, resolution_sha256,
                resolved_at, retain_until
           FROM authority_processing_resolutions
          WHERE processing_key = ?`,
      )
      .get(processingKey) as ResolutionRow | undefined;
  }

  private candidateRow(processingKey: string): CandidateRow | undefined {
    return this.database
      .prepare(
        `SELECT c.processing_key, c.admitted_at, c.raw_document_json,
                d.document_json AS decision_json,
                q.document_json AS request_json
           FROM authority_processing_candidates c
           LEFT JOIN authority_processing_slots d
             ON d.processing_key = c.processing_key
            AND d.slot_name = '${DECISION_SLOT}'
           LEFT JOIN authority_processing_slots q
             ON q.processing_key = c.processing_key
            AND q.slot_name = '${APPROVAL_REQUEST_SLOT}'
          WHERE c.processing_key = ?
            AND c.source_adapter_id = ? AND c.source_instance_id = ?`,
      )
      .get(
        processingKey,
        this.binding.source_adapter_id,
        this.binding.source_instance_id,
      ) as CandidateRow | undefined;
  }

  private decodeCandidate(row: CandidateRow): AuthorityProcessingCandidate {
    return {
      processing_key: row.processing_key,
      admitted_at: row.admitted_at,
      meeting: JSON.parse(row.raw_document_json) as MeetingDocument,
      first_decision:
        row.decision_json === null
          ? null
          : (JSON.parse(row.decision_json) as DecisionSet),
      first_request:
        row.request_json === null
          ? null
          : (JSON.parse(row.request_json) as ApprovalRequest),
    };
  }
}

/** Stages the first request before reporting the store's current resolution. */
export class AuthorityProcessingApprovalGate implements ApprovalGate {
  constructor(private readonly store: SqliteAuthorityProcessingStore) {}

  async review(request: ApprovalRequest): Promise<ApprovalDecision> {
    await this.store.stageApprovalRequest(request);
    return (
      (await this.store.getApproval(request.processing_key)) ?? {
        status: 'pending',
        reviewed_at: null,
        reviewed_by: null,
        reason: null,
        approved_brief: null,
      }
    );
  }
}
