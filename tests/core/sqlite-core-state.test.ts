import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApprovalDecision } from '../../src/core/approval/approval-gate.js';
import type { DecisionSet, DecisionSignal } from '../../src/core/contracts/decision.js';
import type {
  DecisionBrief,
  DeliveryEnvelope,
  DeliveryReceipt,
} from '../../src/core/contracts/delivery.js';
import type { MeetingDocument } from '../../src/core/contracts/meeting.js';
import { SqliteCoreStateStore } from '../../src/product/storage/sqlite-core-state-store.js';

const PRODUCT_MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL('../../src/product/storage/migrations/', import.meta.url),
);

const PRODUCT_TABLES = [
  'core_approvals',
  'core_decision_sets',
  'core_delivery_receipts',
  'core_meeting_documents',
  'core_processed_markers',
  'core_source_cursors',
  'federated_chain_heads',
  'federated_outbox_events',
  'federated_processor_attributions',
  'federated_source_attributions',
  'organization_access_high_watermarks',
  'organization_authority_pins',
  'organization_enrollments',
];

const source = {
  kind: 'meeting-source' as const,
  adapter_id: 'source-alpha',
  instance_id: 'primary',
  version: '1.0.0',
};

const meeting: MeetingDocument = {
  schema_version: 1,
  id: 'meeting-1',
  title: 'Architecture review',
  time: { actual_start_at: '2026-07-16T16:00:00.000Z' },
  capture: {
    state: 'complete',
    components: [{ kind: 'transcript', state: 'available' }],
  },
  participants: [
    {
      id: 'participant-1',
      display_name: 'Operator',
      identities: [{ kind: 'email', value: 'operator@example.test' }],
    },
  ],
  content: [
    {
      id: 'block-1',
      kind: 'transcript',
      text: 'We decided to keep the core tool agnostic.',
    },
  ],
  artifacts: [],
  provenance: {
    source,
    external_id: 'external-meeting-1',
    canonical_revision: 'revision-1',
    observed_at: '2026-07-16T17:01:00.000Z',
    normalizer_version: '1.0.0',
    source_updated_at: '2026-07-16T17:00:00.000Z',
  },
};

const decisionSignal: DecisionSignal = {
  id: 'decision-1',
  kind: 'decision',
  text: 'Keep the core tool agnostic',
  subject: 'core-architecture',
  confidence: 0.98,
  status: 'decided',
  evidence: [{ meeting_id: meeting.id, block_id: 'block-1' }],
};

const decisions: DecisionSet = {
  schema_version: 1,
  meeting_id: meeting.id,
  meeting_revision: meeting.provenance.canonical_revision,
  processor: {
    kind: 'decision-processor',
    adapter_id: 'processor-alpha',
    instance_id: 'primary',
    version: '2.0.0',
  },
  generated_at: '2026-07-16T17:02:00.000Z',
  signals: [decisionSignal],
};

const brief: DecisionBrief = {
  schema_version: 1,
  id: 'brief-1',
  meeting: {
    id: meeting.id,
    title: meeting.title,
    time: meeting.time,
    participants: meeting.participants,
  },
  decisions: [decisionSignal],
  actions: [],
  rationales: [],
  provenance: {
    meeting_revision: meeting.provenance.canonical_revision,
    processor: decisions.processor,
    generated_at: decisions.generated_at,
  },
};

const approval: ApprovalDecision = {
  status: 'approved',
  reviewed_at: '2026-07-16T17:03:00.000Z',
  reviewed_by: 'reviewer-1',
  reason: null,
  approved_brief: brief,
};

const envelope: DeliveryEnvelope = {
  schema_version: 1,
  id: 'envelope-1',
  idempotency_key: 'delivery:processing-1:delivery-alpha:primary:team-1',
  destination: {
    adapter_id: 'delivery-alpha',
    instance_id: 'primary',
    external_id: 'team-1',
  },
  brief,
  approved_at: approval.reviewed_at,
};

const receipt: DeliveryReceipt = {
  schema_version: 1,
  envelope_id: envelope.id,
  status: 'delivered',
  external_id: 'message-1',
  recorded_at: '2026-07-16T17:04:00.000Z',
  retryable: false,
};

const temporaryDirectories: string[] = [];

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), 'echo-core-state-'));
  temporaryDirectories.push(directory);
  return join(directory, 'state.sqlite');
}

function readJsonRow<T>(db: Database.Database, table: string, column: string): T {
  const row = db.prepare(`SELECT ${column} AS document FROM ${table}`).get() as {
    document: string;
  };
  return JSON.parse(row.document) as T;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('SqliteCoreStateStore', () => {
  it('persists every core state category across a database restart', async () => {
    const databasePath = temporaryDatabase();
    const processingKey = 'processing-1';
    const first = new SqliteCoreStateStore(databasePath);

    expect(await first.getSourceCursor(source)).toBeUndefined();
    expect(await first.hasProcessed(processingKey)).toBe(false);
    await first.setSourceCursor(source, 'cursor-1');
    await first.saveMeeting(meeting);
    await first.saveDecisionSet(meeting, decisions);
    await first.saveApproval(processingKey, approval);
    await first.saveDeliveryReceipt(envelope, receipt);
    await first.markProcessed(processingKey);
    first.close();

    const reopened = new SqliteCoreStateStore(databasePath);
    expect(await reopened.getSourceCursor(source)).toBe('cursor-1');
    expect(await reopened.hasProcessed(processingKey)).toBe(true);
    expect(
      await reopened.getDecisionSet(
        meeting,
        decisions.processor,
      ),
    ).toEqual(decisions);
    reopened.close();

    const db = new Database(databasePath, { readonly: true });
    expect(readJsonRow<MeetingDocument>(db, 'core_meeting_documents', 'document_json')).toEqual(
      meeting,
    );
    expect(readJsonRow<DecisionSet>(db, 'core_decision_sets', 'document_json')).toEqual(decisions);
    expect(readJsonRow<ApprovalDecision>(db, 'core_approvals', 'decision_json')).toEqual(approval);
    expect(
      readJsonRow<DeliveryEnvelope>(db, 'core_delivery_receipts', 'envelope_json'),
    ).toEqual(envelope);
    expect(
      readJsonRow<DeliveryReceipt>(db, 'core_delivery_receipts', 'receipt_json'),
    ).toEqual(receipt);
    db.close();
  });

  it('atomically upserts repeated logical records instead of duplicating them', async () => {
    const databasePath = temporaryDatabase();
    const store = new SqliteCoreStateStore(databasePath);
    const processingKey = 'processing-1';

    await store.setSourceCursor(source, 'cursor-1');
    await store.setSourceCursor({ ...source, version: '1.1.0' }, 'cursor-2');

    await store.saveMeeting(meeting);
    const updatedMeeting = { ...meeting, title: 'Updated architecture review' };
    await store.saveMeeting(updatedMeeting);

    await store.saveDecisionSet(meeting, decisions);
    const updatedDecisions = { ...decisions, generated_at: '2026-07-16T17:02:30.000Z' };
    await store.saveDecisionSet(meeting, updatedDecisions);

    await store.saveApproval(processingKey, approval);
    const updatedApproval: ApprovalDecision = {
      status: 'rejected',
      reviewed_at: approval.reviewed_at,
      reviewed_by: approval.reviewed_by,
      reason: 'superseded during retry',
      approved_brief: null,
    };
    await store.saveApproval(processingKey, updatedApproval);

    await store.saveDeliveryReceipt(envelope, receipt);
    const updatedEnvelope = { ...envelope, id: 'envelope-2' };
    const updatedReceipt: DeliveryReceipt = {
      ...receipt,
      envelope_id: updatedEnvelope.id,
      external_id: 'message-2',
    };
    await store.saveDeliveryReceipt(updatedEnvelope, updatedReceipt);
    await store.markProcessed(processingKey);
    await store.markProcessed(processingKey);

    expect(await store.getSourceCursor(source)).toBeUndefined();
    expect(await store.getSourceCursor({ ...source, version: '1.1.0' })).toBe(
      'cursor-2',
    );
    store.close();

    const db = new Database(databasePath, { readonly: true });
    for (const table of [
      'core_source_cursors',
      'core_meeting_documents',
      'core_decision_sets',
      'core_approvals',
      'core_delivery_receipts',
      'core_processed_markers',
    ]) {
      const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
        count: number;
      };
      expect(row.count, table).toBe(1);
    }
    expect(readJsonRow<MeetingDocument>(db, 'core_meeting_documents', 'document_json')).toEqual(
      updatedMeeting,
    );
    expect(readJsonRow<DecisionSet>(db, 'core_decision_sets', 'document_json')).toEqual(
      updatedDecisions,
    );
    expect(readJsonRow<ApprovalDecision>(db, 'core_approvals', 'decision_json')).toEqual(
      approval,
    );
    expect(
      readJsonRow<DeliveryReceipt>(db, 'core_delivery_receipts', 'receipt_json'),
    ).toEqual(receipt);
    db.close();
  });

  it('rejects a mismatched receipt without persisting a partial delivery record', async () => {
    const databasePath = temporaryDatabase();
    const store = new SqliteCoreStateStore(databasePath);
    const mismatchedReceipt = { ...receipt, envelope_id: 'some-other-envelope' };

    await expect(store.saveDeliveryReceipt(envelope, mismatchedReceipt)).rejects.toThrow(
      /does not match its envelope/,
    );
    store.close();

    const db = new Database(databasePath, { readonly: true });
    const row = db.prepare('SELECT COUNT(*) AS count FROM core_delivery_receipts').get() as {
      count: number;
    };
    expect(row.count).toBe(0);
    db.close();
  });

  it('allows pending approval to resolve once and never overwrites the winning snapshot', async () => {
    const store = new SqliteCoreStateStore(temporaryDatabase());
    const processingKey = 'approval-resolution-once';
    const pending: ApprovalDecision = {
      status: 'pending',
      reviewed_at: null,
      reviewed_by: null,
      reason: null,
      approved_brief: null,
    };
    const conflicting: ApprovalDecision = {
      status: 'rejected',
      reviewed_at: '2026-07-16T17:04:00.000Z',
      reviewed_by: 'reviewer-2',
      reason: 'conflicting resolution',
      approved_brief: null,
    };

    await store.saveApproval(processingKey, pending);
    await store.saveApproval(processingKey, approval);
    await store.saveApproval(processingKey, conflicting);

    expect(await store.getApproval(processingKey)).toEqual(approval);
    store.close();
  });

  it('scopes cached decision sets to the exact source adapter instance', async () => {
    const store = new SqliteCoreStateStore(temporaryDatabase());
    const otherMeeting: MeetingDocument = {
      ...meeting,
      content: [
        {
          id: 'block-other',
          kind: 'note',
          text: 'Decision: ship the second source artifact.',
        },
      ],
      provenance: {
        ...meeting.provenance,
        source: { ...meeting.provenance.source, instance_id: 'secondary' },
        external_id: 'external-meeting-other',
      },
    };
    const emptyDecisions: DecisionSet = { ...decisions, signals: [] };
    const otherDecisions: DecisionSet = {
      ...decisions,
      signals: [
        {
          ...decisions.signals[0]!,
          id: 'decision-other',
          text: 'Ship the second source artifact',
          evidence: [
            { meeting_id: otherMeeting.id, block_id: 'block-other' },
          ],
        },
      ],
    };

    await store.saveDecisionSet(meeting, emptyDecisions);
    await store.saveDecisionSet(otherMeeting, otherDecisions);

    expect(await store.getDecisionSet(meeting, decisions.processor)).toEqual(
      emptyDecisions,
    );
    expect(
      await store.getDecisionSet(otherMeeting, decisions.processor),
    ).toEqual(otherDecisions);
    store.close();
  });

  it('allows an uncertain delivery to converge to delivered but never regresses delivery', async () => {
    const databasePath = temporaryDatabase();
    const store = new SqliteCoreStateStore(databasePath);
    const uncertainReceipt: DeliveryReceipt = {
      ...receipt,
      status: 'unknown',
      external_id: null,
      retryable: true,
    };
    await store.saveDeliveryReceipt(envelope, uncertainReceipt);
    await store.saveDeliveryReceipt(envelope, receipt);
    await store.saveDeliveryReceipt(envelope, uncertainReceipt);
    store.close();

    const db = new Database(databasePath, { readonly: true });
    expect(
      readJsonRow<DeliveryReceipt>(db, 'core_delivery_receipts', 'receipt_json'),
    ).toEqual(receipt);
    db.close();
  });

  it('installs schema v5 with only the thirteen product-state tables', () => {
    const databasePath = temporaryDatabase();
    const store = new SqliteCoreStateStore(databasePath);
    store.close();

    const db = new Database(databasePath, { readonly: true });
    expect(db.pragma('user_version', { simple: true })).toBe(5);
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as { name: string }[];
    expect(tables.map(({ name }) => name)).toEqual(PRODUCT_TABLES);
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE name LIKE 'idx_events_%'")
        .all(),
    ).toEqual([]);
    db.close();
  });

  it('upgrades v3 by deleting legacy event data without changing product state', async () => {
    const databasePath = temporaryDatabase();
    const legacy = new Database(databasePath);
    for (const filename of [
      '0001_initial.sql',
      '0002_core_state.sql',
      '0003_federated_founder_identity.sql',
    ]) {
      legacy.exec(
        readFileSync(join(PRODUCT_MIGRATIONS_DIRECTORY, filename), 'utf8'),
      );
    }
    legacy.pragma('user_version = 3');
    legacy
      .prepare(
        `INSERT INTO events (id, source, timestamp, content)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        'legacy-event-1',
        'test:legacy',
        '2026-07-16T17:05:00.000Z',
        'retired capture data',
      );
    legacy
      .prepare(
        `INSERT INTO core_source_cursors (
           source_adapter_id, source_instance_id, source_version, cursor
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(source.adapter_id, source.instance_id, source.version, 'cursor-v3');
    legacy
      .prepare(
        `INSERT INTO federated_chain_heads (
           installation_id, last_sequence, last_event_hash, updated_at
         ) VALUES (?, ?, ?, ?)`,
      )
      .run('installation-v3', 0, null, '2026-07-16T17:06:00.000Z');
    legacy.close();

    const upgraded = new SqliteCoreStateStore(databasePath);
    expect(await upgraded.getSourceCursor(source)).toBe('cursor-v3');
    upgraded.close();

    const db = new Database(databasePath, { readonly: true });
    expect(db.pragma('user_version', { simple: true })).toBe(5);
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
           ORDER BY name`,
        )
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual(PRODUCT_TABLES);
    expect(
      db
        .prepare(
          `SELECT last_sequence FROM federated_chain_heads
           WHERE installation_id = ?`,
        )
        .get('installation-v3'),
    ).toEqual({ last_sequence: 0 });
    db.close();
  });
});
