import type Database from 'better-sqlite3';
import { canonicalJson, canonicalSha256, type Sha256Digest } from '@echo-brain/federation-protocol';
import { validatePersonHandInMeetingV1, type PersonHandInMeetingV1 } from '@echo-brain/organization-api';
import { AUTHORITY_BASELINE_SCHEMA_VERSION, isCurrentAuthorityState } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/baseline';

/** The source adapter of every hand-in source: its meetings, transcripts included, are what their person handed in. */
export const HAND_IN_SOURCE_ADAPTER_ID_V1 = 'person-hand-in-meeting';

/** A handed-in meeting as kept: its payload, the digest its id derives from, and when it was handed in. */
export interface StoredHandInMeetingV1 {
  readonly external_id: string; readonly meeting: PersonHandInMeetingV1; readonly payload_sha256: Sha256Digest; readonly submitted_at: string;
}

/** The id a handed-in meeting's canonical content derives, so the same meeting handed in again is the same meeting. */
export function handInMeetingIdV1(meeting: PersonHandInMeetingV1): string {
  return `hand-in-${canonicalSha256(validatePersonHandInMeetingV1(meeting)).slice(7)}`;
}

/**
 * The payloads people hand in (`authority_person_hand_in_meetings_v1`), each kept once per source and content-derived
 * id. A payload is written only inside the caller's transaction, the one that queues its import, so both commit or
 * neither does.
 */
export class SqlitePersonHandInMeetingsV1 {
  constructor(private readonly database: Database.Database) {
    if (!isCurrentAuthorityState(database)) {
      throw new Error(`Handed-in meetings require Authority V${AUTHORITY_BASELINE_SCHEMA_VERSION} state with foreign keys enabled`);
    }
  }

  /** Keeps one meeting for a source and returns its id; the same meeting again keeps nothing new. */
  save(sourceKey: string, value: PersonHandInMeetingV1): string {
    if (!this.database.inTransaction) throw new Error('A handed-in meeting is kept only with its queued import');
    const meeting = validatePersonHandInMeetingV1(value), digest = canonicalSha256(meeting), externalId = `hand-in-${digest.slice(7)}`;
    this.database.prepare(`INSERT INTO authority_person_hand_in_meetings_v1(source_key,external_id,payload_json,payload_sha256,submitted_at)
      VALUES (?,?,?,?,?) ON CONFLICT(source_key,external_id) DO NOTHING`).run(sourceKey, externalId, canonicalJson(meeting), digest, new Date().toISOString());
    return externalId;
  }

  /**
   * Forgets a cancelled meeting's payload, in the transaction that drops its queued import. A meeting an admitted source
   * revision already holds keeps its payload; the delete trigger refuses every other delete.
   */
  forget(sourceKey: string, externalId: string): void {
    if (!this.database.inTransaction) throw new Error('A handed-in meeting is forgotten only with its cancelled import');
    this.database.prepare(`DELETE FROM authority_person_hand_in_meetings_v1 AS kept WHERE kept.source_key=? AND kept.external_id=? AND NOT EXISTS (
      SELECT 1 FROM authority_live_source_admission_v2 a JOIN authority_sources_v1 s
        ON s.organization_id=a.organization_id AND s.adapter_id=a.source_adapter_id AND s.instance_id=a.source_adapter_instance_id
      WHERE a.source_key=kept.source_key AND s.external_id=kept.external_id)`).run(sourceKey, externalId);
  }

  /** One source's meeting, checked against its digest and id; undefined when the source keeps none by that id. */
  get(sourceKey: string, externalId: string): StoredHandInMeetingV1 | undefined {
    const row = this.database.prepare('SELECT payload_json,payload_sha256,submitted_at FROM authority_person_hand_in_meetings_v1 WHERE source_key=? AND external_id=?')
      .get(sourceKey, externalId) as { payload_json: string; payload_sha256: string; submitted_at: string } | undefined;
    if (!row) return undefined;
    const meeting = validatePersonHandInMeetingV1(JSON.parse(row.payload_json));
    if (canonicalJson(meeting) !== row.payload_json || canonicalSha256(meeting) !== row.payload_sha256 || `hand-in-${row.payload_sha256.slice(7)}` !== externalId) {
      throw new Error('Handed-in meeting integrity failed');
    }
    return Object.freeze({ external_id: externalId, meeting, payload_sha256: row.payload_sha256 as Sha256Digest, submitted_at: row.submitted_at });
  }
}
