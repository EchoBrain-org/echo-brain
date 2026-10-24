import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { createGranolaMcpV1, type GranolaMeetingV1 } from '../src/granola-mcp-v1.js';
import { GRANOLA_PERSONAL_CHECKPOINT_CODEC_V1, GranolaWatchSourceV1, granolaWatchInitialCursorV1, granolaWatchWindowV1, readGranolaCheckpointV1, writeGranolaCheckpointV1,
  type GranolaWatchReadSessionV1, type GranolaWatchV1 } from '../src/granola-watch-source-v1.js';

const folderId = '00000000-0000-4000-8000-000000000001';
const [a, b, c, d] = ['00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000d1'];
const identity = { kind: 'meeting-source' as const, adapter_id: 'granola-person-mcp', instance_id: 'granola-person', version: '1.0.0' };
const MINE: GranolaWatchV1 = { watch: 'mine', folder_id: null };
const NOW = Date.parse('2026-10-24T18:00:00.000Z');
const ago = (minutes: number, from = NOW) => new Date(from - minutes * 60_000).toISOString();
const binding = { organization_id: 'org', principal_id: 'person', membership_id: 'member', tool_id: 'granola', external_scope_id: folderId, external_subject_id: 'fixture@example.test', read_grant_sha256: canonicalSha256({ grant: 1 }) };
/** What Granola's own detail read raises when it answers with `answer`, or with a bare HTTP status. */
function granolaFailure(answer: string | number): Promise<unknown> {
  const fetch = vi.fn(async (_url: string, init: RequestInit) => typeof answer === 'number' ? new Response('', { status: answer })
    : Response.json({ jsonrpc: '2.0', id: JSON.parse(init.body as string).id, result: { content: [{ type: 'text', text: answer }] } }));
  return createGranolaMcpV1({ binding, fetch }).meeting(a).then(() => { throw new Error('expected a failure'); }, (error: unknown) => error);
}

function fixture() {
  let now = NOW, active = true, duringRead: (() => void) | undefined;
  // The window as Granola lists it, newest first, each meeting's summary, and the reads that fail.
  let listed: GranolaMeetingV1[] = [];
  const summaries = new Map<string, string>(), failures = new Map<string, unknown>(), reads: string[] = [], windows: unknown[] = [];
  const row = (id: string, updated_at?: string): GranolaMeetingV1 => ({ id, title: 'Fixture', date: 'Oct 24, 2026 9:00 AM PDT', url: `https://notes.granola.ai/d/${id}`,
    known_participants: '', ...(updated_at === undefined ? {} : { updated_at }) });
  const current = () => { if (!active) throw new Error('revoked'); };
  const session: GranolaWatchReadSessionV1 = {
    identity, current, async verify() { current(); },
    async window(input) { current(); windows.push(input); return listed; },
    api: {
      meeting: async (id: string) => {
        reads.push(id); duringRead?.();
        if (failures.has(id)) throw failures.get(id);
        return { ...row(id), summary: summaries.get(id) ?? 'Decided to ship.' };
      },
      transcript: async () => ({ text: 'Fixture transcript', created_at: '2026-10-24T16:00:00.000Z' }),
    },
  };
  const source = (watch: GranolaWatchV1 = MINE) => new GranolaWatchSourceV1(identity, watch, async () => session, current, () => now);
  return { source, row, reads, windows, summaries,
    list: (...rows: GranolaMeetingV1[]) => { listed = rows; },
    edit: (id: string, summary: string) => { summaries.set(id, summary); },
    fail: (id: string, error: unknown) => { failures.set(id, error); }, readable: (id: string) => { failures.delete(id); },
    later: (minutes: number) => { now += minutes * 60_000; },
    revoke: () => { active = false; }, duringRead: (fn: () => void) => { duringRead = fn; } };
}
const ids = (pulled: { readonly meetings: readonly { readonly provenance: { readonly external_id: string } }[] }) => pulled.meetings.map(meeting => meeting.provenance.external_id);

describe('Granola watch over a rolling window, through the shared source cursor', () => {
  it('records the window on its first pass without importing, then imports new and edited meetings one per pull, oldest first', async () => {
    const f = fixture(), source = f.source();
    f.list(f.row(a, ago(60)));
    const baseline = await source.pull({ cursor: granolaWatchInitialCursorV1(MINE) });
    expect(baseline.meetings).toEqual([]);
    expect(f.windows).toEqual([{ mode: 'mine', folder: null, from_date: '2026-10-17', to_date: '2026-10-25' }]);
    expect(readGranolaCheckpointV1(baseline.next_cursor!)).toEqual({ mode: 'mine', folder: null, baseline: true, since: null, seen: { [a]: ago(60) }, manual: [] });
    // The list's updated_at is enough: nothing was read in detail, and no meeting text is in the cursor.
    expect(f.reads).toEqual([]); expect(baseline.next_cursor).not.toContain('Decided');
    expect(await source.pull({ cursor: baseline.next_cursor })).toEqual({ meetings: [], next_cursor: baseline.next_cursor });
    f.list(f.row(b, ago(20)), f.row(c, ago(30)), f.row(a, ago(60)));
    const first = await source.pull({ cursor: baseline.next_cursor });
    expect(ids(first)).toEqual([c]);
    // Before the cursor advances, a restarted worker offers the identical revision again.
    expect((await f.source().pull({ cursor: baseline.next_cursor })).meetings[0]!.provenance.canonical_revision).toBe(first.meetings[0]!.provenance.canonical_revision);
    const second = await source.pull({ cursor: first.next_cursor });
    expect(ids(second)).toEqual([b]);
    expect((await source.pull({ cursor: second.next_cursor })).meetings).toEqual([]);
    f.edit(a, 'Decided to wait.'); f.list(f.row(b, ago(20)), f.row(c, ago(30)), f.row(a, ago(15)));
    const edited = await source.pull({ cursor: second.next_cursor });
    expect(ids(edited)).toEqual([a]);
    expect(readGranolaCheckpointV1(edited.next_cursor!).seen).toEqual({ [a]: ago(15), [b]: ago(20), [c]: ago(30) });
  });
  it('leaves a meeting still being written for a later pull', async () => {
    const f = fixture(), source = f.source();
    const baseline = await source.pull({});
    f.list(f.row(b, ago(5)));
    const early = await source.pull({ cursor: baseline.next_cursor });
    expect(early).toEqual({ meetings: [], next_cursor: baseline.next_cursor });
    f.later(4);
    expect((await source.pull({ cursor: baseline.next_cursor })).meetings).toEqual([]);
    f.later(1);
    expect(ids(await source.pull({ cursor: baseline.next_cursor }))).toEqual([b]);
  });
  it('compares the content of a meeting Granola gives no updated_at, which counts as settled', async () => {
    const f = fixture(), source = f.source();
    f.list(f.row(d));
    const baseline = await source.pull({});
    expect(f.reads).toEqual([d]);
    expect(readGranolaCheckpointV1(baseline.next_cursor!).seen[d]).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(await source.pull({ cursor: baseline.next_cursor })).toEqual({ meetings: [], next_cursor: baseline.next_cursor });
    f.edit(d, 'Decided to wait.');
    expect(ids(await source.pull({ cursor: baseline.next_cursor }))).toEqual([d]);
  });
  it('forgets a meeting that leaves the window and takes it as new when it returns', async () => {
    const f = fixture(), source = f.source();
    f.list(f.row(a, ago(60)));
    const baseline = await source.pull({});
    f.list();
    const left = await source.pull({ cursor: baseline.next_cursor });
    expect(left.meetings).toEqual([]); expect(readGranolaCheckpointV1(left.next_cursor!).seen).toEqual({});
    f.list(f.row(a, ago(60)));
    expect(ids(await source.pull({ cursor: left.next_cursor }))).toEqual([a]);
  });
  it('takes queued imports first, whatever the watch, and lists nothing while the watch is off', async () => {
    const f = fixture(), off = f.source({ watch: 'off', folder_id: null });
    const queued = writeGranolaCheckpointV1({ mode: 'off', folder: null, baseline: false, since: null, seen: {}, manual: [d, a] });
    const pulled = await off.pull({ cursor: queued });
    expect(ids(pulled)).toEqual([d]);
    expect(readGranolaCheckpointV1(pulled.next_cursor!).manual).toEqual([a]);
    expect(await off.pull({ cursor: granolaWatchInitialCursorV1() })).toEqual({ meetings: [] });
    expect(f.windows).toEqual([]);
  });
  it('watches one folder, and refuses a cursor written for another watch', async () => {
    const f = fixture(), watch: GranolaWatchV1 = { watch: 'folder', folder_id: folderId };
    await f.source(watch).pull({});
    expect(f.windows).toEqual([{ mode: 'folder', folder: folderId, from_date: '2026-10-17', to_date: '2026-10-25' }]);
    await expect(f.source(watch).pull({ cursor: granolaWatchInitialCursorV1(MINE) })).rejects.toMatchObject({ code: 'stale_access_state' });
    await expect(f.source().pull({ cursor: granolaWatchInitialCursorV1(watch) })).rejects.toMatchObject({ code: 'stale_access_state' });
    expect(() => f.source({ watch: 'folder', folder_id: null })).toThrow();
  });
  it('refuses revocation before custody commits, including during a detail read', async () => {
    const f = fixture(), source = f.source();
    await source.pull({}); source.requireCurrent();
    f.revoke(); expect(() => source.requireCurrent()).toThrow('revoked');
    await expect(source.pull({})).rejects.toThrow('revoked');
    const g = fixture();
    g.list(g.row(d)); g.duringRead(g.revoke);
    await expect(g.source().pull({})).rejects.toThrow('revoked');
  });
  it('passes over a meeting Granola cannot give at its listed version, and imports the next one in the same pull', async () => {
    for (const failure of [await granolaFailure('<meetings_data count="2"></meetings_data>'), await granolaFailure('<meetings_data count="0" />')]) {
      const f = fixture(), source = f.source();
      const baseline = await source.pull({});
      f.list(f.row(b, ago(20)), f.row(c, ago(30))); f.fail(c, failure);
      const pulled = await source.pull({ cursor: baseline.next_cursor });
      expect(ids(pulled)).toEqual([b]);
      expect(f.reads).toEqual([c, b]);
      expect(readGranolaCheckpointV1(pulled.next_cursor!).seen).toEqual({ [b]: ago(20), [c]: ago(30) });
      // Recorded at that version: it is not read again until Granola lists an edit.
      expect(await source.pull({ cursor: pulled.next_cursor })).toEqual({ meetings: [], next_cursor: pulled.next_cursor });
      expect(f.reads).toEqual([c, b]);
      f.readable(c); f.list(f.row(b, ago(20)), f.row(c, ago(15)));
      expect(ids(await source.pull({ cursor: pulled.next_cursor }))).toEqual([c]);
    }
  });
  it('fails the pull on an outage, a rate limit or a revocation, so the same meeting is tried again', async () => {
    for (const failure of [await granolaFailure(503), await granolaFailure(429), new Error('revoked')]) {
      const f = fixture(), source = f.source();
      const baseline = await source.pull({});
      f.list(f.row(b, ago(20)), f.row(c, ago(30))); f.fail(c, failure);
      await expect(source.pull({ cursor: baseline.next_cursor })).rejects.toBe(failure);
      expect(f.reads).toEqual([c]);
      f.readable(c);
      expect(ids(await source.pull({ cursor: baseline.next_cursor }))).toEqual([c]);
    }
  });
  it('passes over at most five unreadable meetings in one pull, and the next pull goes on from there', async () => {
    const f = fixture(), source = f.source(), unusable = await granolaFailure('<meetings_data count="2"></meetings_data>');
    const meetings = Array.from({ length: 7 }, (_, index) => `00000000-0000-4000-8000-0000000002${String(index).padStart(2, '0')}`);
    const baseline = await source.pull({});
    // Oldest first: the first six cannot be read.
    f.list(...meetings.map((meeting, index) => f.row(meeting, ago(100 - index))).reverse());
    for (const meeting of meetings.slice(0, 6)) f.fail(meeting, unusable);
    const first = await source.pull({ cursor: baseline.next_cursor });
    expect(first.meetings).toEqual([]);
    expect(f.reads).toEqual(meetings.slice(0, 5));
    expect(Object.keys(readGranolaCheckpointV1(first.next_cursor!).seen)).toEqual(meetings.slice(0, 5));
    const second = await source.pull({ cursor: first.next_cursor });
    expect(ids(second)).toEqual([meetings[6]]);
    expect(f.reads).toEqual(meetings);
  });
  it('records a meeting without updated_at that cannot be read, reads it each pull, and imports it once it reads', async () => {
    const f = fixture(), source = f.source();
    f.list(f.row(d)); f.fail(d, await granolaFailure('<meetings_data count="2"></meetings_data>'));
    const baseline = await source.pull({});
    expect(readGranolaCheckpointV1(baseline.next_cursor!).seen).toEqual({ [d]: `sha256:${'0'.repeat(64)}` });
    expect(await source.pull({ cursor: baseline.next_cursor })).toEqual({ meetings: [], next_cursor: baseline.next_cursor });
    expect(f.reads).toEqual([d, d]);
    f.readable(d);
    expect(ids(await source.pull({ cursor: baseline.next_cursor }))).toEqual([d]);
  });
  it('keeps a queued import that cannot be read queued: a failed read is not deletion evidence', async () => {
    const f = fixture(), off = f.source({ watch: 'off', folder_id: null }), unusable = await granolaFailure('<meetings_data count="2"></meetings_data>');
    f.fail(d, unusable);
    await expect(off.pull({ cursor: writeGranolaCheckpointV1({ mode: 'off', folder: null, baseline: false, since: null, seen: {}, manual: [d, a] }) })).rejects.toBe(unusable);
  });
  it('records on its first pass only what is older than the watch change, so a meeting finished since is imported', async () => {
    const f = fixture(), source = f.source();
    // Saved 30 minutes ago: b finished after Save, c at that instant, and a before it.
    const saved = writeGranolaCheckpointV1(GRANOLA_PERSONAL_CHECKPOINT_CODEC_V1.watch(readGranolaCheckpointV1(granolaWatchInitialCursorV1()), MINE, ago(30)));
    f.list(f.row(b, ago(20)), f.row(c, ago(30)), f.row(a, ago(60)));
    const baseline = await source.pull({ cursor: saved });
    expect(baseline.meetings).toEqual([]);
    expect(readGranolaCheckpointV1(baseline.next_cursor!)).toEqual({ mode: 'mine', folder: null, baseline: true, since: ago(30), seen: { [a]: ago(60) }, manual: [] });
    const first = await source.pull({ cursor: baseline.next_cursor });
    expect(ids(first)).toEqual([c]);
    const second = await source.pull({ cursor: first.next_cursor });
    expect(ids(second)).toEqual([b]);
    expect(readGranolaCheckpointV1(second.next_cursor!)).toMatchObject({ since: ago(30), seen: { [a]: ago(60), [b]: ago(20), [c]: ago(30) } });
    expect((await source.pull({ cursor: second.next_cursor })).meetings).toEqual([]);
  });
  it('compares updated_at as an instant, so a time-zone change is no edit, and an unreadable one counts as missing', async () => {
    const f = fixture(), source = f.source();
    f.list(f.row(a, '2026-10-24T10:00:00.000-07:00'), f.row(d, '2026-10-24 10:00'));
    const baseline = await source.pull({});
    const seen = readGranolaCheckpointV1(baseline.next_cursor!).seen;
    expect(seen[a]).toBe('2026-10-24T17:00:00.000Z');
    // Without a readable updated_at, d was read and is compared by its content.
    expect(seen[d]).toMatch(/^sha256:[a-f0-9]{64}$/); expect(f.reads).toEqual([d]);
    f.list(f.row(a, '2026-10-24T13:00:00-04:00'), f.row(d, '2026-10-24 10:00'));
    expect(await source.pull({ cursor: baseline.next_cursor })).toEqual({ meetings: [], next_cursor: baseline.next_cursor });
    expect(f.reads).toEqual([d, d]);
    f.edit(d, 'Decided to wait.');
    expect(ids(await source.pull({ cursor: baseline.next_cursor }))).toEqual([d]);
  });
  it('restarts change detection on a watch change and keeps a full checkpoint within the cursor column', () => {
    const seen = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, canonicalSha256({ index })]));
    const manual = Array.from({ length: 50 }, (_, index) => `00000000-0000-4000-9000-${String(index).padStart(12, '0')}`);
    const full = writeGranolaCheckpointV1({ mode: 'folder', folder: folderId, baseline: true, since: ago(600), seen, manual });
    expect(full.length).toBeLessThanOrEqual(65_536);
    // The change is stamped, so the first pass after it can tell what changed since.
    const moved = GRANOLA_PERSONAL_CHECKPOINT_CODEC_V1.watch(readGranolaCheckpointV1(full), MINE, ago(1));
    expect(moved).toEqual({ mode: 'mine', folder: null, baseline: false, since: ago(1), seen: {}, manual });
    expect(GRANOLA_PERSONAL_CHECKPOINT_CODEC_V1.ready(moved)).toBe(false);
    expect(GRANOLA_PERSONAL_CHECKPOINT_CODEC_V1.ready(readGranolaCheckpointV1(full))).toBe(true);
    expect(granolaWatchWindowV1(NOW)).toEqual({ from_date: '2026-10-17', to_date: '2026-10-25' });
    for (const invalid of [
      { mode: 'folder', folder: folderId, baseline: true, since: null, seen: { ...seen, [d]: canonicalSha256('one more') }, manual: [] },
      { mode: 'off', folder: null, baseline: true, since: null, seen: {}, manual: [] },
      { mode: 'folder', folder: null, baseline: false, since: null, seen: {}, manual: [] },
      { mode: 'mine', folder: folderId, baseline: false, since: null, seen: {}, manual: [] },
      { mode: 'mine', folder: null, baseline: false, since: null, seen: { [a]: ago(5) }, manual: [] },
      { mode: 'mine', folder: null, baseline: true, since: null, seen: { [a]: 'Oct 24' }, manual: [] },
      // Marks and the stamp are UTC instants, never Granola's own offsets.
      { mode: 'mine', folder: null, baseline: true, since: null, seen: { [a]: '2026-10-24T11:00:00.000-07:00' }, manual: [] },
      { mode: 'mine', folder: null, baseline: false, since: '2026-10-24T18:00:00Z', seen: {}, manual: [] },
      { mode: 'mine', folder: null, baseline: false, seen: {}, manual: [] },
      { mode: 'all', folder: null, baseline: false, since: null, seen: {}, manual: [] },
    ]) expect(() => writeGranolaCheckpointV1(invalid as never)).toThrow();
  });
});
