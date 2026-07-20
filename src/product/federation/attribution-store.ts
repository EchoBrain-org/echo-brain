import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { ApprovalRequest } from '../../core/approval/approval-gate.js';
import type { JsonValue } from '../../core/contracts/json.js';
import type { MeetingDocument } from '../../core/contracts/meeting.js';
import type { DecisionSet } from '../../core/contracts/decision.js';
import { migrate } from '../../storage/migrate.js';
import {
  canonicalJson,
  canonicalSha256,
  parseCanonicalJson,
} from './canonical-json.js';
import type {
  ApprovalFederationMetadataV1,
  ProcessorAttributionV1,
  SourceAttributionV1,
} from './contracts.js';
import { validateFederationDocument } from './schema-validation.js';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../storage/migrations',
);

export interface SourceAttributionKey {
  source_adapter_id: string;
  source_instance_id: string;
  external_id: string;
  meeting_revision: string;
}

export interface ProcessorAttributionKey extends SourceAttributionKey {
  processor_adapter_id: string;
  processor_instance_id: string;
  processor_version: string;
}

interface SourceAttributionRow extends SourceAttributionKey {
  identity_manifest_id: string;
  adapter_binding_id: string;
  connection_id: string;
  connection_generation: number;
  attribution_json: string;
  captured_at: string;
}

interface ProcessorAttributionRow extends ProcessorAttributionKey {
  identity_manifest_id: string;
  adapter_binding_id: string;
  attribution_json: string;
  captured_at: string;
}

interface CoreJsonRow {
  document_json: string;
}

export interface AttributionStorageVerification {
  source_attributions: number;
  processor_attributions: number;
}

export interface AttributionStorageEvidenceVerifier {
  verifySourceAttribution(value: SourceAttributionV1): void;
  verifyProcessorAttribution(value: ProcessorAttributionV1): void;
  verifyAttributionPair(
    source: SourceAttributionV1,
    processor: ProcessorAttributionV1,
  ): void;
}

function fail(message: string): never {
  throw new Error(`federated attribution storage failed: ${message}`);
}

function sourceKeyFromMeeting(meeting: MeetingDocument): SourceAttributionKey {
  return {
    source_adapter_id: meeting.provenance.source.adapter_id,
    source_instance_id: meeting.provenance.source.instance_id,
    external_id: meeting.provenance.external_id,
    meeting_revision: meeting.provenance.canonical_revision,
  };
}

function processorKeyFrom(
  meeting: MeetingDocument,
  decisions: DecisionSet,
): ProcessorAttributionKey {
  return {
    ...sourceKeyFromMeeting(meeting),
    processor_adapter_id: decisions.processor.adapter_id,
    processor_instance_id: decisions.processor.instance_id,
    processor_version: decisions.processor.version,
  };
}

function sourceKeyFromAttribution(
  attribution: SourceAttributionV1,
): SourceAttributionKey {
  return {
    source_adapter_id: attribution.source.adapter.adapter_id,
    source_instance_id: attribution.source.adapter.instance_id,
    external_id: attribution.meeting.external_id,
    meeting_revision: attribution.meeting.canonical_revision,
  };
}

function processorKeyFromAttribution(
  attribution: ProcessorAttributionV1,
): ProcessorAttributionKey {
  return {
    source_adapter_id: attribution.meeting.source_adapter_id,
    source_instance_id: attribution.meeting.source_instance_id,
    external_id: attribution.meeting.external_id,
    meeting_revision: attribution.meeting.meeting_revision,
    processor_adapter_id: attribution.processor.adapter.adapter_id,
    processor_instance_id: attribution.processor.adapter.instance_id,
    processor_version: attribution.processor.adapter.version,
  };
}

function parseCoreJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    fail(`${label} is invalid JSON: ${(error as Error).message}`);
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/**
 * Owns only the immutable attribution sidecars in the shared product SQLite
 * database. Existing core rows remain owned by SqliteCoreStateStore.
 */
export class SqliteFederatedAttributionStore {
  private readonly db: Database.Database;
  private readonly readSourceStatement: Database.Statement;
  private readonly insertSourceStatement: Database.Statement;
  private readonly readProcessorStatement: Database.Statement;
  private readonly insertProcessorStatement: Database.Statement;
  private readonly readSourceObservationStatement: Database.Statement;
  private readonly readCoreMeetingStatement: Database.Statement;
  private readonly readCoreDecisionSetStatement: Database.Statement;

  constructor(databasePath: string) {
    if (databasePath !== ':memory:') {
      mkdirSync(dirname(databasePath), { recursive: true });
      if (existsSync(databasePath)) {
        const state = lstatSync(databasePath);
        if (state.isSymbolicLink() || !state.isFile()) {
          throw new Error('attribution database must be a regular file');
        }
      }
    }
    this.db = new Database(databasePath);
    if (databasePath !== ':memory:') chmodSync(databasePath, 0o600);
    this.db.pragma('journal_mode = WAL');
    // Attribution must survive before the separately-owned core upsert runs.
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    migrate(this.db, MIGRATIONS_DIR);

    this.readSourceStatement = this.db.prepare(
      `SELECT * FROM federated_source_attributions
       WHERE source_adapter_id = @source_adapter_id
         AND source_instance_id = @source_instance_id
         AND external_id = @external_id
         AND meeting_revision = @meeting_revision`,
    );
    this.insertSourceStatement = this.db.prepare(
      `INSERT INTO federated_source_attributions (
         source_adapter_id, source_instance_id, external_id, meeting_revision,
         identity_manifest_id, adapter_binding_id, connection_id,
         connection_generation, attribution_json, captured_at
       ) VALUES (
         @source_adapter_id, @source_instance_id, @external_id, @meeting_revision,
         @identity_manifest_id, @adapter_binding_id, @connection_id,
         @connection_generation, @attribution_json, @captured_at
       ) ON CONFLICT (
         source_adapter_id, source_instance_id, external_id, meeting_revision
       ) DO NOTHING`,
    );
    this.readProcessorStatement = this.db.prepare(
      `SELECT * FROM federated_processor_attributions
       WHERE source_adapter_id = @source_adapter_id
         AND source_instance_id = @source_instance_id
         AND external_id = @external_id
         AND meeting_revision = @meeting_revision
         AND processor_adapter_id = @processor_adapter_id
         AND processor_instance_id = @processor_instance_id
         AND processor_version = @processor_version`,
    );
    this.insertProcessorStatement = this.db.prepare(
      `INSERT INTO federated_processor_attributions (
         source_adapter_id, source_instance_id, external_id, meeting_revision,
         processor_adapter_id, processor_instance_id, processor_version,
         identity_manifest_id, adapter_binding_id, attribution_json, captured_at
       ) VALUES (
         @source_adapter_id, @source_instance_id, @external_id, @meeting_revision,
         @processor_adapter_id, @processor_instance_id, @processor_version,
         @identity_manifest_id, @adapter_binding_id, @attribution_json, @captured_at
       ) ON CONFLICT (
         source_adapter_id, source_instance_id, external_id, meeting_revision,
         processor_adapter_id, processor_instance_id, processor_version
       ) DO NOTHING`,
    );
    this.readSourceObservationStatement = this.db.prepare(
      `SELECT source_adapter_id, source_instance_id, external_id, meeting_revision
       FROM federated_source_attributions
       WHERE json_extract(attribution_json, '$.source_observation_id') = ?`,
    );
    this.readCoreMeetingStatement = this.db.prepare(
      `SELECT document_json FROM core_meeting_documents
       WHERE source_adapter_id = @source_adapter_id
         AND source_instance_id = @source_instance_id
         AND external_id = @external_id
         AND meeting_revision = @meeting_revision`,
    );
    this.readCoreDecisionSetStatement = this.db.prepare(
      `SELECT document_json FROM core_decision_sets
       WHERE source_adapter_id = @source_adapter_id
         AND source_instance_id = @source_instance_id
         AND external_id = @external_id
         AND meeting_revision = @meeting_revision
         AND processor_adapter_id = @processor_adapter_id
         AND processor_instance_id = @processor_instance_id
         AND processor_version = @processor_version`,
    );
  }

  getSourceAttribution(
    key: SourceAttributionKey,
  ): SourceAttributionV1 | undefined {
    const row = this.readSourceStatement.get(key) as
      SourceAttributionRow | undefined;
    return row === undefined ? undefined : this.parseSourceRow(row);
  }

  getProcessorAttribution(
    key: ProcessorAttributionKey,
  ): ProcessorAttributionV1 | undefined {
    const row = this.readProcessorStatement.get(key) as
      ProcessorAttributionRow | undefined;
    return row === undefined ? undefined : this.parseProcessorRow(row);
  }

  getUnmaterializedSourceAttribution(
    key: SourceAttributionKey,
  ): SourceAttributionV1 | undefined {
    const attribution = this.getSourceAttribution(key);
    if (
      attribution === undefined ||
      this.readCoreMeetingStatement.get(key) !== undefined
    ) {
      return undefined;
    }
    return attribution;
  }

  getUnmaterializedProcessorAttribution(
    key: ProcessorAttributionKey,
  ): ProcessorAttributionV1 | undefined {
    const attribution = this.getProcessorAttribution(key);
    if (
      attribution === undefined ||
      this.readCoreDecisionSetStatement.get(key) !== undefined
    ) {
      return undefined;
    }
    return attribution;
  }

  preflightOrInsertSourceAttribution(
    value: SourceAttributionV1,
  ): SourceAttributionV1 {
    const attribution = validateFederationDocument<SourceAttributionV1>(
      'source-attribution',
      value,
    );
    this.assertSourceSemantics(attribution);
    const key = sourceKeyFromAttribution(attribution);
    const duplicateObservations = this.readSourceObservationStatement.all(
      attribution.source_observation_id,
    ) as SourceAttributionKey[];
    if (duplicateObservations.some((item) => !sameValue(item, key))) {
      fail('source observation identifier is already bound to another meeting');
    }
    const canonical = canonicalJson(attribution);
    const existing = this.getSourceAttribution(key);
    if (existing !== undefined) {
      if (canonicalJson(existing) !== canonical) {
        fail(
          'source attribution natural key already has different immutable facts',
        );
      }
      this.assertCoreMeetingConsistent(existing, false);
      return existing;
    }
    if (this.readCoreMeetingStatement.get(key) !== undefined) {
      fail(
        'cannot attach source attribution to a pre-existing legacy meeting row',
      );
    }
    this.insertSourceStatement.run({
      ...key,
      identity_manifest_id: attribution.identity_manifest_id,
      adapter_binding_id: attribution.source.adapter_binding_id,
      connection_id: attribution.connection.connection_id,
      connection_generation: attribution.connection.generation,
      attribution_json: canonical,
      captured_at: attribution.captured_at,
    });
    const stored = this.getSourceAttribution(key);
    if (stored === undefined || canonicalJson(stored) !== canonical) {
      fail(
        'concurrent source attribution insert chose different immutable facts',
      );
    }
    return stored;
  }

  preflightOrInsertProcessorAttribution(
    value: ProcessorAttributionV1,
  ): ProcessorAttributionV1 {
    const attribution = validateFederationDocument<ProcessorAttributionV1>(
      'processor-attribution',
      value,
    );
    this.assertProcessorSemantics(attribution);
    const key = processorKeyFromAttribution(attribution);
    this.assertProcessorContinuesSource(attribution);
    const canonical = canonicalJson(attribution);
    const existing = this.getProcessorAttribution(key);
    if (existing !== undefined) {
      if (canonicalJson(existing) !== canonical) {
        fail(
          'processor attribution natural key already has different immutable facts',
        );
      }
      this.assertCoreDecisionSetConsistent(existing, false);
      return existing;
    }
    if (this.readCoreDecisionSetStatement.get(key) !== undefined) {
      fail(
        'cannot attach processor attribution to a pre-existing legacy decision set',
      );
    }
    this.insertProcessorStatement.run({
      ...key,
      identity_manifest_id: attribution.identity_manifest_id,
      adapter_binding_id: attribution.processor.adapter_binding_id,
      attribution_json: canonical,
      captured_at: attribution.captured_at,
    });
    const stored = this.getProcessorAttribution(key);
    if (stored === undefined || canonicalJson(stored) !== canonical) {
      fail(
        'concurrent processor attribution insert chose different immutable facts',
      );
    }
    return stored;
  }

  async getAttributions(request: ApprovalRequest): Promise<{
    source: SourceAttributionV1;
    processor: ProcessorAttributionV1;
  }> {
    const source = this.getSourceAttribution(
      sourceKeyFromMeeting(request.meeting),
    );
    const processor = this.getProcessorAttribution(
      processorKeyFrom(request.meeting, request.decisions),
    );
    if (source === undefined || processor === undefined) {
      fail('approval request has no complete durable attribution pair');
    }
    this.assertSourceCoreMaterialized(source);
    this.assertProcessorContinuesSource(processor);
    this.assertProcessorCoreMaterialized(processor);
    if (
      processor.captured_at < source.captured_at ||
      source.meeting.document_sha256 !== canonicalSha256(request.meeting) ||
      processor.processor.decision_set_sha256 !==
        canonicalSha256(request.decisions)
    ) {
      fail('approval request differs from its durable attribution sidecars');
    }
    return { source, processor };
  }

  async getAttributionsForMetadata(
    metadata: ApprovalFederationMetadataV1,
  ): Promise<{
    source: SourceAttributionV1;
    processor: ProcessorAttributionV1;
  }> {
    const sourceReference = metadata.source_attribution_ref;
    const source = this.getSourceAttribution({
      source_adapter_id: sourceReference.source_adapter_id,
      source_instance_id: sourceReference.source_instance_id,
      external_id: sourceReference.external_id,
      meeting_revision: sourceReference.meeting_revision,
    });
    const processor = this.getProcessorAttribution({
      source_adapter_id: sourceReference.source_adapter_id,
      source_instance_id: sourceReference.source_instance_id,
      external_id: sourceReference.external_id,
      meeting_revision: sourceReference.meeting_revision,
      processor_adapter_id: metadata.processor.adapter.adapter_id,
      processor_instance_id: metadata.processor.adapter.instance_id,
      processor_version: metadata.processor.adapter.version,
    });
    if (source === undefined || processor === undefined) {
      fail('approval metadata has no complete durable attribution pair');
    }
    this.assertSourceCoreMaterialized(source);
    this.assertProcessorContinuesSource(processor);
    this.assertProcessorCoreMaterialized(processor);
    if (
      canonicalSha256(source) !== sourceReference.attribution_sha256 ||
      canonicalSha256(processor) !== metadata.processor.attribution_sha256 ||
      processor.processor.adapter_binding_id !==
        metadata.processor.adapter_binding_id ||
      !sameValue(processor.processor.adapter, metadata.processor.adapter) ||
      !sameValue(
        processor.processor.configuration_snapshot,
        metadata.processor.configuration_snapshot,
      ) ||
      processor.processor.configuration_sha256 !==
        metadata.processor.configuration_sha256
    ) {
      fail('approval metadata does not resolve to its exact attribution pair');
    }
    return { source, processor };
  }

  verifyStoredAttributions(
    evidenceVerifier?: AttributionStorageEvidenceVerifier,
  ): AttributionStorageVerification {
    if (this.db.inTransaction) {
      return this.verifyStoredAttributionsFromCurrentSnapshot(evidenceVerifier);
    }
    this.db.exec('BEGIN');
    try {
      const result =
        this.verifyStoredAttributionsFromCurrentSnapshot(evidenceVerifier);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Preserve the validation failure if SQLite already rolled back.
      }
      throw error;
    }
  }

  private verifyStoredAttributionsFromCurrentSnapshot(
    evidenceVerifier?: AttributionStorageEvidenceVerifier,
  ): AttributionStorageVerification {
    const sourceRows = this.db
      .prepare('SELECT * FROM federated_source_attributions')
      .all() as SourceAttributionRow[];
    const processorRows = this.db
      .prepare('SELECT * FROM federated_processor_attributions')
      .all() as ProcessorAttributionRow[];
    // Core rows without sidecars are structurally legacy. They remain
    // disposable/unverified and are never upgraded by this audit. Native
    // identity-enabled writes are protected at the state-store decorator;
    // this verifier therefore audits every sidecar that actually exists.
    const observationIds = new Set<string>();
    for (const row of sourceRows) {
      const source = this.parseSourceRow(row);
      if (observationIds.has(source.source_observation_id)) {
        fail('duplicate source observation identifier in attribution storage');
      }
      observationIds.add(source.source_observation_id);
      evidenceVerifier?.verifySourceAttribution(source);
      if (this.readCoreMeetingStatement.get(sourceKeyFromAttribution(source))) {
        this.assertSourceCoreMaterialized(source);
      } else if (evidenceVerifier === undefined) {
        fail(
          'unmaterialized source attribution requires historical evidence verification before recovery',
        );
      }
    }
    for (const row of processorRows) {
      const processor = this.parseProcessorRow(row);
      this.assertProcessorContinuesSource(processor);
      evidenceVerifier?.verifyProcessorAttribution(processor);
      const source = this.getSourceAttribution({
        source_adapter_id: processor.meeting.source_adapter_id,
        source_instance_id: processor.meeting.source_instance_id,
        external_id: processor.meeting.external_id,
        meeting_revision: processor.meeting.meeting_revision,
      });
      if (source === undefined) {
        fail('processor attribution has no preceding source attribution');
      }
      if (source.identity_manifest_id !== processor.identity_manifest_id) {
        if (evidenceVerifier === undefined) {
          fail(
            'cross-manifest attribution pair requires historical lineage verification',
          );
        }
        evidenceVerifier.verifyAttributionPair(source, processor);
      } else {
        evidenceVerifier?.verifyAttributionPair(source, processor);
      }
      if (
        this.readCoreDecisionSetStatement.get(
          processorKeyFromAttribution(processor),
        )
      ) {
        this.assertProcessorCoreMaterialized(processor);
      } else if (evidenceVerifier === undefined) {
        fail(
          'unmaterialized processor attribution requires historical evidence verification before recovery',
        );
      }
    }
    return {
      source_attributions: sourceRows.length,
      processor_attributions: processorRows.length,
    };
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  private parseSourceRow(row: SourceAttributionRow): SourceAttributionV1 {
    const value = validateFederationDocument<SourceAttributionV1>(
      'source-attribution',
      parseCanonicalJson<JsonValue>(row.attribution_json),
    );
    this.assertSourceSemantics(value);
    const key = sourceKeyFromAttribution(value);
    if (
      !sameValue(key, {
        source_adapter_id: row.source_adapter_id,
        source_instance_id: row.source_instance_id,
        external_id: row.external_id,
        meeting_revision: row.meeting_revision,
      }) ||
      row.identity_manifest_id !== value.identity_manifest_id ||
      row.adapter_binding_id !== value.source.adapter_binding_id ||
      row.connection_id !== value.connection.connection_id ||
      row.connection_generation !== value.connection.generation ||
      row.captured_at !== value.captured_at
    ) {
      fail('source attribution columns disagree with canonical JSON');
    }
    return value;
  }

  private parseProcessorRow(
    row: ProcessorAttributionRow,
  ): ProcessorAttributionV1 {
    const value = validateFederationDocument<ProcessorAttributionV1>(
      'processor-attribution',
      parseCanonicalJson<JsonValue>(row.attribution_json),
    );
    this.assertProcessorSemantics(value);
    const key = processorKeyFromAttribution(value);
    if (
      !sameValue(key, {
        source_adapter_id: row.source_adapter_id,
        source_instance_id: row.source_instance_id,
        external_id: row.external_id,
        meeting_revision: row.meeting_revision,
        processor_adapter_id: row.processor_adapter_id,
        processor_instance_id: row.processor_instance_id,
        processor_version: row.processor_version,
      }) ||
      row.identity_manifest_id !== value.identity_manifest_id ||
      row.adapter_binding_id !== value.processor.adapter_binding_id ||
      row.captured_at !== value.captured_at
    ) {
      fail('processor attribution columns disagree with canonical JSON');
    }
    return value;
  }

  private assertSourceSemantics(value: SourceAttributionV1): void {
    if (
      value.source.adapter.kind !== 'meeting-source' ||
      canonicalSha256(value.source.configuration_snapshot) !==
        value.source.configuration_sha256
    ) {
      fail(
        'source attribution adapter or configuration digest is inconsistent',
      );
    }
  }

  private assertProcessorSemantics(value: ProcessorAttributionV1): void {
    if (
      value.processor.adapter.kind !== 'decision-processor' ||
      canonicalSha256(value.processor.configuration_snapshot) !==
        value.processor.configuration_sha256
    ) {
      fail(
        'processor attribution adapter or configuration digest is inconsistent',
      );
    }
  }

  private assertProcessorContinuesSource(
    attribution: ProcessorAttributionV1,
  ): void {
    const key = processorKeyFromAttribution(attribution);
    const source = this.getSourceAttribution({
      source_adapter_id: key.source_adapter_id,
      source_instance_id: key.source_instance_id,
      external_id: key.external_id,
      meeting_revision: key.meeting_revision,
    });
    if (source === undefined) {
      fail('processor attribution has no preceding source attribution');
    }
    this.assertSourceCoreMaterialized(source);
    if (attribution.captured_at < source.captured_at) {
      fail('processor attribution does not continue its source attribution');
    }
  }

  private assertCoreMeetingConsistent(
    attribution: SourceAttributionV1,
    required: boolean,
  ): void {
    const row = this.readCoreMeetingStatement.get(
      sourceKeyFromAttribution(attribution),
    ) as CoreJsonRow | undefined;
    if (row === undefined) {
      if (required) fail('source attribution has no materialized core meeting');
      return;
    }
    const meeting = parseCoreJson<MeetingDocument>(
      row.document_json,
      'core meeting document',
    );
    if (
      !sameValue(
        sourceKeyFromMeeting(meeting),
        sourceKeyFromAttribution(attribution),
      ) ||
      canonicalSha256(meeting) !== attribution.meeting.document_sha256
    ) {
      fail('core meeting differs from its immutable source attribution');
    }
  }

  private assertCoreDecisionSetConsistent(
    attribution: ProcessorAttributionV1,
    required: boolean,
  ): void {
    const key = processorKeyFromAttribution(attribution);
    const row = this.readCoreDecisionSetStatement.get(key) as
      CoreJsonRow | undefined;
    if (row === undefined) {
      if (required)
        fail('processor attribution has no materialized core decision set');
      return;
    }
    const decisions = parseCoreJson<DecisionSet>(
      row.document_json,
      'core decision set',
    );
    if (
      decisions.meeting_revision !== attribution.meeting.meeting_revision ||
      decisions.processor.adapter_id !== key.processor_adapter_id ||
      decisions.processor.instance_id !== key.processor_instance_id ||
      decisions.processor.version !== key.processor_version ||
      canonicalSha256(decisions) !== attribution.processor.decision_set_sha256
    ) {
      fail(
        'core decision set differs from its immutable processor attribution',
      );
    }
  }

  private assertSourceCoreMaterialized(attribution: SourceAttributionV1): void {
    this.assertCoreMeetingConsistent(attribution, true);
  }

  private assertProcessorCoreMaterialized(
    attribution: ProcessorAttributionV1,
  ): void {
    this.assertCoreDecisionSetConsistent(attribution, true);
  }
}
