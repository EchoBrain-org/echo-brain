import type Database from 'better-sqlite3';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type { SourceAdapterIdentityV1 } from '@echo-brain/organization-processing/core';
import type { AdmittedMeetingProcessingCommitmentsV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/admitted-meeting-processing-commitments';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';

export interface MeetingIntakePersonV1 { readonly organization_id: string; readonly principal_id: string; readonly membership_id: string }
/** One source per person and tool account; a watched folder carries the project it suggests for its meetings. */
export interface MeetingIntakeSettingV1 extends MeetingIntakePersonV1 {
  readonly source_key: string; readonly person_key: string; readonly folder_id: string | null; readonly folder_project_id: string | null; readonly settings_revision: number;
  readonly source_adapter_id: string; readonly source_adapter_version: string; readonly source_adapter_instance_id: string;
}
export interface PersonalMeetingCheckpointV1 { readonly folder: string | null; readonly baseline: boolean; readonly revisions: Readonly<Record<string, string>>; readonly manual: readonly string[] }
export interface PersonalMeetingCheckpointCodecV1 { read(value: string): PersonalMeetingCheckpointV1; write(value: PersonalMeetingCheckpointV1): string }
function denied(): never { throw new AuthorityOperationError('unauthorized', 'Personal meeting access is unavailable'); }

/**
 * Personal configuration and progress use the existing Authority admission/cursor owner.
 * A project chosen on import or watch is never part of the source. It becomes a per-meeting
 * suggestion: the review offers it, and its current members may read the meeting's imported notes.
 */
export class SqlitePersonMeetingIntakeV1 {
  constructor(private readonly db: Database.Database, private readonly cursor: PersonalMeetingCheckpointCodecV1) {}
  currentPerson(person: MeetingIntakePersonV1, project: string | null = null) {
    const membership = this.db.prepare("SELECT membership_type FROM authority_memberships WHERE organization_id=? AND principal_id=? AND membership_id=? AND status='active'").get(person.organization_id, person.principal_id, person.membership_id) as { membership_type: 'owner' | 'employee' } | undefined;
    if (!membership) denied();
    const grant = project === null ? null : this.db.prepare(`SELECT m.* FROM authority_project_memberships_v1 m JOIN authority_projects_v1 p ON p.project_id=m.project_id AND p.organization_id=m.organization_id
      WHERE m.organization_id=? AND m.principal_id=? AND m.membership_id=? AND m.project_id=? AND m.status='active' AND p.status='active'`).get(person.organization_id, person.principal_id, person.membership_id, project);
    if (project !== null && !grant) denied();
    return { membership_type: membership.membership_type, grant_sha256: canonicalSha256({ person, membership, grant }) };
  }
  list(person?: MeetingIntakePersonV1): readonly MeetingIntakeSettingV1[] {
    if (person) this.currentPerson(person);
    return this.db.prepare(`SELECT s.*,a.organization_id,a.principal_id,a.membership_id,a.source_adapter_id,a.source_adapter_version,a.source_adapter_instance_id
      FROM authority_person_meeting_sources_v2 s JOIN authority_live_source_admission_v2 a ON a.source_key=s.source_key
      ${person ? 'WHERE s.person_key=?' : ''} ORDER BY s.source_key`).all(...(person ? [canonicalSha256(person)] : [])) as MeetingIntakeSettingV1[];
  }
  requireCurrent(setting: MeetingIntakeSettingV1): void {
    this.currentPerson(setting);
    const row = this.db.prepare('SELECT settings_revision,folder_id FROM authority_person_meeting_sources_v2 WHERE source_key=?').get(setting.source_key) as { settings_revision: number; folder_id: string | null } | undefined;
    if (!row || row.settings_revision !== setting.settings_revision || row.folder_id !== setting.folder_id) throw new AuthorityOperationError('stale_access_state', 'Meeting intake settings changed');
  }
  ensure(input: { readonly person: MeetingIntakePersonV1; readonly identity: SourceAdapterIdentityV1;
    readonly normalizer_version: string; readonly custodian: unknown; readonly processor: AdmittedMeetingProcessingCommitmentsV1['processor']; readonly current: () => void;
    /** How the custodian was established; a person's own OAuth account unless the provider says otherwise. */
    readonly custodian_assurance?: string }): MeetingIntakeSettingV1 {
    return this.db.transaction(() => {
      input.current();
      const { person, identity, processor } = input;
      const member = this.currentPerson(person);
      const source_key = `pms_${canonicalSha256({ person, identity }).slice(7)}`;
      const old = this.list(person).find(row => row.source_key === source_key);
      if (old) return old;
      const now = new Date().toISOString();
      const initial = this.cursor.write({ folder: null, baseline: false, revisions: {}, manual: [] });
      const semantic = canonicalSha256({ source_key, person, identity, processor, custodian: input.custodian, normalizer_version: input.normalizer_version });
      this.db.prepare(`INSERT INTO authority_live_source_admission_v2(source_key,organization_id,principal_id,membership_id,membership_type,
        source_adapter_id,source_adapter_version,source_adapter_instance_id,normalizer_version,source_custodian_sha256,source_custodian_assurance,source_custodian_observed_at,
        source_credential_reference_sha256,initial_cursor,cutoff_at,processor_adapter_id,processor_adapter_version,processor_instance_id,processor_configuration_sha256,processor_credential_reference_sha256,semantic_input_sha256,admitted_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(source_key, person.organization_id, person.principal_id, person.membership_id, member.membership_type,
        identity.adapter_id, identity.version, identity.instance_id, input.normalizer_version, canonicalSha256(input.custodian), input.custodian_assurance ?? 'personal_oauth_email_workspace', now,
        canonicalSha256({ person, tool: identity.adapter_id }), initial, now, processor.adapter_id, processor.version, processor.instance_id, processor.configuration_sha256, processor.credential_reference_sha256, semantic, now);
      this.db.prepare('INSERT INTO authority_live_source_progress_v2 VALUES(?,?,?,0,?)').run(source_key, semantic, initial, now);
      this.db.prepare('INSERT INTO authority_person_meeting_sources_v2(source_key,person_key,folder_id,folder_project_id,settings_revision) VALUES(?,?,NULL,NULL,0)').run(source_key, canonicalSha256(person));
      input.current(); return this.list(person).find(row => row.source_key === source_key)!;
    }).immediate();
  }
  checkpoint(sourceKey: string): PersonalMeetingCheckpointV1 {
    const row = this.db.prepare('SELECT cursor FROM authority_live_source_progress_v2 WHERE source_key=?').get(sourceKey) as { cursor: string } | undefined;
    if (!row) denied(); return this.cursor.read(row.cursor);
  }
  private write(sourceKey: string, checkpoint: PersonalMeetingCheckpointV1): void {
    const next = this.cursor.write(checkpoint);
    this.db.prepare('UPDATE authority_live_source_progress_v2 SET cursor=?,cursor_version=cursor_version+1,updated_at=? WHERE source_key=? AND cursor!=?').run(next, new Date().toISOString(), sourceKey, next);
  }
  /** Sorted project ids suggested for one meeting by its imports and folder deliveries. */
  suggestions(sourceKey: string, externalId: string): readonly string[] {
    return this.db.prepare('SELECT project_id FROM authority_person_meeting_suggestions_v1 WHERE source_key=? AND external_id=? ORDER BY project_id')
      .pluck().all(sourceKey, externalId) as string[];
  }
  /** A watch names the project it suggests; stopping (`folder` null) needs no project access. */
  watch(setting: MeetingIntakeSettingV1, folder: string | null, folderProjectId: string | null, current: () => void): void {
    if ((folder === null) !== (folderProjectId === null)) throw new AuthorityOperationError('invalid_request', 'A watched folder needs a project');
    this.db.transaction(() => {
      current();
      if (folder === null) this.currentPerson(setting); else { this.requireCurrent(setting); this.currentPerson(setting, folderProjectId); }
      for (const old of this.list({ organization_id: setting.organization_id, principal_id: setting.principal_id, membership_id: setting.membership_id })) {
        if (old.folder_id === null && old.source_key !== setting.source_key) continue;
        const selected = old.source_key === setting.source_key ? folder : null;
        this.db.prepare('UPDATE authority_person_meeting_sources_v2 SET folder_id=NULL,folder_project_id=NULL,settings_revision=settings_revision+1 WHERE source_key=?').run(old.source_key);
        this.write(old.source_key, { folder: selected, baseline: false, revisions: {}, manual: this.checkpoint(old.source_key).manual });
      }
      // Clear the former watch first so the unique personal watch constraint also holds while moving it between tool accounts.
      if (folder !== null) this.db.prepare('UPDATE authority_person_meeting_sources_v2 SET folder_id=?,folder_project_id=?,settings_revision=settings_revision+1 WHERE source_key=?').run(folder, folderProjectId, setting.source_key);
      current();
    }).immediate();
  }
  /** Cancelling a queued import also forgets the projects it was saved to. */
  cancelImport(setting: MeetingIntakeSettingV1, meetingId: string, current: () => void): void {
    this.db.transaction(() => {
      current(); this.currentPerson(setting);
      const checkpoint = this.checkpoint(setting.source_key);
      this.write(setting.source_key, { ...checkpoint, manual: checkpoint.manual.filter(id => id !== meetingId) });
      this.db.prepare('DELETE FROM authority_person_meeting_pending_suggestions_v1 WHERE source_key=? AND external_id=?').run(setting.source_key, meetingId);
      current();
    }).immediate();
  }
  /**
   * Queues one meeting. A project is checked for the person's active membership and held as a pending
   * choice; it becomes a suggestion only when the processing cursor advance consumes the queued import.
   */
  enqueue(setting: MeetingIntakeSettingV1, meetingId: string, projectId: string | null, current: () => void): void {
    this.db.transaction(() => {
      current(); this.requireCurrent(setting);
      const old = this.checkpoint(setting.source_key);
      // Pending choices exist only while their import is queued; any left from an import the queue dropped are stale.
      if (!old.manual.includes(meetingId)) this.db.prepare('DELETE FROM authority_person_meeting_pending_suggestions_v1 WHERE source_key=? AND external_id=?').run(setting.source_key, meetingId);
      if (projectId !== null) {
        this.currentPerson(setting, projectId);
        this.db.prepare(`INSERT INTO authority_person_meeting_pending_suggestions_v1(source_key,external_id,project_id,created_at) VALUES (?,?,?,?)
          ON CONFLICT(source_key,external_id,project_id) DO NOTHING`).run(setting.source_key, meetingId, projectId, new Date().toISOString());
      }
      this.write(setting.source_key, { ...old, manual: [...new Set([...old.manual, meetingId])] });
      current();
    }).immediate();
  }
  /**
   * Called inside the transaction that admits a meeting. A meeting the watched folder delivers (not a
   * queued import) keeps the folder's current project as its suggestion, so it stays readable by that
   * project's members after the watch moves; the person must still be an active member, as on import.
   * A queued import's projects wait for the cursor advance that consumes it (`promoteConsumedImports`).
   */
  recordAdmission(setting: MeetingIntakeSettingV1, externalId: string): void {
    this.requireCurrent(setting);
    if (setting.folder_project_id === null || this.checkpoint(setting.source_key).manual.includes(externalId)) return;
    this.currentPerson(setting, setting.folder_project_id);
    this.suggest(setting, externalId, setting.folder_project_id);
  }
  /**
   * Called inside the processing cursor-advance transaction, after its compare-and-set succeeded. Each
   * import the advance drops from the queue has been processed: its pending projects become suggestions,
   * except any project the person has since left. A cancelled import changed the cursor first, so its
   * advance never succeeds and its (already deleted) pending projects are never recorded.
   */
  promoteConsumedImports(setting: MeetingIntakeSettingV1, expectedCursor: string, nextCursor: string): void {
    const next = new Set(this.cursor.read(nextCursor).manual);
    for (const externalId of this.cursor.read(expectedCursor).manual.filter(id => !next.has(id))) {
      const pending = this.db.prepare('SELECT project_id FROM authority_person_meeting_pending_suggestions_v1 WHERE source_key=? AND external_id=? ORDER BY project_id')
        .pluck().all(setting.source_key, externalId) as string[];
      for (const projectId of pending) {
        if (this.isMember(setting, projectId)) this.suggest(setting, externalId, projectId);
      }
      this.db.prepare('DELETE FROM authority_person_meeting_pending_suggestions_v1 WHERE source_key=? AND external_id=?').run(setting.source_key, externalId);
    }
  }
  private isMember(person: MeetingIntakePersonV1, projectId: string): boolean {
    try { this.currentPerson(person, projectId); return true; }
    catch (error) { if (error instanceof AuthorityOperationError && error.code === 'unauthorized') return false; throw error; }
  }
  private suggest(setting: MeetingIntakeSettingV1, externalId: string, projectId: string): void {
    this.db.prepare(`INSERT INTO authority_person_meeting_suggestions_v1(source_key,external_id,project_id,created_at) VALUES (?,?,?,?)
      ON CONFLICT(source_key,external_id,project_id) DO NOTHING`).run(setting.source_key, externalId, projectId, new Date().toISOString());
  }
}
