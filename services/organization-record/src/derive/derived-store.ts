import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type Database from 'better-sqlite3';
import type {
  DerivedAtomRow,
  DerivedEdgeRow,
  DerivedMeetingSnapshotRow,
  DerivedParticipantObservationRow,
  DerivedRejectionRow,
  JsonValue,
  OrganizationRecordProjection,
  Sha256Digest,
} from '../application/contracts.js';
import { OrganizationRecordError } from '../application/errors.js';
import {
  systemOrganizationRecordClock,
  type OrganizationRecordClock,
} from '../application/ports.js';
import { ORGANIZATION_RECORD_DERIVED_DATABASE } from '../persistence/database-definition.js';
import { openOrganizationRecordDatabase } from '../persistence/open-database.js';

export interface OpenOrganizationRecordDerivedOptions {
  readonly organization_id: string;
  readonly clock?: OrganizationRecordClock;
}

const ATOM_COLUMNS =
  'atom_id, log_position, record_hash, approval_group, signal_id, kind, text, subject, status, owner, due_at, confidence, evidence, restricted, reviewer_principal_id, reviewer_display_name, reviewed_at';
const SNAPSHOT_COLUMNS =
  'snapshot_id, log_position, record_hash, meeting_id, meeting_revision, source_adapter_id, source_instance_id, source_external_id, title, meeting_time';
const OBSERVATION_COLUMNS =
  'observation_id, snapshot_id, participant_id, display_name, identities, roles, response_status, attendance';
const REJECTION_COLUMNS =
  'rejection_id, log_position, record_hash, meeting_id, source_adapter_id, source_instance_id, source_external_id, reviewer_principal_id, reviewer_display_name, rejected_at, reason, reconsider_after';
const EDGE_COLUMNS = 'edge_type, from_id, to_id, log_position';

/**
 * The derived graph over `record-derived.sqlite`. Disposable and rebuildable.
 *
 * All rows and edges for one log record plus the cursor advance commit in one
 * transaction, so a crash leaves either all of them or none of them and no
 * reader ever sees half an approval's atoms or a cursor ahead of its rows.
 */
export class OrganizationRecordDerivedStore {
  readonly organization_id: string;
  readonly database: Database.Database;
  private readonly clock: OrganizationRecordClock;

  private constructor(
    database: Database.Database,
    options: OpenOrganizationRecordDerivedOptions,
  ) {
    this.database = database;
    this.organization_id = options.organization_id;
    this.clock = options.clock ?? systemOrganizationRecordClock;
  }

  static open(
    databasePath: string,
    options: OpenOrganizationRecordDerivedOptions,
  ): OrganizationRecordDerivedStore {
    const database = openOrganizationRecordDatabase(
      databasePath,
      ORGANIZATION_RECORD_DERIVED_DATABASE,
    );
    try {
      const store = new OrganizationRecordDerivedStore(database, options);
      store.initialize();
      return store;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  private initialize(): void {
    const now = this.clock();
    const existing = this.database
      .prepare(
        `SELECT organization_id FROM organization_derived_metadata WHERE singleton = 1`,
      )
      .get() as { organization_id: string } | undefined;
    if (existing === undefined) {
      this.database
        .prepare(
          `INSERT INTO organization_derived_metadata (singleton, organization_id, created_at)
           VALUES (1, ?, ?)`,
        )
        .run(this.organization_id, now);
    } else if (existing.organization_id !== this.organization_id) {
      throw new Error(
        'organization record derived store belongs to a different organization',
      );
    }
    this.database
      .prepare(
        `INSERT OR IGNORE INTO organization_derived_cursor (singleton, last_position, updated_at)
         VALUES (1, 0, ?)`,
      )
      .run(now);
  }

  cursorPosition(): number {
    const row = this.database
      .prepare(`SELECT last_position FROM organization_derived_cursor WHERE singleton = 1`)
      .get() as { last_position: number } | undefined;
    return row?.last_position ?? 0;
  }

  /** One log record's rows, edges, and the cursor advance, atomically. */
  commitRecord(projection: OrganizationRecordProjection): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const cursor = this.cursorPosition();
      if (projection.log_position !== cursor + 1) {
        throw new OrganizationRecordError(
          'derive_halted',
          `organization record derive is at ${cursor} and cannot commit position ${projection.log_position}`,
        );
      }
      const insertAtom = this.database.prepare(
        `INSERT INTO organization_derived_atom (${ATOM_COLUMNS})
         VALUES (@atom_id, @log_position, @record_hash, @approval_group, @signal_id, @kind, @text, @subject, @status, @owner, @due_at, @confidence, @evidence, @restricted, @reviewer_principal_id, @reviewer_display_name, @reviewed_at)`,
      );
      const insertSnapshot = this.database.prepare(
        `INSERT INTO organization_derived_meeting_snapshot (${SNAPSHOT_COLUMNS})
         VALUES (@snapshot_id, @log_position, @record_hash, @meeting_id, @meeting_revision, @source_adapter_id, @source_instance_id, @source_external_id, @title, @meeting_time)`,
      );
      const insertObservation = this.database.prepare(
        `INSERT INTO organization_derived_participant_observation (${OBSERVATION_COLUMNS})
         VALUES (@observation_id, @snapshot_id, @participant_id, @display_name, @identities, @roles, @response_status, @attendance)`,
      );
      const insertRejection = this.database.prepare(
        `INSERT INTO organization_derived_rejection (${REJECTION_COLUMNS})
         VALUES (@rejection_id, @log_position, @record_hash, @meeting_id, @source_adapter_id, @source_instance_id, @source_external_id, @reviewer_principal_id, @reviewer_display_name, @rejected_at, @reason, @reconsider_after)`,
      );
      // Every insert here is strict. A conflict is a projection that disagrees
      // with what is already stored, so it must roll back this record's rows,
      // edges, and cursor together rather than quietly collapsing into them.
      const insertEdge = this.database.prepare(
        `INSERT INTO organization_derived_edge (${EDGE_COLUMNS})
         VALUES (@edge_type, @from_id, @to_id, @log_position)`,
      );

      // Snapshots precede observations so the observation foreign key holds.
      for (const snapshot of projection.meeting_snapshots) insertSnapshot.run(snapshot);
      for (const observation of projection.participant_observations) {
        insertObservation.run(observation);
      }
      for (const atom of projection.atoms) insertAtom.run(atom);
      for (const rejection of projection.rejections) insertRejection.run(rejection);
      for (const edge of projection.edges) insertEdge.run(edge);

      this.database
        .prepare(
          `UPDATE organization_derived_cursor
           SET last_position = ?, updated_at = ?
           WHERE singleton = 1`,
        )
        .run(projection.log_position, this.clock());
      this.database.exec('COMMIT');
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {}
      throw error;
    }
  }

  atoms(): readonly DerivedAtomRow[] {
    return this.database
      .prepare(`SELECT ${ATOM_COLUMNS} FROM organization_derived_atom ORDER BY atom_id`)
      .all() as DerivedAtomRow[];
  }

  meetingSnapshots(): readonly DerivedMeetingSnapshotRow[] {
    return this.database
      .prepare(
        `SELECT ${SNAPSHOT_COLUMNS} FROM organization_derived_meeting_snapshot ORDER BY snapshot_id`,
      )
      .all() as DerivedMeetingSnapshotRow[];
  }

  participantObservations(): readonly DerivedParticipantObservationRow[] {
    return this.database
      .prepare(
        `SELECT ${OBSERVATION_COLUMNS} FROM organization_derived_participant_observation ORDER BY observation_id`,
      )
      .all() as DerivedParticipantObservationRow[];
  }

  rejections(): readonly DerivedRejectionRow[] {
    return this.database
      .prepare(
        `SELECT ${REJECTION_COLUMNS} FROM organization_derived_rejection ORDER BY rejection_id`,
      )
      .all() as DerivedRejectionRow[];
  }

  edges(): readonly DerivedEdgeRow[] {
    return this.database
      .prepare(
        `SELECT ${EDGE_COLUMNS} FROM organization_derived_edge ORDER BY edge_type, from_id, to_id`,
      )
      .all() as DerivedEdgeRow[];
  }

  /**
   * A hash over an ordered dump of every derived row.
   *
   * The tested property is that a full rebuild reproduces this digest, not
   * that the two database files are byte-identical — SQLite page layout varies
   * across library versions. Derivation wall-clock (`updated_at`,
   * `created_at`) is deliberately outside the digest: it is not log content.
   */
  contentDigest(): Sha256Digest {
    return canonicalSha256({
      kind: 'echo-organization-record-derived-content',
      schema_version: 1,
      cursor_position: this.cursorPosition(),
      atoms: this.atoms() as unknown as JsonValue,
      meeting_snapshots: this.meetingSnapshots() as unknown as JsonValue,
      participant_observations: this.participantObservations() as unknown as JsonValue,
      rejections: this.rejections() as unknown as JsonValue,
      edges: this.edges() as unknown as JsonValue,
    });
  }

  close(): void {
    this.database.close();
  }
}
