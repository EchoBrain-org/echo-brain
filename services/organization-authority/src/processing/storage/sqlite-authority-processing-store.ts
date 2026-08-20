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
import type { JsonObject } from '../core/contracts/json.js';
import { assertCanonicalApprovalDecision } from '../core/contracts/validation.js';
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

export interface AuthorityProcessingSourceConfigurationBinding {
  readonly owner_email_sha256: `sha256:${string}`;
  readonly credential_scope: 'organization';
  readonly credential_reference_sha256: `sha256:${string}`;
}

export interface SqliteAuthorityProcessingStoreOptions {
  /**
   * Only source-runtime composition may provision a permanent owner binding.
   * Member-facing capabilities must require the exact binding to exist so a
   * caller cannot claim an arbitrary source identity by opening this store.
   */
  readonly bindingMode: 'provision' | 'require-existing';
  /** Required by the live source composition; omitted by legacy read capabilities. */
  readonly sourceConfiguration?: AuthorityProcessingSourceConfigurationBinding;
  readonly fileMustExist?: boolean;
  readonly now?: () => string;
}

export interface AuthorityProcessingSourceProvisioningStatus {
  readonly owner_binding: 'provisioned' | 'existing';
  readonly configuration_binding: 'provisioned' | 'existing';
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

/** Storage-local restatement of the two Slack contracts this layer persists. */
export interface AuthorityFrozenReviewerApprovalPresentationContract {
  readonly schema_version: 1;
  readonly kind: 'echo-slack-approval-presentation-contract';
  readonly mode: 'restricted-reviewer-v1';
  readonly adapter_id: string;
  readonly adapter_instance_id: string;
  readonly adapter_version: string;
  readonly channel_id: string;
  readonly reviewer_slack_user_id: string;
  readonly reviewer_name: string;
  readonly credential_ref: string;
  readonly credential_fingerprint_sha256: string;
  readonly approve_reaction: string;
  readonly reject_reaction: string;
  readonly reviewer_release_draft_sha256: string;
  readonly approval_presentation_sha256: string;
}

export interface AuthorityFrozenOrganizationMemberApprovalPresentationContract {
  readonly schema_version: 1;
  readonly kind: 'echo-slack-approval-presentation-contract';
  readonly mode: 'organization-member-readable-v1';
  readonly adapter_id: string;
  readonly adapter_instance_id: string;
  readonly adapter_version: string;
  readonly channel_id: string;
  readonly reviewer_slack_user_id: string;
  readonly reviewer_name: string;
  readonly credential_ref: string;
  readonly credential_fingerprint_sha256: string;
  readonly approve_reaction: string;
  readonly reject_reaction: string;
  readonly policy_id: 'organization-member-readable-v1';
  readonly policy_contract_sha256: string;
  readonly release_draft_sha256: string;
  readonly approval_presentation_sha256: string;
}

export type AuthorityFrozenApprovalPresentationContract =
  | AuthorityFrozenReviewerApprovalPresentationContract
  | AuthorityFrozenOrganizationMemberApprovalPresentationContract;

export interface AuthorityApprovalDecisionStoreView {
  readonly approval_id: string;
  readonly status: 'pending' | 'approved' | 'rejected';
  readonly reviewed_at: string | null;
  readonly reviewed_by: string | null;
  readonly reason: string | null;
  readonly brief: ApprovalRequest['brief'];
  readonly requested_metadata?: JsonObject;
  readonly published: readonly {
    readonly surface: string;
    readonly reference: JsonObject;
  }[];
}

export interface AuthorityApprovalResolutionMetadata {
  readonly approval_id: string;
  readonly surface: string;
  readonly metadata: JsonObject;
  readonly resolved_at: string;
}

export interface AuthorityApprovalDecisionStore {
  ensureRequested(
    request: ApprovalRequest,
  ): Promise<AuthorityApprovalDecisionStoreView>;
  freezeApprovalPresentationContract<
    T extends AuthorityFrozenApprovalPresentationContract,
  >(input: {
    readonly approvalId: string;
    readonly contract: T;
  }): Promise<T>;
  readApprovalPresentationContract(
    approvalId: string,
  ): AuthorityFrozenReviewerApprovalPresentationContract | null;
  readFrozenApprovalPresentationContract(
    approvalId: string,
  ): AuthorityFrozenApprovalPresentationContract | null;
  recordPublished(input: {
    readonly processingKey: string;
    readonly surface: string;
    readonly reference: JsonObject;
  }): Promise<AuthorityApprovalDecisionStoreView>;
  resolve(input: {
    readonly approvalId: string;
    readonly status: 'approved' | 'rejected';
    readonly reviewedBy: string;
    readonly reason?: string | null;
    readonly surface: string;
    readonly metadata?: JsonObject;
    readonly reviewedAt?: string;
  }): Promise<AuthorityApprovalDecisionStoreView>;
}

/** Storage-local shape of the record builder result kept by the frozen slot. */
export interface AuthorityBuiltOrganizationRecordEnvelope {
  readonly envelope_id: string;
  readonly idempotency_key: string;
  readonly event_type: string;
  readonly envelope: unknown;
}

export interface AuthorityFrozenOrganizationRecordEnvelopeStore {
  getOrCreate<T extends AuthorityBuiltOrganizationRecordEnvelope>(
    idempotencyKey: string,
    create: () => Promise<T>,
  ): Promise<T>;
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

interface ApprovalRequestIdentityRow {
  processing_key: string;
  document_json: string;
  document_sha256: string;
  request_approval_id: string;
}

interface ApprovalPresentationContractRow {
  processing_key: string;
  approval_id: string;
  contract_mode:
    | 'restricted-reviewer-v1'
    | 'organization-member-readable-v1';
  contract_sha256: string;
  contract_json: string;
}

interface ApprovalPublicationRow {
  surface: string;
  reference_sha256: string;
  reference_json: string;
}

interface ApprovalResolutionMetadataRow {
  approval_id: string;
  surface: string;
  metadata_sha256: string;
  metadata_json: string;
  resolved_at: string;
}

interface FrozenRecordEnvelopeRow {
  processing_key: string;
  approval_id: string;
  envelope_id: string;
  event_type: string;
  envelope_sha256: string;
  envelope_json: string;
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

function canonicalMeetingForReplay(meeting: MeetingDocument): string {
  const source = meeting.provenance.source;
  const provenance: Partial<MeetingDocument['provenance']> = {
    ...meeting.provenance,
  };
  delete provenance.observed_at;
  return canonicalJson({
    ...meeting,
    provenance: {
      ...provenance,
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

function assertApprovalId(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error('authority processing approval id is invalid');
  }
  return value;
}

function assertBoundedSurface(value: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) {
    throw new Error('authority processing approval surface is invalid');
  }
  return value;
}

function assertJsonObject(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  exactJson(value);
  return value as JsonObject;
}

function approvalPresentationMode(
  value: unknown,
): AuthorityFrozenApprovalPresentationContract['mode'] {
  const contract = assertJsonObject(
    value,
    'authority processing approval presentation contract',
  );
  if (
    contract['schema_version'] !== 1 ||
    contract['kind'] !== 'echo-slack-approval-presentation-contract' ||
    (contract['mode'] !== 'restricted-reviewer-v1' &&
      contract['mode'] !== 'organization-member-readable-v1')
  ) {
    throw new Error(
      'authority processing approval presentation contract identity is invalid',
    );
  }
  return contract['mode'];
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
export class SqliteAuthorityProcessingStore
  implements
    CoreStateStore,
    AuthorityApprovalDecisionStore,
    AuthorityFrozenOrganizationRecordEnvelopeStore
{
  private readonly database: Database.Database;
  private readonly now: () => string;
  private readonly recordEnvelopeCreates = new Map<
    string,
    Promise<AuthorityBuiltOrganizationRecordEnvelope>
  >();
  private initialized = false;
  private provisioningStatus: AuthorityProcessingSourceProvisioningStatus | null = null;

  constructor(
    databasePath: string,
    private readonly binding: AuthorityProcessingStoreBinding,
    private readonly options: SqliteAuthorityProcessingStoreOptions,
  ) {
    for (const [field, value] of Object.entries(binding)) {
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`authority processing binding ${field} is required`);
      }
    }
    const sourceConfiguration = options.sourceConfiguration;
    if (sourceConfiguration !== undefined) {
      for (const [field, value] of Object.entries(sourceConfiguration)) {
        if (typeof value !== 'string' || value.length === 0) {
          throw new Error(
            `authority processing source configuration ${field} is required`,
          );
        }
      }
      if (
        sourceConfiguration.credential_scope !== 'organization' ||
        !/^sha256:[0-9a-f]{64}$/.test(sourceConfiguration.owner_email_sha256) ||
        !/^sha256:[0-9a-f]{64}$/.test(
          sourceConfiguration.credential_reference_sha256,
        )
      ) {
        throw new Error(
          'authority processing source configuration binding is invalid',
        );
      }
    }
    this.database = openAuthorityDatabase(databasePath, {
      fileMustExist: options.fileMustExist,
    });
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Provisions or requires the permanent exact source-owner binding. */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    const status = this.immediate(() => {
      let ownerBindingProvisioned = false;
      let configurationBindingProvisioned = false;
      if (this.options.bindingMode === 'provision') {
        this.assertActiveMembership();
        const boundAt = assertCanonicalTimestamp(this.now(), 'bound_at');
        const ownerBinding = this.database
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
        ownerBindingProvisioned = ownerBinding.changes === 1;

        const sourceConfiguration = this.options.sourceConfiguration;
        if (sourceConfiguration !== undefined) {
          const existingConfiguration = this.database
            .prepare(
              `SELECT 1
                 FROM authority_processing_source_configuration_bindings
                WHERE source_adapter_id = ? AND source_instance_id = ?`,
            )
            .get(
              this.binding.source_adapter_id,
              this.binding.source_instance_id,
            );
          if (existingConfiguration === undefined) {
            this.assertNoStateBeforeSourceConfiguration();
          }
          const configurationBinding = this.database
            .prepare(
              `INSERT INTO authority_processing_source_configuration_bindings (
                 source_adapter_id, source_instance_id, owner_email_sha256,
                 credential_scope, credential_reference_sha256, bound_at
               ) VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT (source_adapter_id, source_instance_id) DO NOTHING`,
            )
            .run(
              this.binding.source_adapter_id,
              this.binding.source_instance_id,
              sourceConfiguration.owner_email_sha256,
              sourceConfiguration.credential_scope,
              sourceConfiguration.credential_reference_sha256,
              boundAt,
            );
          configurationBindingProvisioned = configurationBinding.changes === 1;
        }
      }
      this.assertActiveBinding();
      this.assertExactSourceConfiguration();
      return {
        owner_binding: ownerBindingProvisioned ? 'provisioned' : 'existing',
        configuration_binding: configurationBindingProvisioned
          ? 'provisioned'
          : 'existing',
      } as const;
    });
    this.provisioningStatus = status;
    this.initialized = true;
  }

  sourceProvisioningStatus(): AuthorityProcessingSourceProvisioningStatus {
    if (!this.initialized || this.provisioningStatus === null) {
      throw new Error('authority processing store is not initialized');
    }
    return Object.freeze({ ...this.provisioningStatus });
  }

  /** Any candidate without a durable processed marker blocks another pull. */
  async countUnfinishedCandidates(): Promise<number> {
    await this.initialize();
    this.assertActiveBinding();
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS count
           FROM authority_processing_candidates c
           LEFT JOIN authority_processing_processed_markers p
             ON p.processing_key = c.processing_key
          WHERE c.source_adapter_id = ? AND c.source_instance_id = ?
            AND p.processing_key IS NULL`,
      )
      .get(
        this.binding.source_adapter_id,
        this.binding.source_instance_id,
      ) as { count: number };
    return row.count;
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
      const storedBeforeAdmission = this.rawCandidate(processingKey);
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
      if (storedBeforeAdmission !== undefined) {
        this.assertSameRawCandidate(storedBeforeAdmission, meeting);
        return 'saved';
      }
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
      if (stored === undefined) {
        throw new Error('authority processing raw candidate was not stored');
      }
      this.assertSameRawCandidate(stored, meeting);
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

  /** Slack's store port: stage once, then return the durable winning view. */
  async ensureRequested(
    request: ApprovalRequest,
  ): Promise<AuthorityApprovalDecisionStoreView> {
    const id = await this.stageApprovalRequest(request);
    return this.approvalDecisionStoreView(id);
  }

  async freezeApprovalPresentationContract<
    T extends AuthorityFrozenApprovalPresentationContract,
  >(input: {
    readonly approvalId: string;
    readonly contract: T;
  }): Promise<T> {
    await this.initialize();
    const id = assertApprovalId(input.approvalId);
    const mode = approvalPresentationMode(input.contract);
    const encoded = exactJson(input.contract);
    return this.immediate(() => {
      this.assertActiveBinding();
      const request = this.approvalRequestIdentity(id);
      let stored = this.approvalPresentationContractRow(id);
      if (stored === undefined) {
        this.database
          .prepare(
            `INSERT INTO authority_processing_approval_presentation_contracts (
               processing_key, approval_id, contract_mode, contract_sha256,
               contract_json, created_at
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            request.processing_key,
            id,
            mode,
            encoded.sha256,
            encoded.json,
            assertCanonicalTimestamp(
              this.now(),
              'approval presentation contract created_at',
            ),
          );
        stored = this.approvalPresentationContractRow(id);
      }
      if (
        stored === undefined ||
        stored.processing_key !== request.processing_key ||
        stored.contract_mode !== mode ||
        stored.contract_sha256 !== encoded.sha256 ||
        stored.contract_json !== encoded.json
      ) {
        throw new Error(
          'authority processing approval presentation contract already contains different bytes',
        );
      }
      return this.decodeApprovalPresentationContract(stored) as T;
    });
  }

  readApprovalPresentationContract(
    approvalIdValue: string,
  ): AuthorityFrozenReviewerApprovalPresentationContract | null {
    const stored = this.readFrozenApprovalPresentationContract(approvalIdValue);
    return stored?.mode === 'restricted-reviewer-v1' ? stored : null;
  }

  readFrozenApprovalPresentationContract(
    approvalIdValue: string,
  ): AuthorityFrozenApprovalPresentationContract | null {
    this.assertInitialized();
    this.assertActiveBinding();
    const id = assertApprovalId(approvalIdValue);
    this.approvalRequestIdentity(id);
    const stored = this.approvalPresentationContractRow(id);
    return stored === undefined
      ? null
      : this.decodeApprovalPresentationContract(stored);
  }

  async recordPublished(input: {
    readonly processingKey: string;
    readonly surface: string;
    readonly reference: JsonObject;
  }): Promise<AuthorityApprovalDecisionStoreView> {
    await this.initialize();
    this.assertProcessingKey(input.processingKey);
    const surface = assertBoundedSurface(input.surface);
    const reference = assertJsonObject(
      input.reference,
      'authority processing approval publication reference',
    );
    const encoded = exactJson(reference);
    const id = approvalId(input.processingKey);
    this.immediate(() => {
      this.assertActiveBinding();
      const request = this.approvalRequestIdentity(id);
      if (request.processing_key !== input.processingKey) {
        throw new Error(
          'authority processing approval publication belongs to another request',
        );
      }
      let stored = this.approvalPublicationRow(input.processingKey, surface);
      if (stored === undefined) {
        this.database
          .prepare(
            `INSERT INTO authority_processing_approval_publications (
               processing_key, approval_id, surface, reference_sha256,
               reference_json, published_at
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.processingKey,
            id,
            surface,
            encoded.sha256,
            encoded.json,
            assertCanonicalTimestamp(this.now(), 'approval published_at'),
          );
        stored = this.approvalPublicationRow(input.processingKey, surface);
      }
      if (
        stored === undefined ||
        stored.reference_sha256 !== encoded.sha256 ||
        stored.reference_json !== encoded.json
      ) {
        throw new Error(
          'authority processing approval surface already published different bytes',
        );
      }
    });
    return this.approvalDecisionStoreView(id);
  }

  async resolve(input: {
    readonly approvalId: string;
    readonly status: 'approved' | 'rejected';
    readonly reviewedBy: string;
    readonly reason?: string | null;
    readonly surface: string;
    readonly metadata?: JsonObject;
    readonly reviewedAt?: string;
  }): Promise<AuthorityApprovalDecisionStoreView> {
    await this.initialize();
    const id = assertApprovalId(input.approvalId);
    const surface = assertBoundedSurface(input.surface);
    const metadata = assertJsonObject(
      input.metadata ?? {},
      'authority processing approval resolution metadata',
    );
    const encodedMetadata = exactJson(metadata);
    this.immediate(() => {
      this.assertActiveBinding();
      const requestIdentity = this.approvalRequestIdentity(id);
      const request = JSON.parse(requestIdentity.document_json) as ApprovalRequest;
      const existing = this.resolution(requestIdentity.processing_key);
      const reviewedAt =
        input.reviewedAt === undefined
          ? existing?.resolved_at ??
            assertCanonicalTimestamp(this.now(), 'approval reviewed_at')
          : assertCanonicalTimestamp(input.reviewedAt, 'approval reviewed_at');
      const decision = this.slackApprovalDecision(request, input, reviewedAt);
      const encodedDecision = exactJson(decision);
      const retainUntil = new Date(
        Date.parse(reviewedAt) + RETENTION_MILLISECONDS,
      ).toISOString();

      if (existing === undefined) {
        this.database
          .prepare(
            `INSERT INTO authority_processing_resolutions (
               processing_key, terminal_status, resolution_sha256,
               resolution_json, resolved_at, retain_until
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            requestIdentity.processing_key,
            input.status,
            encodedDecision.sha256,
            encodedDecision.json,
            reviewedAt,
            retainUntil,
          );
      }
      const storedResolution = this.resolution(requestIdentity.processing_key);
      if (
        storedResolution === undefined ||
        storedResolution.terminal_status !== input.status ||
        storedResolution.resolution_sha256 !== encodedDecision.sha256 ||
        storedResolution.resolution_json !== encodedDecision.json ||
        storedResolution.resolved_at !== reviewedAt ||
        storedResolution.retain_until !== retainUntil
      ) {
        throw new Error(
          'authority processing candidate already has a different terminal resolution',
        );
      }

      let storedMetadata = this.approvalResolutionMetadataRow(id);
      if (storedMetadata === undefined) {
        this.database
          .prepare(
            `INSERT INTO authority_processing_approval_resolution_metadata (
               processing_key, approval_id, surface, metadata_sha256,
               metadata_json, created_at
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            requestIdentity.processing_key,
            id,
            surface,
            encodedMetadata.sha256,
            encodedMetadata.json,
            reviewedAt,
          );
        storedMetadata = this.approvalResolutionMetadataRow(id);
      }
      if (
        storedMetadata === undefined ||
        storedMetadata.surface !== surface ||
        storedMetadata.metadata_sha256 !== encodedMetadata.sha256 ||
        storedMetadata.metadata_json !== encodedMetadata.json ||
        storedMetadata.resolved_at !== reviewedAt
      ) {
        throw new Error(
          'authority processing approval already has different resolution metadata',
        );
      }
    });
    return this.approvalDecisionStoreView(id);
  }

  readApprovalResolutionMetadata(
    approvalIdValue: string,
  ): AuthorityApprovalResolutionMetadata | null {
    this.assertInitialized();
    this.assertActiveBinding();
    const id = assertApprovalId(approvalIdValue);
    this.approvalRequestIdentity(id);
    const row = this.approvalResolutionMetadataRow(id);
    if (row === undefined) return null;
    const metadata = assertJsonObject(
      JSON.parse(row.metadata_json) as unknown,
      'stored authority processing approval resolution metadata',
    );
    if (digestCanonicalJson(row.metadata_json) !== row.metadata_sha256) {
      throw new Error(
        'stored authority processing approval resolution metadata digest is invalid',
      );
    }
    return Object.freeze({
      approval_id: row.approval_id,
      surface: row.surface,
      metadata,
      resolved_at: row.resolved_at,
    });
  }

  async getOrCreate<T extends AuthorityBuiltOrganizationRecordEnvelope>(
    idempotencyKey: string,
    create: () => Promise<T>,
  ): Promise<T> {
    await this.initialize();
    const id = assertApprovalId(idempotencyKey);
    const stored = this.readFrozenOrganizationRecordEnvelope(id);
    if (stored !== null) return stored as T;

    const existingCreate = this.recordEnvelopeCreates.get(id);
    if (existingCreate !== undefined) return (await existingCreate) as T;

    const pending = this.createFrozenOrganizationRecordEnvelope(id, create);
    this.recordEnvelopeCreates.set(id, pending);
    try {
      return (await pending) as T;
    } finally {
      if (this.recordEnvelopeCreates.get(id) === pending) {
        this.recordEnvelopeCreates.delete(id);
      }
    }
  }

  /** Explicit exact-replay seam used by migrations and store verification. */
  async freezeOrganizationRecordEnvelope<
    T extends AuthorityBuiltOrganizationRecordEnvelope,
  >(input: {
    readonly approvalId: string;
    readonly record: T;
  }): Promise<T> {
    await this.initialize();
    return this.freezeOrganizationRecordEnvelopeNow(
      assertApprovalId(input.approvalId),
      input.record,
      false,
    ) as T;
  }

  readFrozenOrganizationRecordEnvelope(
    approvalIdValue: string,
  ): AuthorityBuiltOrganizationRecordEnvelope | null {
    this.assertInitialized();
    this.assertActiveBinding();
    const id = assertApprovalId(approvalIdValue);
    this.approvalRequestIdentity(id);
    const row = this.frozenRecordEnvelopeRow(id);
    return row === undefined ? null : this.decodeFrozenRecordEnvelope(row);
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

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error('authority processing store is not initialized');
    }
  }

  private approvalRequestIdentity(
    approvalIdValue: string,
  ): ApprovalRequestIdentityRow {
    const id = assertApprovalId(approvalIdValue);
    const rows = this.database
      .prepare(
        `SELECT q.processing_key, q.document_json, q.document_sha256,
                q.request_approval_id
           FROM authority_processing_slots q
           JOIN authority_processing_candidates c
             ON c.processing_key = q.processing_key
          WHERE q.slot_name = '${APPROVAL_REQUEST_SLOT}'
            AND q.request_approval_id = ?
            AND c.source_adapter_id = ? AND c.source_instance_id = ?`,
      )
      .all(
        id,
        this.binding.source_adapter_id,
        this.binding.source_instance_id,
      ) as ApprovalRequestIdentityRow[];
    if (rows.length !== 1) {
      throw new Error(
        'authority processing approval request is not owned by this source',
      );
    }
    const row = rows[0]!;
    const parsed = JSON.parse(row.document_json) as unknown;
    const encoded = exactJson(parsed);
    if (
      row.request_approval_id !== id ||
      approvalId(row.processing_key) !== id ||
      row.document_json !== encoded.json ||
      row.document_sha256 !== encoded.sha256
    ) {
      throw new Error('authority processing approval request is invalid');
    }
    return row;
  }

  private approvalPresentationContractRow(
    approvalIdValue: string,
  ): ApprovalPresentationContractRow | undefined {
    return this.database
      .prepare(
        `SELECT p.processing_key, p.approval_id, p.contract_mode,
                p.contract_sha256, p.contract_json
           FROM authority_processing_approval_presentation_contracts p
           JOIN authority_processing_slots q
             ON q.processing_key = p.processing_key
            AND q.slot_name = '${APPROVAL_REQUEST_SLOT}'
            AND q.request_approval_id = p.approval_id
           JOIN authority_processing_candidates c
             ON c.processing_key = p.processing_key
          WHERE p.approval_id = ?
            AND c.source_adapter_id = ? AND c.source_instance_id = ?`,
      )
      .get(
        approvalIdValue,
        this.binding.source_adapter_id,
        this.binding.source_instance_id,
      ) as ApprovalPresentationContractRow | undefined;
  }

  private decodeApprovalPresentationContract(
    row: ApprovalPresentationContractRow,
  ): AuthorityFrozenApprovalPresentationContract {
    const parsed = JSON.parse(row.contract_json) as unknown;
    const mode = approvalPresentationMode(parsed);
    const encoded = exactJson(parsed);
    if (
      mode !== row.contract_mode ||
      encoded.json !== row.contract_json ||
      encoded.sha256 !== row.contract_sha256
    ) {
      throw new Error(
        'stored authority processing approval presentation contract is invalid',
      );
    }
    return Object.freeze({
      ...(parsed as AuthorityFrozenApprovalPresentationContract),
    });
  }

  private approvalPublicationRow(
    processingKey: string,
    surface: string,
  ): ApprovalPublicationRow | undefined {
    return this.database
      .prepare(
        `SELECT surface, reference_sha256, reference_json
           FROM authority_processing_approval_publications
          WHERE processing_key = ? AND surface = ?`,
      )
      .get(processingKey, surface) as ApprovalPublicationRow | undefined;
  }

  private approvalPublications(
    processingKey: string,
  ): AuthorityApprovalDecisionStoreView['published'] {
    const rows = this.database
      .prepare(
        `SELECT surface, reference_sha256, reference_json
           FROM authority_processing_approval_publications
          WHERE processing_key = ?
          ORDER BY published_at, surface`,
      )
      .all(processingKey) as ApprovalPublicationRow[];
    return rows.map((row) => {
      const parsed = JSON.parse(row.reference_json) as unknown;
      const reference = assertJsonObject(
        parsed,
        'stored authority processing approval publication reference',
      );
      const encoded = exactJson(reference);
      if (
        encoded.json !== row.reference_json ||
        encoded.sha256 !== row.reference_sha256
      ) {
        throw new Error(
          'stored authority processing approval publication reference is invalid',
        );
      }
      return Object.freeze({ surface: row.surface, reference });
    });
  }

  private approvalResolutionMetadataRow(
    approvalIdValue: string,
  ): ApprovalResolutionMetadataRow | undefined {
    return this.database
      .prepare(
        `SELECT m.approval_id, m.surface, m.metadata_sha256, m.metadata_json,
                r.resolved_at
           FROM authority_processing_approval_resolution_metadata m
           JOIN authority_processing_resolutions r
             ON r.processing_key = m.processing_key
           JOIN authority_processing_slots q
             ON q.processing_key = m.processing_key
            AND q.slot_name = '${APPROVAL_REQUEST_SLOT}'
            AND q.request_approval_id = m.approval_id
           JOIN authority_processing_candidates c
             ON c.processing_key = m.processing_key
          WHERE m.approval_id = ?
            AND c.source_adapter_id = ? AND c.source_instance_id = ?`,
      )
      .get(
        approvalIdValue,
        this.binding.source_adapter_id,
        this.binding.source_instance_id,
      ) as ApprovalResolutionMetadataRow | undefined;
  }

  private slackApprovalDecision(
    request: ApprovalRequest,
    input: Parameters<AuthorityApprovalDecisionStore['resolve']>[0],
    reviewedAt: string,
  ): ApprovalDecision {
    const decision: ApprovalDecision =
      input.status === 'approved'
        ? {
            status: 'approved',
            reviewed_at: reviewedAt,
            reviewed_by: input.reviewedBy,
            reason: input.reason ?? null,
            approved_brief: request.brief,
          }
        : {
            status: 'rejected',
            reviewed_at: reviewedAt,
            reviewed_by: input.reviewedBy,
            reason: input.reason ?? null,
            approved_brief: null,
          };
    assertCanonicalApprovalDecision(decision, {
      meeting: request.meeting,
      processor: request.decisions.processor,
      decisions: request.decisions,
    });
    return decision;
  }

  private approvalDecisionStoreView(
    approvalIdValue: string,
  ): AuthorityApprovalDecisionStoreView {
    this.assertInitialized();
    this.assertActiveBinding();
    const requestIdentity = this.approvalRequestIdentity(approvalIdValue);
    const request = JSON.parse(requestIdentity.document_json) as ApprovalRequest;
    const stored = this.resolution(requestIdentity.processing_key);
    let resolution: ApprovalDecision | null = null;
    if (stored !== undefined) {
      const parsed = JSON.parse(stored.resolution_json) as unknown;
      assertCanonicalApprovalDecision(parsed, {
        meeting: request.meeting,
        processor: request.decisions.processor,
        decisions: request.decisions,
      });
      const encoded = exactJson(parsed);
      if (
        parsed.status !== stored.terminal_status ||
        parsed.reviewed_at !== stored.resolved_at ||
        encoded.json !== stored.resolution_json ||
        encoded.sha256 !== stored.resolution_sha256
      ) {
        throw new Error(
          'stored authority processing approval resolution is invalid',
        );
      }
      resolution = parsed;
    }
    return Object.freeze({
      approval_id: requestIdentity.request_approval_id,
      status: resolution?.status ?? 'pending',
      reviewed_at: resolution?.reviewed_at ?? null,
      reviewed_by: resolution?.reviewed_by ?? null,
      reason: resolution?.reason ?? null,
      brief: request.brief,
      published: this.approvalPublications(requestIdentity.processing_key),
    });
  }

  private async createFrozenOrganizationRecordEnvelope<
    T extends AuthorityBuiltOrganizationRecordEnvelope,
  >(approvalIdValue: string, create: () => Promise<T>): Promise<T> {
    const existing = this.readFrozenOrganizationRecordEnvelope(approvalIdValue);
    if (existing !== null) return existing as T;
    const created = await create();
    return this.freezeOrganizationRecordEnvelopeNow(
      approvalIdValue,
      created,
      true,
    ) as T;
  }

  private freezeOrganizationRecordEnvelopeNow(
    approvalIdValue: string,
    record: AuthorityBuiltOrganizationRecordEnvelope,
    returnWinner: boolean,
  ): AuthorityBuiltOrganizationRecordEnvelope {
    const id = assertApprovalId(approvalIdValue);
    const candidate = this.validateOrganizationRecordEnvelope(id, record);
    const encoded = exactJson(candidate.envelope);
    return this.immediate(() => {
      this.assertActiveBinding();
      const request = this.approvalRequestIdentity(id);
      this.database
        .prepare(
          `INSERT INTO authority_processing_frozen_record_envelopes (
             processing_key, approval_id, envelope_id, event_type,
             envelope_sha256, envelope_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (processing_key) DO NOTHING`,
        )
        .run(
          request.processing_key,
          id,
          candidate.envelope_id,
          candidate.event_type,
          encoded.sha256,
          encoded.json,
          assertCanonicalTimestamp(this.now(), 'record envelope created_at'),
        );
      const row = this.frozenRecordEnvelopeRow(id);
      if (row === undefined) {
        throw new Error('authority processing frozen record envelope was not stored');
      }
      const stored = this.decodeFrozenRecordEnvelope(row);
      const exactReplay =
        row.processing_key === request.processing_key &&
        row.approval_id === id &&
        row.envelope_id === candidate.envelope_id &&
        row.event_type === candidate.event_type &&
        row.envelope_sha256 === encoded.sha256 &&
        row.envelope_json === encoded.json;
      if (!exactReplay && !returnWinner) {
        throw new Error(
          'authority processing approval already has a different frozen record envelope',
        );
      }
      return stored;
    });
  }

  private validateOrganizationRecordEnvelope(
    approvalIdValue: string,
    record: AuthorityBuiltOrganizationRecordEnvelope,
  ): AuthorityBuiltOrganizationRecordEnvelope & { readonly envelope: JsonObject } {
    const id = assertApprovalId(approvalIdValue);
    if (
      typeof record.envelope_id !== 'string' ||
      record.envelope_id.length < 1 ||
      record.envelope_id.length > 256 ||
      record.idempotency_key !== id ||
      record.event_type !== 'approval'
    ) {
      throw new Error(
        'authority processing frozen record envelope wrapper is invalid',
      );
    }
    const envelope = assertJsonObject(
      record.envelope,
      'authority processing frozen record envelope',
    );
    if (
      envelope['schema_version'] !== 3 ||
      envelope['kind'] !== 'echo-organization-record-envelope' ||
      envelope['envelope_id'] !== record.envelope_id ||
      envelope['idempotency_key'] !== id ||
      envelope['event_type'] !== 'approval'
    ) {
      throw new Error(
        'authority processing frozen record envelope identity is invalid',
      );
    }
    return Object.freeze({ ...record, envelope });
  }

  private frozenRecordEnvelopeRow(
    approvalIdValue: string,
  ): FrozenRecordEnvelopeRow | undefined {
    return this.database
      .prepare(
        `SELECT f.processing_key, f.approval_id, f.envelope_id, f.event_type,
                f.envelope_sha256, f.envelope_json
           FROM authority_processing_frozen_record_envelopes f
           JOIN authority_processing_slots q
             ON q.processing_key = f.processing_key
            AND q.slot_name = '${APPROVAL_REQUEST_SLOT}'
            AND q.request_approval_id = f.approval_id
           JOIN authority_processing_candidates c
             ON c.processing_key = f.processing_key
          WHERE f.approval_id = ?
            AND c.source_adapter_id = ? AND c.source_instance_id = ?`,
      )
      .get(
        approvalIdValue,
        this.binding.source_adapter_id,
        this.binding.source_instance_id,
      ) as FrozenRecordEnvelopeRow | undefined;
  }

  private decodeFrozenRecordEnvelope(
    row: FrozenRecordEnvelopeRow,
  ): AuthorityBuiltOrganizationRecordEnvelope {
    const envelope = assertJsonObject(
      JSON.parse(row.envelope_json) as unknown,
      'stored authority processing frozen record envelope',
    );
    const encoded = exactJson(envelope);
    if (
      encoded.json !== row.envelope_json ||
      encoded.sha256 !== row.envelope_sha256
    ) {
      throw new Error(
        'stored authority processing frozen record envelope digest is invalid',
      );
    }
    return this.validateOrganizationRecordEnvelope(row.approval_id, {
      envelope_id: row.envelope_id,
      idempotency_key: row.approval_id,
      event_type: row.event_type,
      envelope,
    });
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

  private assertExactSourceConfiguration(): void {
    const sourceConfiguration = this.options.sourceConfiguration;
    if (sourceConfiguration === undefined) return;
    if (
      this.database
        .prepare(
          `SELECT 1
             FROM authority_processing_source_configuration_bindings
            WHERE source_adapter_id = ? AND source_instance_id = ?
              AND owner_email_sha256 = ? AND credential_scope = ?
              AND credential_reference_sha256 = ?`,
        )
        .get(
          this.binding.source_adapter_id,
          this.binding.source_instance_id,
          sourceConfiguration.owner_email_sha256,
          sourceConfiguration.credential_scope,
          sourceConfiguration.credential_reference_sha256,
        ) === undefined
    ) {
      throw new Error(
        'authority processing source configuration differs from its immutable binding',
      );
    }
  }

  private assertNoStateBeforeSourceConfiguration(): void {
    const priorState = this.database
      .prepare(
        `SELECT 1
           FROM authority_processing_source_cursors
          WHERE source_adapter_id = ? AND source_instance_id = ?
          UNION ALL
         SELECT 1
           FROM authority_processing_candidates
          WHERE source_adapter_id = ? AND source_instance_id = ?
          UNION ALL
         SELECT 1
           FROM authority_processing_processed_markers
          WHERE source_adapter_id = ? AND source_instance_id = ?
          LIMIT 1`,
      )
      .get(
        this.binding.source_adapter_id,
        this.binding.source_instance_id,
        this.binding.source_adapter_id,
        this.binding.source_instance_id,
        this.binding.source_adapter_id,
        this.binding.source_instance_id,
      );
    if (priorState !== undefined) {
      throw new Error(
        'authority processing source configuration cannot be retroactively bound to existing state',
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

  private assertSameRawCandidate(
    stored: RawCandidateRow,
    meeting: MeetingDocument,
  ): void {
    if (
      stored.source_adapter_id !== this.binding.source_adapter_id ||
      stored.source_instance_id !== this.binding.source_instance_id ||
      stored.external_id !== meeting.provenance.external_id ||
      stored.meeting_revision !== meeting.provenance.canonical_revision ||
      stored.meeting_id !== meeting.id ||
      canonicalMeetingForReplay(
        JSON.parse(stored.raw_document_json) as MeetingDocument,
      ) !== canonicalMeetingForReplay(meeting)
    ) {
      throw new Error(
        'authority processing key already binds a different raw candidate',
      );
    }
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
      canonicalMeetingForReplay(
        JSON.parse(stored.raw_document_json) as MeetingDocument,
      ) !== canonicalMeetingForReplay(meeting)
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
