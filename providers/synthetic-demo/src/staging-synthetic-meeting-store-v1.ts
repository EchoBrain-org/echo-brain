import type Database from 'better-sqlite3';
import { canonicalJson, canonicalSha256 } from '@echo-brain/federation-protocol';
import { validatePersonSyntheticMeetingV1, type PersonSyntheticMeetingV1 } from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { assertCanonicalMeetingDocument, type MeetingDocument, type MeetingSourceAdapter } from '@echo-brain/organization-processing/core';

/** Provider-owned, lineage-bound sidecar; never changes the Authority SQL baseline. */
export class StagingSyntheticMeetingStoreV1 {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS staging_custom_meetings_v1 (
      source_instance TEXT NOT NULL, meeting_id TEXT NOT NULL, input_sha256 TEXT NOT NULL, meeting_json TEXT NOT NULL,
      PRIMARY KEY (source_instance, meeting_id)
    ) STRICT`);
  }

  get(sourceInstance: string, id: string): MeetingDocument | undefined {
    const row = this.db.prepare('SELECT meeting_json FROM staging_custom_meetings_v1 WHERE source_instance=? AND meeting_id=?')
      .get(sourceInstance, id) as { meeting_json: string } | undefined;
    if (!row) return undefined;
    const value: unknown = JSON.parse(row.meeting_json);
    assertCanonicalMeetingDocument(value);
    return value;
  }

  /** Immutable ids make a lost-response retry safe, including after processing or a restart. */
  save(identity: MeetingSourceAdapter['identity'], value: PersonSyntheticMeetingV1): void {
    const input = validatePersonSyntheticMeetingV1(value);
    const digest = canonicalSha256(input);
    this.db.transaction(() => {
      const old = this.db.prepare('SELECT input_sha256 FROM staging_custom_meetings_v1 WHERE source_instance=? AND meeting_id=?')
        .get(identity.instance_id, input.id) as { input_sha256: string } | undefined;
      if (old) {
        if (old.input_sha256 !== digest) throw new AuthorityOperationError('stale_access_state', 'Synthetic meeting id already contains different content; use a new id');
        return;
      }
      const count = (where: string, ...args: string[]) => this.db.prepare(`SELECT count(*) FROM staging_custom_meetings_v1 ${where}`).pluck().get(...args) as number;
      if (count('WHERE source_instance=?', identity.instance_id) >= 100 || count('') >= 1000) {
        throw new AuthorityOperationError('invalid_request', 'Synthetic meeting storage limit reached');
      }
      const meeting: MeetingDocument = {
        schema_version: 1, id: input.id, title: `SYNTHETIC STAGING - ${input.title}`, lifecycle: 'completed',
        provenance: { source: identity, external_id: input.id, canonical_revision: digest, observed_at: new Date().toISOString(),
          normalizer_version: 'staging-synthetic-meeting-v1', metadata: { synthetic: true, environment: 'staging' } },
        capture: { state: 'complete', components: [{ kind: 'metadata', state: 'available' },
          ...(input.notes.trim() ? [{ kind: 'notes' as const, state: 'available' as const }] : []),
          ...(input.transcript.trim() ? [{ kind: 'transcript' as const, state: 'available' as const }] : [])] },
        participants: [], artifacts: [],
        content: [
          ...(input.notes.trim() ? [{ id: 'custom-notes', kind: 'note' as const, origin: 'unknown' as const, text: input.notes }] : []),
          ...(input.transcript.trim() ? [{ id: 'custom-transcript', kind: 'transcript' as const, origin: 'unknown' as const, text: input.transcript }] : []),
        ],
        context: { labels: ['synthetic', 'staging-only', 'not-a-real-meeting'], metadata: { synthetic: true, purpose: 'custom-meeting-rehearsal' } },
      };
      assertCanonicalMeetingDocument(meeting);
      this.db.prepare('INSERT INTO staging_custom_meetings_v1 VALUES (?,?,?,?)').run(identity.instance_id, input.id, digest, canonicalJson(meeting));
    }).immediate();
  }
}
