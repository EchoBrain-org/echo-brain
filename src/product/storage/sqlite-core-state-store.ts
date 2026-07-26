import type Database from 'better-sqlite3';
import type { ApprovalDecision } from '../../core/approval/approval-gate.js';
import type { AdapterIdentity } from '../../core/contracts/adapter.js';
import type { DecisionSet } from '../../core/contracts/decision.js';
import type { DeliveryEnvelope, DeliveryReceipt } from '../../core/contracts/delivery.js';
import type { AdapterCursor, MeetingDocument } from '../../core/contracts/meeting.js';
import type { CoreStateStore } from '../../core/storage/core-state-store.js';
import { openProductDatabase } from './open-product-database.js';

interface CursorRow {
  cursor: string;
  source_version: string;
}

interface CountRow {
  count: number;
}

interface JsonRow {
  document_json: string;
}

/**
 * Durable state for the tool-agnostic core cycle.
 *
 * Records use the stable identity supplied by each core contract as their
 * conflict key. Every save is therefore an atomic SQLite upsert and can be
 * repeated safely after a process restart.
 */
export class SqliteCoreStateStore implements CoreStateStore {
  private readonly db: Database.Database;
  private readonly getCursorStatement: Database.Statement;
  private readonly setCursorStatement: Database.Statement;
  private readonly hasProcessedStatement: Database.Statement;
  private readonly saveMeetingStatement: Database.Statement;
  private readonly getDecisionSetStatement: Database.Statement;
  private readonly saveDecisionSetStatement: Database.Statement;
  private readonly getApprovalStatement: Database.Statement;
  private readonly saveApprovalStatement: Database.Statement;
  private readonly saveDeliveryReceiptStatement: Database.Statement;
  private readonly markProcessedStatement: Database.Statement;

  constructor(dbPath: string) {
    this.db = openProductDatabase(dbPath, { durability: 'operational' });

    this.getCursorStatement = this.db.prepare(
      `SELECT cursor, source_version
       FROM core_source_cursors
       WHERE source_adapter_id = @source_adapter_id
         AND source_instance_id = @source_instance_id`,
    );
    this.setCursorStatement = this.db.prepare(
      `INSERT INTO core_source_cursors (
         source_adapter_id, source_instance_id, source_version, cursor
       ) VALUES (
         @source_adapter_id, @source_instance_id, @source_version, @cursor
       )
       ON CONFLICT (source_adapter_id, source_instance_id) DO UPDATE SET
         source_version = excluded.source_version,
         cursor = excluded.cursor,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    );
    this.hasProcessedStatement = this.db.prepare(
      `SELECT COUNT(*) AS count
       FROM core_processed_markers
       WHERE processing_key = ?`,
    );
    this.saveMeetingStatement = this.db.prepare(
      `INSERT INTO core_meeting_documents (
         source_adapter_id,
         source_instance_id,
         external_id,
         meeting_revision,
         meeting_id,
         document_json
       ) VALUES (
         @source_adapter_id,
         @source_instance_id,
         @external_id,
         @meeting_revision,
         @meeting_id,
         @document_json
       )
       ON CONFLICT (
         source_adapter_id,
         source_instance_id,
         external_id,
         meeting_revision
       ) DO UPDATE SET
         meeting_id = excluded.meeting_id,
         document_json = excluded.document_json,
         saved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    );
    this.saveDecisionSetStatement = this.db.prepare(
      `INSERT INTO core_decision_sets (
         source_adapter_id,
         source_instance_id,
         external_id,
         meeting_id,
         meeting_revision,
         processor_adapter_id,
         processor_instance_id,
         processor_version,
         document_json
       ) VALUES (
         @source_adapter_id,
         @source_instance_id,
         @external_id,
         @meeting_id,
         @meeting_revision,
         @processor_adapter_id,
         @processor_instance_id,
         @processor_version,
         @document_json
       )
       ON CONFLICT (
         source_adapter_id,
         source_instance_id,
         external_id,
         meeting_revision,
         processor_adapter_id,
         processor_instance_id,
         processor_version
       ) DO UPDATE SET
         document_json = excluded.document_json,
         saved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    );
    this.getDecisionSetStatement = this.db.prepare(
      `SELECT document_json
       FROM core_decision_sets
       WHERE source_adapter_id = @source_adapter_id
         AND source_instance_id = @source_instance_id
         AND external_id = @external_id
         AND meeting_revision = @meeting_revision
         AND processor_adapter_id = @processor_adapter_id
         AND processor_instance_id = @processor_instance_id
         AND processor_version = @processor_version`,
    );
    this.getApprovalStatement = this.db.prepare(
      `SELECT decision_json AS document_json
       FROM core_approvals
       WHERE processing_key = ?`,
    );
    this.saveApprovalStatement = this.db.prepare(
      `INSERT INTO core_approvals (processing_key, decision_json)
       VALUES (@processing_key, @decision_json)
       ON CONFLICT (processing_key) DO UPDATE SET
         decision_json = excluded.decision_json,
         saved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE json_extract(core_approvals.decision_json, '$.status') = 'pending'
         AND json_extract(excluded.decision_json, '$.status') <> 'pending'`,
    );
    this.saveDeliveryReceiptStatement = this.db.prepare(
      `INSERT INTO core_delivery_receipts (
         idempotency_key, envelope_id, status, envelope_json, receipt_json
       ) VALUES (
         @idempotency_key, @envelope_id, @status, @envelope_json, @receipt_json
       )
       ON CONFLICT (idempotency_key) DO UPDATE SET
         envelope_id = excluded.envelope_id,
         status = excluded.status,
         envelope_json = excluded.envelope_json,
         receipt_json = excluded.receipt_json,
         saved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE core_delivery_receipts.status <> 'delivered'`,
    );
    this.markProcessedStatement = this.db.prepare(
      `INSERT INTO core_processed_markers (processing_key)
       VALUES (?)
       ON CONFLICT (processing_key) DO NOTHING`,
    );
  }

  async getSourceCursor(
    source: AdapterIdentity & { kind: 'meeting-source' },
  ): Promise<AdapterCursor | undefined> {
    const row = this.getCursorStatement.get({
      source_adapter_id: source.adapter_id,
      source_instance_id: source.instance_id,
    }) as CursorRow | undefined;
    return row?.source_version === source.version ? row.cursor : undefined;
  }

  async setSourceCursor(
    source: AdapterIdentity & { kind: 'meeting-source' },
    cursor: AdapterCursor,
  ): Promise<void> {
    this.setCursorStatement.run({
      source_adapter_id: source.adapter_id,
      source_instance_id: source.instance_id,
      source_version: source.version,
      cursor,
    });
  }

  async hasProcessed(processingKey: string): Promise<boolean> {
    const row = this.hasProcessedStatement.get(processingKey) as CountRow;
    return row.count > 0;
  }

  async saveMeeting(meeting: MeetingDocument): Promise<void> {
    this.saveMeetingStatement.run({
      source_adapter_id: meeting.provenance.source.adapter_id,
      source_instance_id: meeting.provenance.source.instance_id,
      external_id: meeting.provenance.external_id,
      meeting_revision: meeting.provenance.canonical_revision,
      meeting_id: meeting.id,
      document_json: JSON.stringify(meeting),
    });
  }

  async saveDecisionSet(
    meeting: MeetingDocument,
    decisions: DecisionSet,
  ): Promise<void> {
    this.saveDecisionSetStatement.run({
      source_adapter_id: meeting.provenance.source.adapter_id,
      source_instance_id: meeting.provenance.source.instance_id,
      external_id: meeting.provenance.external_id,
      meeting_id: decisions.meeting_id,
      meeting_revision: decisions.meeting_revision,
      processor_adapter_id: decisions.processor.adapter_id,
      processor_instance_id: decisions.processor.instance_id,
      processor_version: decisions.processor.version,
      document_json: JSON.stringify(decisions),
    });
  }

  async getDecisionSet(
    meeting: MeetingDocument,
    processor: AdapterIdentity & { kind: 'decision-processor' },
  ): Promise<DecisionSet | undefined> {
    const row = this.getDecisionSetStatement.get({
      source_adapter_id: meeting.provenance.source.adapter_id,
      source_instance_id: meeting.provenance.source.instance_id,
      external_id: meeting.provenance.external_id,
      meeting_revision: meeting.provenance.canonical_revision,
      processor_adapter_id: processor.adapter_id,
      processor_instance_id: processor.instance_id,
      processor_version: processor.version,
    }) as JsonRow | undefined;
    return row === undefined
      ? undefined
      : (JSON.parse(row.document_json) as DecisionSet);
  }

  async saveApproval(processingKey: string, decision: ApprovalDecision): Promise<void> {
    this.saveApprovalStatement.run({
      processing_key: processingKey,
      decision_json: JSON.stringify(decision),
    });
  }

  async getApproval(
    processingKey: string,
  ): Promise<ApprovalDecision | undefined> {
    const row = this.getApprovalStatement.get(processingKey) as
      | JsonRow
      | undefined;
    return row === undefined
      ? undefined
      : (JSON.parse(row.document_json) as ApprovalDecision);
  }

  async saveDeliveryReceipt(
    envelope: DeliveryEnvelope,
    receipt: DeliveryReceipt,
  ): Promise<void> {
    if (receipt.envelope_id !== envelope.id) {
      throw new Error('delivery receipt does not match its envelope');
    }
    this.saveDeliveryReceiptStatement.run({
      idempotency_key: envelope.idempotency_key,
      envelope_id: envelope.id,
      status: receipt.status,
      envelope_json: JSON.stringify(envelope),
      receipt_json: JSON.stringify(receipt),
    });
  }

  async markProcessed(processingKey: string): Promise<void> {
    this.markProcessedStatement.run(processingKey);
  }

  close(): void {
    if (!this.db.open) return;
    this.db.close();
  }
}
