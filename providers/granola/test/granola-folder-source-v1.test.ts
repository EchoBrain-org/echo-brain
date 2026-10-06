import { describe, expect, it } from 'vitest';
import { GranolaFolderSourceV1, granolaFolderInitialCursorV1, type GranolaFolderReadSessionV1 } from '../src/granola-folder-source-v1.js';

const folderId = '00000000-0000-4000-8000-000000000001';
const first = '00000000-0000-4000-8000-000000000002';
const moved = '00000000-0000-4000-8000-000000000003';
const identity = { kind: 'meeting-source' as const, adapter_id: 'granola-person-mcp', instance_id: 'granola-person', version: '1.0.0' };
function fixture() {
  let members = [first]; let active = true; let summary = 'Decided to ship.'; let reads = 0; let duringTranscript: (() => void) | undefined;
  const item = (id: string) => ({ id, title: 'Fixture', date: 'Oct 6, 2026', url: `https://notes.granola.ai/d/${id}`, known_participants: '', summary });
  const current = () => { if (!active) throw new Error('revoked'); };
  const session: GranolaFolderReadSessionV1 = {
    identity, current, async verify() { current(); },
    folder: async () => { current(); return { folder: { id: folderId, note_count: members.length }, meetings: members.map(item) }; },
    api: { meeting: async (id: string) => item(id), details: async (ids: readonly string[]) => ids.map(item), transcript: async () => { reads++; duringTranscript?.(); return { text: 'Fixture transcript', created_at: '2026-10-06T00:00:00.000Z' }; } },
  };
  const source = () => new GranolaFolderSourceV1(identity, folderId, async () => session, current);
  return { source, session, duringTranscript: (fn: () => void) => { duringTranscript = fn; }, setMembers: (value: string[]) => { members = value; }, edit: () => { summary = 'Decided to wait.'; }, revoke: () => { active = false; }, reads: () => reads };
}
describe('Granola folder reconciliation through the shared source cursor', () => {
  it('baselines historical items without retention, detects entries and edits, and resumes without duplicates', async () => {
    const f = fixture(); let source = f.source();
    const baseline = await source.pull({ cursor: granolaFolderInitialCursorV1(folderId) });
    expect(baseline.meetings).toEqual([]); expect(baseline.next_cursor).not.toContain('Fixture transcript');
    expect((await source.pull({ cursor: baseline.next_cursor })).meetings).toEqual([]);
    f.setMembers([first, moved]);
    const entry = await source.pull({ cursor: baseline.next_cursor });
    expect(entry.meetings.map(item => item.provenance.external_id)).toEqual([moved]);
    // Before durable advancement, a restarted worker reoffers the identical revision.
    source = f.source();
    expect((await source.pull({ cursor: baseline.next_cursor })).meetings[0]!.provenance.canonical_revision).toBe(entry.meetings[0]!.provenance.canonical_revision);
    expect((await source.pull({ cursor: entry.next_cursor })).meetings).toEqual([]);
    f.edit();
    const edited = await source.pull({ cursor: entry.next_cursor });
    expect(edited.meetings.map(item => item.provenance.external_id)).toEqual([first]);
    expect(edited.meetings[0]!.provenance.canonical_revision).not.toBe(entry.meetings[0]!.provenance.canonical_revision);
  });
  it('does not read meetings outside the selected folder, and detects entry of an unchanged baseline meeting after removal', async () => {
    const f = fixture(); const source = f.source();
    const baseline = await source.pull({});
    f.setMembers([]); const removed = await source.pull({ cursor: baseline.next_cursor });
    expect(removed.meetings).toEqual([]); expect(f.reads()).toBe(1);
    f.setMembers([first]); expect((await source.pull({ cursor: removed.next_cursor })).meetings).toHaveLength(1);
  });
  it('refuses membership changes during content reads and revocation before custody commits', async () => {
    const f = fixture(); const source = f.source();
    await source.pull({}); source.requireCurrent();
    f.revoke(); expect(() => source.requireCurrent()).toThrow('revoked');
    await expect(source.pull({})).rejects.toThrow('revoked');
    const g = fixture();
    g.duringTranscript(() => g.setMembers([]));
    await expect(g.source().pull({})).rejects.toMatchObject({ code: 'stale_access_state' });
  });
});
