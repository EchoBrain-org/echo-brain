import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { readGranolaCheckpointV1, writeGranolaCheckpointV1 } from '@echo-brain/provider-granola/granola-folder-source-v1';
import { SqlitePersonMeetingIntakeV1, type MeetingIntakePersonV1 } from '../src/adapters/persistence/sqlite/person-meeting-intake-v1.js';
import { MEMBER, OWNER, PROJECT_ALPHA, PROJECT_BETA, PROJECT_CONTEXT_NOW, projectContextDatabase, revokeMembership } from './fixtures/project-context-sqlite.js';

const FOREIGN = 'prj_33333333-3333-4333-8333-333333333333';
const ARCHIVED = 'prj_44444444-4444-4444-8444-444444444444';
const FOLDER = '00000000-0000-4000-8000-0000000000f1';
const NOTE_1 = '00000000-0000-4000-8000-0000000000a1', NOTE_2 = '00000000-0000-4000-8000-0000000000a2', NOTE_3 = '00000000-0000-4000-8000-0000000000a3';
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
  const intake = new SqlitePersonMeetingIntakeV1(db, { read: readGranolaCheckpointV1, write: writeGranolaCheckpointV1 });
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
  return { db, intake, ensure, count, consume };
}

describe('personal meeting intake: one source per person and tool account', () => {
  it('keys the source by person and tool account only, and re-ensuring returns the same source', () => {
    const w = world();
    const first = w.ensure();
    expect(first.source_key).toBe(`pms_${canonicalSha256({ person: person(OWNER), identity: identity('granola') }).slice(7)}`);
    expect(first).toMatchObject({ folder_id: null, folder_project_id: null, settings_revision: 0 });
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

  it('saves a watch with its folder project, moves it between tool accounts, and stops it', () => {
    const w = world(), granola = w.ensure(), notes = w.ensure('notes');
    expect(() => w.intake.watch(granola, FOLDER, FOREIGN, () => undefined)).toThrow(expect.objectContaining({ code: 'unauthorized' }));
    expect(w.intake.list(person(OWNER)).every(s => s.folder_id === null && s.folder_project_id === null)).toBe(true);
    w.intake.watch(granola, FOLDER, PROJECT_ALPHA, () => undefined);
    const watched = w.intake.list(person(OWNER)).find(s => s.source_key === granola.source_key)!;
    expect(watched).toMatchObject({ folder_id: FOLDER, folder_project_id: PROJECT_ALPHA });
    expect(w.intake.checkpoint(granola.source_key)).toMatchObject({ folder: FOLDER, baseline: false });
    w.intake.watch(notes, FOLDER, PROJECT_BETA, () => undefined);
    const moved = Object.fromEntries(w.intake.list(person(OWNER)).map(s => [s.source_key, s]));
    expect(moved[granola.source_key]).toMatchObject({ folder_id: null, folder_project_id: null });
    expect(moved[notes.source_key]).toMatchObject({ folder_id: FOLDER, folder_project_id: PROJECT_BETA });
    expect(w.intake.checkpoint(granola.source_key).folder).toBeNull();
    w.intake.watch(moved[notes.source_key]!, null, null, () => undefined);
    expect(w.intake.list(person(OWNER)).every(s => s.folder_id === null && s.folder_project_id === null)).toBe(true);
    expect(w.intake.checkpoint(notes.source_key).folder).toBeNull();
    expect(() => w.db.prepare('UPDATE authority_person_meeting_sources_v2 SET folder_id=?,settings_revision=settings_revision+1 WHERE source_key=?').run(FOLDER, granola.source_key)).toThrow('CHECK');
  });

  it('records the watched folder project for meetings the folder delivers, not for queued imports', () => {
    const w = world(), setting = w.ensure();
    w.intake.recordAdmission(setting, NOTE_1);
    expect(w.count('authority_person_meeting_suggestions_v1')).toBe(0);
    w.intake.watch(setting, FOLDER, PROJECT_ALPHA, () => undefined);
    w.intake.enqueue(w.intake.list(person(OWNER))[0]!, NOTE_2, PROJECT_BETA, () => undefined);
    const watched = w.intake.list(person(OWNER))[0]!;
    w.intake.recordAdmission(watched, NOTE_1);
    w.intake.recordAdmission(watched, NOTE_1);
    w.intake.recordAdmission(watched, NOTE_2);
    expect(w.intake.suggestions(setting.source_key, NOTE_1)).toEqual([PROJECT_ALPHA]);
    // A queued import admitted while a folder is watched keeps only its own pending choice.
    expect(w.intake.suggestions(setting.source_key, NOTE_2)).toEqual([]);
    expect(w.count('authority_person_meeting_pending_suggestions_v1')).toBe(1);
    w.db.prepare("UPDATE authority_project_memberships_v1 SET status='revoked',revoked_at=? WHERE project_id=?").run(PROJECT_CONTEXT_NOW, PROJECT_ALPHA);
    expect(() => w.intake.recordAdmission(watched, NOTE_3)).toThrow(expect.objectContaining({ code: 'unauthorized' }));
    expect(w.intake.suggestions(setting.source_key, NOTE_3)).toEqual([]);
  });

  it('checks the person, not a project, before using a stored setting', () => {
    const w = world(), setting = w.ensure();
    w.intake.watch(setting, FOLDER, PROJECT_ALPHA, () => undefined);
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

  it('proposalSuggestions forgets a cancelled import\'s project', () => {
    const w = world(), setting = w.ensure();
    w.intake.enqueue(setting, NOTE_1, PROJECT_ALPHA, () => undefined);
    w.intake.cancelImport(setting, NOTE_1, () => undefined);
    expect(w.intake.proposalSuggestions(setting.source_key, NOTE_1)).toEqual([]);
  });
});
