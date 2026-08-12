import type Database from 'better-sqlite3';
import type {
  ReadableSearchPlane,
  ReadableSearchPlaneMetadata,
  ReadableSearchSegmentIdentity,
} from '../application/contracts.js';
import {
  assertReadableSearchDigest,
  assertReadableSearchSegmentIdentity,
} from '../application/validation.js';

interface RawMetadata {
  schema_version: number;
  plane: ReadableSearchPlane;
  organization_id: string;
  segment_id: `sha256:${string}`;
  segment_kind: 'organization-member' | 'reviewer';
  policy_id: ReadableSearchSegmentIdentity['policy_id'];
  policy_contract_sha256: `sha256:${string}`;
  reviewer_principal_id: string | null;
  reviewer_membership_id: string | null;
  analyzer_contract_sha256: `sha256:${string}`;
  finalized: 0 | 1;
}

export abstract class ReadableSearchPlaneStore {
  protected constructor(
    readonly database: Database.Database,
    readonly plane: ReadableSearchPlane,
  ) {}

  initialize(metadata: Omit<ReadableSearchPlaneMetadata, 'schema_version' | 'plane' | 'finalized'>): void {
    const identity = assertReadableSearchSegmentIdentity(metadata);
    const existing = this.database.prepare(
      'SELECT 1 FROM retrieval_plane_metadata WHERE singleton = 1',
    ).get();
    if (existing !== undefined) throw new Error(`readable-search ${this.plane} metadata already exists`);
    this.database.prepare(
      `INSERT INTO retrieval_plane_metadata (
        singleton, schema_version, plane, organization_id, segment_id, segment_kind,
        policy_id, policy_contract_sha256, reviewer_principal_id, reviewer_membership_id,
        analyzer_contract_sha256, finalized
      ) VALUES (1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    ).run(
      this.plane,
      identity.organization_id,
      identity.segment_id,
      identity.segment_kind,
      identity.policy_id,
      identity.policy_contract_sha256,
      identity.reviewer_principal_id,
      identity.reviewer_membership_id,
      assertReadableSearchDigest(metadata.analyzer_contract_sha256, 'analyzer_contract_sha256'),
    );
  }

  metadata(): ReadableSearchPlaneMetadata {
    const row = this.database.prepare(
      `SELECT schema_version, plane, organization_id, segment_id, segment_kind,
              policy_id, policy_contract_sha256, reviewer_principal_id, reviewer_membership_id,
              analyzer_contract_sha256, finalized
       FROM retrieval_plane_metadata WHERE singleton = 1`,
    ).get() as RawMetadata | undefined;
    if (row === undefined) throw new Error(`readable-search ${this.plane} metadata is missing`);
    if (row.plane !== this.plane || row.schema_version !== 1 || (row.finalized !== 0 && row.finalized !== 1)) {
      throw new Error(`readable-search ${this.plane} metadata is invalid`);
    }
    return Object.freeze({
      ...assertReadableSearchSegmentIdentity(row),
      schema_version: 1,
      plane: this.plane,
      analyzer_contract_sha256: assertReadableSearchDigest(row.analyzer_contract_sha256, 'analyzer_contract_sha256'),
      finalized: row.finalized === 1,
    });
  }

  finalize(): void {
    const result = this.database.prepare(
      'UPDATE retrieval_plane_metadata SET finalized = 1 WHERE singleton = 1 AND finalized = 0',
    ).run();
    if (result.changes !== 1) throw new Error(`readable-search ${this.plane} plane is already finalized or missing`);
  }

  close(): void {
    this.database.close();
  }
}
