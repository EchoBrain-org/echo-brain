import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { GRANOLA_PERSONAL_CHECKPOINT_CODEC_V1, readGranolaCheckpointV1, writeGranolaCheckpointV1, type GranolaCheckpointV1 } from '@echo-brain/provider-granola/granola-watch-source-v1';
import { SqlitePersonMeetingIntakeV1, type MeetingIntakePersonV1 } from '../src/adapters/persistence/sqlite/person-meeting-intake-v1.js';
import { MEMBER, OWNER, PROJECT_ALPHA, PROJECT_BETA, PROJECT_CONTEXT_NOW, projectContextDatabase, revokeMembership } from './fixtures/project-context-sqlite.js';

const FOREIGN = 'prj_33333333-3333-4333-8333-333333333333';
const ARCHIVED = 'prj_44444444-4444-4444-8444-444444444444';
const FOLDER = '00000000-0000-4000-8000-0000000000f1';
const NOTE_1 = '00000000-0000-4000-8000-0000000000a1', NOTE_2 = '00000000-0000-4000-8000-0000000000a2', NOTE_3 = '00000000-0000-4000-8000-0000000000a3';
const OFF = { watch: 'off', folder_id: null } as const, MINE = { watch: 'mine', folder_id: null } as const, IN_FOLDER = { watch: 'folder', folder_id: FOLDER } as const;
const opened: Database.Database[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });

const person = (actor: typeof OWNER): MeetingIntakePersonV1 => ({ organization_id: actor.organization_id, principal_id: actor.principal_id, membership_id: actor.membership_id });
const identity = (tool: string, actor = OWNER) => ({ kind: 'meeting-source' as const, adapter_id: `${tool}-person-mcp`, instance_id: `${tool}-${canonicalSha256(person(actor)).slice(7, 31)}`, version: '1.0.0' });

function world() {
  const db = projectContextDatabase(); opened.push(db);
  let membership = 0;
  const project = (project_id: string, members: readonly (typeof OWNER)[], status: 'active' | 'archived' = 'active') => {
    db.prepare('INSERT INTO authority_projects_v1 VALUES (?,?,?,?,?,?,?,?)').run(project_id, OWNER.organization_id, project_id.slice(4, 12), status, PROJECT_CONTEXT_NOW, OWNER.principal_id, OWNER.membership_id, 'owner');
    for (const actor of members) {
      db.prepare("INSERT INTO authority_project_memberships_v1 VALUES (?,?,?,?,?,?,'member','active',?,NULL)")
        .run(`pgm_00000000-0000-4000-8000-${String(++membership).padStart(12, '0')}`, project_id, actor.organization_id, actor.principal_id, actor.membership_id, actor.membership_type, PROJECT_CONTEXT_NOW);
    }
  };
  project(PROJECT_ALPHA, [OWNER]); project(PROJECT_BETA, [OWNER]); project(FOREIGN, [MEMBER]); project(ARCHIVED, [OWNER], 'archived');
  const intake = new SqlitePersonMeetingIntakeV1(db, GRANOLA_PERSONAL_CHECKPOINT_CODEC_V1);
  const ensure = (tool = 'granola', actor = OWNER) => intake.ensure({
    person: person(actor), identity: identity(tool, actor), normalizer_version: '1.0.0', custodian: { tool, actor: actor.membership_id },
    processor: { adapter_id: 'llm', instance_id: `personal-${canonicalSha256(person(actor)).slice(7, 39)}`, version: '1.0.0', configuration_sha256: canonicalSha256('processor'), credential_reference_sha256: canonicalSha256('reference') },
    current: () => undefined,
  });
  const count = (table: string) => db.prepare(`SELECT count(*) FROM ${table}`).pluck().get();
  // Emulates the processing cursor advance that drops `ids` from the queued imports, and its promotion hook.
  const consume = (setting: { readonly source_key: string } & MeetingIntakePersonV1, ids: readonly string[]) => {
    const before = db.prepare('SELECT cursor FROM authority_live_source_progress_v2 WHERE source_key=?').pluck().get(setting.source_key) as string;
    const checkpoint = readGranolaCheckpointV1(before);
    const after = writeGranolaCheckpointV1({ ...checkpoint, manual: checkpoint.manual.filter(id => !ids.includes(id)) });
    db.transaction(() => {
      db.prepare('UPDATE authority_live_source_progress_v2 SET cursor=?,cursor_version=cursor_version+1 WHERE source_key=?').run(after, setting.source_key);
      intake.promoteConsumedImports(stored(setting), before, after);
    })();
  };
  const stored = (setting: { readonly source_key: string }) => intake.list().find(s => s.source_key === setting.source_key)!;
  return { db, intake, ensure, count, consume, stored };
}

describe('personal meeting intake: one source per person and tool account', () => {
  it('keys the source by person and tool account only, and re-ensuring returns the same source', () => {
    const w = world();
    const first = w.ensure();
    expect(first.source_key).toBe(`pms_${canonicalSha256({ person: person(OWNER), identity: identity('granola') }).slice(7)}`);
    expect(first).toMatchObject({ watch: 'off', folder_id: null, suggested_project_id: null, settings_revision: 0 });
    expect(first).not.toHaveProperty('project_id');
    expect(w.ensure().source_key).toBe(first.source_key);
    expect(w.ensure('notes').source_key).not.toBe(first.source_key);
    expect(w.ensure('granola', MEMBER).source_key).not.toBe(first.source_key);
    expect(w.count('authority_person_meeting_sources_v2')).toBe(3);
    expect(w.count('authority_live_source_admission_v2')).toBe(3);
  });

  it('holds import projects as pending until the cursor advance drops the queued import, then records them as sorted suggestions', () => {
    const w = world(), setting = w.ensure();
    const pending = (id: string) => w.db.prepare('SELECT project_id FROM authority_person_meeting_pending_suggestions_v1 WHERE source_key=? AND external_id=? ORDER BY project_id').pluck().all(setting.source_key, id);
    w.intake.enqueue(setting, NOTE_1, PROJECT_BETA, () => undefined);
    w.intake.enqueue(setting, NOTE_1, PROJECT_ALPHA, () => undefined);
    w.intake.enqueue(setting, NOTE_1, PROJECT_BETA, () => undefined);
    w.intake.enqueue(setting, NOTE_2, null, () => undefined);
    expect(pending(NOTE_1)).toEqual([PROJECT_ALPHA, PROJECT_BETA].sort());
    expect(w.count('authority_person_meeting_suggestions_v1')).toBe(0);
    expect(w.intake.checkpoint(setting.source_key).manual).toEqual([NOTE_1, NOTE_2]);
    for (const project of [FOREIGN, ARCHIVED]) {
      expect(() => w.intake.enqueue(setting, NOTE_3, project, () => undefined)).toThrow(expect.objectContaining({ code: 'unauthorized' }));
    }
    expect(pending(NOTE_3)).toEqual([]);
    expect(w.intake.checkpoint(setting.source_key).manual).toEqual([NOTE_1, NOTE_2]);
    // Admission alone does not record an import's projects; the cursor advance that drops the import does.
    w.intake.recordAdmission(w.intake.list(person(OWNER))[0]!, NOTE_1);
    expect(w.count('authority_person_meeting_suggestions_v1')).toBe(0);
    w.consume(setting, [NOTE_1]);
    expect(pending(NOTE_1)).toEqual([]);
    expect(w.intake.suggestions(setting.source_key, NOTE_1)).toEqual([PROJECT_ALPHA, PROJECT_BETA].sort());
    w.consume(setting, [NOTE_2]);
    expect(w.intake.suggestions(setting.source_key, NOTE_2)).toEqual([]);
    expect(w.count('authority_person_meeting_pending_suggestions_v1')).toBe(0);
  });

  it('drops pending import projects on cancel, on a fresh re-import, and for a project the person has left', () => {
    const w = world(), setting = w.ensure();
    w.intake.enqueue(setting, NOTE_1, PROJECT_ALPHA, () => undefined);
    w.intake.cancelImport(setting, NOTE_1, () => undefined);
    expect(w.count('authority_person_meeting_pending_suggestions_v1')).toBe(0);
    expect(w.intake.proposalSuggestions(setting.source_key, NOTE_1)).toEqual([]);
    w.intake.enqueue(setting, NOTE_1, null, () => undefined);
    w.consume(setting, [NOTE_1]);
    expect(w.intake.suggestions(setting.source_key, NOTE_1)).toEqual([]);
    // A pending row left behind by a queue that dropped its import without admitting it is stale.
    w.db.prepare('INSERT INTO authority_person_meeting_pending_suggestions_v1 VALUES (?,?,?,?)').run(setting.source_key, NOTE_2, PROJECT_ALPHA, PROJECT_CONTEXT_NOW);
    w.intake.enqueue(setting, NOTE_2, null, () => undefined);
    expect(w.count('authority_person_meeting_pending_suggestions_v1')).toBe(0);
    w.intake.enqueue(setting, NOTE_3, PROJECT_BETA, () => undefined);
    w.db.prepare("UPDATE authority_project_memberships_v1 SET status='revoked',revoked_at=? WHERE project_id=?").run(PROJECT_CONTEXT_NOW, PROJECT_BETA);
    w.consume(setting, [NOTE_2, NOTE_3]);
    expect(w.intake.suggestions(setting.source_key, NOTE_3)).toEqual([]);
    expect(w.count('authority_person_meeting_pending_suggestions_v1')).toBe(0);
  });

  it('keeps suggestions insert-only', () => {
    const w = world(), setting = w.ensure();
    w.intake.enqueue(setting, NOTE_1, PROJECT_ALPHA, () => undefined);
    w.consume(setting, [NOTE_1]);
    expect(() => w.db.prepare('UPDATE authority_person_meeting_suggestions_v1 SET project_id=?').run(PROJECT_BETA)).toThrow('immutable');
    expect(() => w.db.prepare('DELETE FROM authority_person_meeting_suggestions_v1').run()).toThrow('deletion is denied');
  });

  it('saves a watch that needs no project, with an optional suggested one, moves it between tool accounts, and stops it', () => {
    const w = world(), granola = w.ensure(), notes = w.ensure('notes');
    const all = () => w.intake.list(person(OWNER)).map(({ watch, folder_id, suggested_project_id }) => ({ watch, folder_id, suggested_project_id }));
    expect(() => w.intake.watch(granola, MINE, FOREIGN, () => undefined)).toThrow(expect.objectContaining({ code: 'unauthorized' }));
    for (const [watch, project] of [[{ watch: 'folder', folder_id: null }, null], [{ watch: 'mine', folder_id: FOLDER }, null], [OFF, PROJECT_ALPHA]] as const) {
      expect(() => w.intake.watch(granola, watch, project, () => undefined)).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    }
    expect(all()).toEqual([{ ...OFF, suggested_project_id: null }, { ...OFF, suggested_project_id: null }]);
    w.intake.watch(granola, MINE, null, () => undefined);
    expect(w.stored(granola)).toMatchObject({ ...MINE, suggested_project_id: null });
    expect(w.intake.checkpoint(granola.source_key)).toMatchObject({ mode: 'mine', folder: null, baseline: false });
    w.intake.watch(w.stored(granola), IN_FOLDER, PROJECT_ALPHA, () => undefined);
    expect(w.stored(granola)).toMatchObject({ ...IN_FOLDER, suggested_project_id: PROJECT_ALPHA });
    expect(w.intake.checkpoint(granola.source_key)).toMatchObject({ mode: 'folder', folder: FOLDER, baseline: false });
    w.intake.watch(notes, MINE, PROJECT_BETA, () => undefined);
    expect(w.stored(granola)).toMatchObject({ ...OFF, suggested_project_id: null });
    expect(w.stored(notes)).toMatchObject({ ...MINE, suggested_project_id: PROJECT_BETA });
    expect(w.intake.checkpoint(granola.source_key)).toMatchObject({ mode: 'off', folder: null });
    w.intake.watch(w.stored(notes), OFF, null, () => undefined);
    expect(all()).toEqual([{ ...OFF, suggested_project_id: null }, { ...OFF, suggested_project_id: null }]);
    expect(w.intake.checkpoint(notes.source_key)).toMatchObject({ mode: 'off', folder: null });
    const update = (sql: string, ...values: unknown[]) => () => w.db.prepare(`UPDATE authority_person_meeting_sources_v2 SET ${sql},settings_revision=settings_revision+1 WHERE source_key=?`).run(...values, granola.source_key);
    expect(update('folder_id=?', FOLDER)).toThrow('CHECK');
    expect(update("watch='folder'")).toThrow('CHECK');
    expect(update('suggested_project_id=?', PROJECT_ALPHA)).toThrow('CHECK');
    expect(update("watch='everything'")).toThrow('CHECK');
    // One watching source per person.
    w.intake.watch(w.stored(notes), MINE, null, () => undefined);
    expect(update("watch='mine'")).toThrow('UNIQUE');
  });

  it('stamps a changed watch, and saving the same watch with another suggestion keeps its change detection', () => {
    const w = world(), setting = w.ensure();
    const checkpoint = () => w.intake.checkpoint(setting.source_key) as GranolaCheckpointV1;
    const before = Date.now();
    w.intake.watch(setting, MINE, null, () => undefined);
    const started = checkpoint();
    expect(started).toEqual({ mode: 'mine', folder: null, baseline: false, since: expect.any(String), seen: {}, manual: [] });
    expect(Date.parse(started.since!)).toBeGreaterThanOrEqual(before);
    // The worker's first pass, emulated: detection is ready with what the window held.
    const ready = { ...started, baseline: true, seen: { [NOTE_1]: '2026-10-24T17:00:00.000Z' } };
    w.db.prepare('UPDATE authority_live_source_progress_v2 SET cursor=?,cursor_version=cursor_version+1 WHERE source_key=?').run(writeGranolaCheckpointV1(ready), setting.source_key);
    const revision = w.stored(setting).settings_revision;
    w.intake.watch(w.stored(setting), MINE, PROJECT_ALPHA, () => undefined);
    expect(w.stored(setting)).toMatchObject({ ...MINE, suggested_project_id: PROJECT_ALPHA, settings_revision: revision + 1 });
    expect(checkpoint()).toEqual(ready);
    // Saving it unchanged writes nothing; dropping the suggestion again changes only the suggestion.
    w.intake.watch(w.stored(setting), MINE, PROJECT_ALPHA, () => undefined);
    expect(w.stored(setting).settings_revision).toBe(revision + 1);
    w.intake.watch(w.stored(setting), MINE, null, () => undefined);
    expect(w.stored(setting)).toMatchObject({ suggested_project_id: null, settings_revision: revision + 2 });
    expect(checkpoint()).toEqual(ready);
    // A setting read before those changes is refused, and the suggestion is still checked for membership.
    expect(() => w.intake.watch(setting, MINE, PROJECT_BETA, () => undefined)).toThrow(expect.objectContaining({ code: 'stale_access_state' }));
    expect(() => w.intake.watch(w.stored(setting), MINE, FOREIGN, () => undefined)).toThrow(expect.objectContaining({ code: 'unauthorized' }));
    // Another folder is another watch: detection starts again from its own stamp.
    w.intake.watch(w.stored(setting), IN_FOLDER, PROJECT_ALPHA, () => undefined);
    expect(checkpoint()).toEqual({ mode: 'folder', folder: FOLDER, baseline: false, since: expect.any(String), seen: {}, manual: [] });
    expect(Date.parse(checkpoint().since!)).toBeGreaterThanOrEqual(Date.parse(started.since!));
  });

  it('records the watch\'s suggested project for the meetings it delivers, not for queued imports, and never stops intake for it', () => {
    const w = world(), setting = w.ensure();
    w.intake.recordAdmission(setting, NOTE_1);
    w.intake.watch(setting, MINE, null, () => undefined);
    w.intake.recordAdmission(w.stored(setting), NOTE_1);
    expect(w.count('authority_person_meeting_suggestions_v1')).toBe(0);
    w.intake.watch(w.stored(setting), IN_FOLDER, PROJECT_ALPHA, () => undefined);
    w.intake.enqueue(w.stored(setting), NOTE_2, PROJECT_BETA, () => undefined);
    const watched = w.stored(setting);
    w.intake.recordAdmission(watched, NOTE_1);
    w.intake.recordAdmission(watched, NOTE_1);
    w.intake.recordAdmission(watched, NOTE_2);
    expect(w.intake.suggestions(setting.source_key, NOTE_1)).toEqual([PROJECT_ALPHA]);
    // A queued import admitted while a watch is on keeps only its own pending choice.
    expect(w.intake.suggestions(setting.source_key, NOTE_2)).toEqual([]);
    expect(w.count('authority_person_meeting_pending_suggestions_v1')).toBe(1);
    // A suggestion grants nothing, so leaving its project drops the suggestion, not the meeting.
    w.db.prepare("UPDATE authority_project_memberships_v1 SET status='revoked',revoked_at=? WHERE project_id=?").run(PROJECT_CONTEXT_NOW, PROJECT_ALPHA);
    expect(() => w.intake.recordAdmission(watched, NOTE_3)).not.toThrow();
    expect(w.intake.suggestions(setting.source_key, NOTE_3)).toEqual([]);
  });

  it('checks the person, not a project, before using a stored setting', () => {
    const w = world(), setting = w.ensure();
    w.intake.watch(setting, IN_FOLDER, PROJECT_ALPHA, () => undefined);
    const watched = w.intake.list(person(OWNER))[0]!;
    w.db.prepare("UPDATE authority_project_memberships_v1 SET status='revoked',revoked_at=? WHERE project_id=?").run(PROJECT_CONTEXT_NOW, PROJECT_ALPHA);
    expect(() => w.intake.requireCurrent(watched)).not.toThrow();
    expect(() => w.intake.requireCurrent(setting)).toThrow(expect.objectContaining({ code: 'stale_access_state' }));
    revokeMembership(w.db, OWNER);
    expect(() => w.intake.requireCurrent(watched)).toThrow(expect.objectContaining({ code: 'unauthorized' }));
  });

  it('proposalSuggestions returns recorded and still-pending member projects, sorted and unique', () => {
    const w = world(), setting = w.ensure();
    w.intake.enqueue(setting, NOTE_1, PROJECT_BETA, () => undefined);
    w.intake.enqueue(setting, NOTE_1, PROJECT_ALPHA, () => undefined);
    expect(w.intake.proposalSuggestions(setting.source_key, NOTE_1)).toEqual([PROJECT_ALPHA, PROJECT_BETA].sort());
    expect(w.intake.suggestions(setting.source_key, NOTE_1)).toEqual([]);
    w.consume(setting, [NOTE_1]);
    expect(w.intake.proposalSuggestions(setting.source_key, NOTE_1)).toEqual([PROJECT_ALPHA, PROJECT_BETA].sort());
    expect(w.count('authority_person_meeting_pending_suggestions_v1')).toBe(0);
    w.intake.enqueue(setting, NOTE_2, PROJECT_ALPHA, () => undefined);
    w.intake.enqueue(setting, NOTE_2, PROJECT_BETA, () => undefined);
    w.db.prepare("UPDATE authority_project_memberships_v1 SET status='revoked',revoked_at=? WHERE project_id=?").run(PROJECT_CONTEXT_NOW, PROJECT_BETA);
    expect(w.intake.proposalSuggestions(setting.source_key, NOTE_2)).toEqual([PROJECT_ALPHA]);
    // A recorded suggestion stays whoever left: the freeze offers it and views filter what the reviewer can read.
    expect(w.intake.proposalSuggestions(setting.source_key, NOTE_1)).toEqual([PROJECT_ALPHA, PROJECT_BETA].sort());
    expect(w.intake.proposalSuggestions(setting.source_key, NOTE_3)).toEqual([]);
  });
});
