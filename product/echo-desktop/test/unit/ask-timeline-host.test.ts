// The Ask timeline on the host (ADR-0047): its file, on a real folder (one per
// account, owner-only, written whole through a temporary file, at most 200
// turns and 90 days, a bad file read as empty, our sign-out deleting it and an
// account change deleting the last one's), and the checks of what the page
// sends with an Ask and a source check before the client sees it.
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A disk that, while `short` is on, takes at most half of what each write gives it, as a write may. Everything else is the real one. */
const { disk } = vi.hoisted(() => ({ disk: { short: false } }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  const writeSync = (descriptor: number, data: string | NodeJS.ArrayBufferView, offset?: number, length?: number) => {
    const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const from = typeof data === 'string' ? 0 : offset ?? 0;
    const asked = typeof data === 'string' ? bytes.length : length ?? bytes.length - from;
    return fs.writeSync(descriptor, bytes, from, disk.short ? Math.ceil(asked / 2) : asked);
  };
  return { ...fs, writeSync: vi.fn(writeSync), fsyncSync: vi.fn(fs.fsyncSync), renameSync: vi.fn(fs.renameSync) };
});
import type { AskPrevious, Expect, TimelineTurn } from '../../src/shared/protocol.js';
import { askArgv, askCheckArgv, askCheckRequest, askPrevious } from '../../src/host/ask.js';
import { deleteOtherTimelines, deleteTimeline, pruneTurns, putTimeline, readTimeline, timelinePath, timelineTurn } from '../../src/host/timeline.js';

const ARI: Expect = { authority: 'https://authority.example', membership_id: 'mem_11111111-1111-4111-8111-111111111111' };
const MINA: Expect = { authority: 'https://authority.example', membership_id: 'mem_22222222-2222-4222-8222-222222222222' };
const NOW = Date.parse('2026-10-25T12:00:00.000Z');
const DAY = 24 * 60 * 60_000;
const sha = (digit: string) => `sha256:${digit.repeat(64)}` as const;
const ticketCitation = { kind: 'ticket', tool_id: 'jira', external_scope_id: 'cloud-1', ticket_id: '20482', permalink: 'https://example.atlassian.net/browse/THERM-482',
  text_sha256: sha('a') } as const;
const cited = { citation: ticketCitation, kind: 'ticket', label: 'THERM-482 · Sensor drift', visibility: 'only_me' } as const;

/** A turn as a put writes it, asked `daysAgo` days before NOW. */
function turn(daysAgo = 0, extra: Partial<TimelineTurn> = {}): TimelineTurn {
  return {
    id: randomUUID(), asked_at: new Date(NOW - daysAgo * DAY).toISOString(), text: 'what is open?', question: 'What is open on THERM?', scope: { kind: 'global' },
    answer: {
      text: 'THERM-482 is open.', scope: { kind: 'global' }, outcome: 'answered',
      sources: [{ kind: 'ticket', tool_id: 'jira', label: 'THERM-482 · Sensor drift', permalink: ticketCitation.permalink, private: true, cited }],
      parts: [{ question: 'What is open on THERM?', status: 'answered', statements: [{ text: 'THERM-482 is open.', citation_indexes: [0], private: true }] }],
    },
    ...extra,
  };
}

let person: string;
beforeEach(() => { person = mkdtempSync(join(tmpdir(), 'echo-person-')); chmodSync(person, 0o700); });
afterEach(() => { rmSync(person, { recursive: true, force: true }); });

const folder = () => join(person, 'ask-timeline-v1');
const mode = (path: string) => statSync(path).mode & 0o777;

describe('the timeline file (C5)', () => {
  it('is one owner-only file per account, by the hash of who it is, in an owner-only folder beside the session', () => {
    const first = turn();
    putTimeline(person, ARI, first, NOW);
    const path = timelinePath(person, ARI);
    expect(path).toBe(join(folder(), `${createHash('sha256').update(`${ARI.authority} ${ARI.membership_id}`).digest('hex')}.json`));
    expect(mode(folder())).toBe(0o700);
    expect(mode(path)).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ schema_version: 1, kind: 'echo-desktop-ask-timeline-v1', turns: [first] });
    // Nothing of the account itself is written down by name, and another account has no file yet.
    expect(readdirSync(folder())).toEqual([path.split('/').at(-1)]);
    expect(readTimeline(person, MINA)).toEqual([]);
    expect(readTimeline(person, ARI)).toEqual([first]);
  });

  it('keeps a new turn at the end and one already kept in its place, writing the file whole and leaving no temporary file', () => {
    const [first, second] = [turn(2), turn(1)];
    putTimeline(person, ARI, first, NOW);
    putTimeline(person, ARI, second, NOW);
    const marked = { ...first, markers: { 0: sha('b') } };
    putTimeline(person, ARI, marked, NOW);
    expect(readTimeline(person, ARI)).toEqual([marked, second]);
    expect(readdirSync(folder()).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('writes every byte however little a write takes, and has the file and its new name on disk before a put returns', () => {
    const [first, second] = [turn(2), turn(1)];
    putTimeline(person, ARI, first, NOW);
    vi.mocked(fsyncSync).mockClear();
    vi.mocked(renameSync).mockClear();
    disk.short = true;
    try {
      putTimeline(person, ARI, second, NOW);
    } finally {
      disk.short = false;
    }
    // The good file is never replaced by part of the next one.
    expect(readTimeline(person, ARI)).toEqual([first, second]);
    // Its bytes before it takes the name, and the folder's new entry after.
    const renamed = vi.mocked(renameSync).mock.invocationCallOrder;
    const synced = vi.mocked(fsyncSync).mock.invocationCallOrder;
    expect(renamed).toHaveLength(1);
    expect(synced.filter(order => order < renamed[0]!)).toHaveLength(1);
    expect(synced.filter(order => order > renamed[0]!)).toHaveLength(1);
  });

  it('keeps at most 200 turns and none older than 90 days, the newest, on every put', () => {
    const old = turn(91);
    putTimeline(person, ARI, old, NOW);
    const recent = turn(89);
    putTimeline(person, ARI, recent, NOW);
    expect(readTimeline(person, ARI)).toEqual([recent]);
    const many = Array.from({ length: 205 }, (_, at) => turn(0, { asked_at: new Date(NOW - (205 - at) * 60_000).toISOString() }));
    expect(pruneTurns(many, NOW)).toEqual(many.slice(5));
    for (const each of many) putTimeline(person, ARI, each, NOW);
    const kept = readTimeline(person, ARI);
    expect(kept).toHaveLength(200);
    expect(kept.at(-1)).toEqual(many.at(-1));
  });

  it('reads a file that is not what a put writes as empty, and the next put replaces it', () => {
    mkdirSync(folder(), { mode: 0o700 });
    const path = timelinePath(person, ARI);
    for (const text of ['not json', '[]', JSON.stringify({ schema_version: 2, kind: 'echo-desktop-ask-timeline-v1', turns: [] }),
      JSON.stringify({ schema_version: 1, kind: 'echo-desktop-ask-timeline-v1', turns: [{ ...turn(), id: 'one' }] }),
      JSON.stringify({ schema_version: 1, kind: 'echo-desktop-ask-timeline-v1', turns: [turn(), { ...turn(), answer: { ...turn().answer, parts: 'many' } }] })]) {
      writeFileSync(path, text, { mode: 0o600 });
      expect(readTimeline(person, ARI)).toEqual([]);
    }
    const fresh = turn();
    putTimeline(person, ARI, fresh, NOW);
    expect(readTimeline(person, ARI)).toEqual([fresh]);
  });

  it('never uses a folder that is a link, nor reads one open to others; a put makes it owner-only again', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'echo-elsewhere-'));
    try {
      symlinkSync(elsewhere, folder());
      expect(() => putTimeline(person, ARI, turn(), NOW)).toThrow();
      expect(readdirSync(elsewhere)).toEqual([]);
      expect(readTimeline(person, ARI)).toEqual([]);
    } finally {
      rmSync(folder(), { force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
    const first = turn();
    putTimeline(person, ARI, first, NOW);
    chmodSync(folder(), 0o755);
    expect(readTimeline(person, ARI)).toEqual([]);
    putTimeline(person, ARI, turn(), NOW);
    expect(mode(folder())).toBe(0o700);
    expect(readTimeline(person, ARI)).toHaveLength(2);
  });

  it('goes with our own sign-out; an account change leaves nothing of the last account, nor a write left half done', () => {
    putTimeline(person, ARI, turn(), NOW);
    putTimeline(person, MINA, turn(), NOW);
    writeFileSync(join(folder(), `.${'0'.repeat(24)}.tmp`), 'half', { mode: 0o600 });
    deleteOtherTimelines(person, MINA);
    expect(existsSync(timelinePath(person, ARI))).toBe(false);
    expect(readdirSync(folder())).toEqual([timelinePath(person, MINA).split('/').at(-1)]);
    expect(readTimeline(person, MINA)).toHaveLength(1);
    deleteTimeline(person, MINA);
    expect(readdirSync(folder())).toEqual([]);
    // Nothing to delete is no failure.
    deleteTimeline(person, ARI);
  });

  it('deletes from a folder open to others all the same, but never through a link or from a folder that is not yours to use', () => {
    putTimeline(person, ARI, turn(), NOW);
    putTimeline(person, MINA, turn(), NOW);
    chmodSync(folder(), 0o755);
    // Reads stay strict; deletion does not wait on the folder's mode.
    expect(readTimeline(person, MINA)).toEqual([]);
    deleteOtherTimelines(person, MINA);
    expect(existsSync(timelinePath(person, ARI))).toBe(false);
    expect(existsSync(timelinePath(person, MINA))).toBe(true);
    deleteTimeline(person, MINA);
    expect(readdirSync(folder())).toEqual([]);
    // A folder that is a link: nothing it points at goes.
    rmSync(folder(), { recursive: true });
    const elsewhere = mkdtempSync(join(tmpdir(), 'echo-elsewhere-'));
    try {
      const name = timelinePath(person, ARI).split('/').at(-1)!;
      writeFileSync(join(elsewhere, name), 'kept', { mode: 0o600 });
      symlinkSync(elsewhere, folder());
      deleteTimeline(person, ARI);
      deleteOtherTimelines(person, MINA);
      expect(readdirSync(elsewhere)).toEqual([name]);
    } finally {
      rmSync(folder(), { force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('takes only a turn as a put writes it: a page that sends anything else is refused', () => {
    const good = turn(0, { since: [], again_of: randomUUID(), markers: { 0: sha('b') }, unreadable: [0] });
    expect(timelineTurn(good)).toEqual(good);
    for (const bad of [
      { ...good, id: 'turn-1' }, { ...good, asked_at: 'yesterday' }, { ...good, scope: { kind: 'project', project_id: 'Apollo' } },
      { ...good, again_of: 'turn-0' }, { ...good, markers: { 0: 'v1' } }, { ...good, markers: { first: sha('b') } },
      // What a check found unreadable: distinct places among the answer's own sources.
      { ...good, unreadable: [0, 0] }, { ...good, unreadable: [good.answer.sources.length] }, { ...good, unreadable: [-1] }, { ...good, unreadable: ['0'] },
      { ...good, answer: { ...good.answer, outcome: 'clarify' } }, { ...good, answer: { ...good.answer, sources: [{ kind: 'ticket', label: 'T' }] } },
      { ...good, answer: { ...good.answer, sources: [{ ...good.answer.sources[0], cited: { ...cited, citation: undefined } }] } },
      { ...good, answer: { ...good.answer, sources: [{ ...good.answer.sources[0], cited: { ...cited, citation: { ...ticketCitation, kind: 7 } } }] } },
      { ...good, answer: { ...good.answer, parts: [{ ...good.answer.parts[0], layout: [{ kind: 'lead', statements: [3] }] }] } },
    ]) expect(timelineTurn(bad)).toBeNull();
  });
});

describe('what the page sends with an Ask and a check', () => {
  const previous: AskPrevious = {
    purpose: 'follow_up', question: 'What is open on THERM?', asked_at: '2026-10-25T11:30:00.000Z',
    statements: [{ text: 'THERM-482 is open.', citation_indexes: [0] }], citations: [cited],
  };

  it('carries the earlier turn as the client takes it, only on an Ask that has one', () => {
    expect(askArgv('Who owns it?', { kind: 'global' })).not.toContainEqual(expect.stringMatching(/^--previous=/u));
    expect(askArgv('Who owns it?', { kind: 'global' }, previous).at(-1)).toBe(`--previous=${JSON.stringify(previous)}`);
  });

  it('takes an earlier turn only within C3\'s bounds', () => {
    const global = { kind: 'global' } as const;
    /** As a follow-up asks: its own question, with the earlier turn. */
    const asked = (value: unknown) => askPrevious(value, 'Who owns it?', global);
    expect(asked(previous)).toEqual(previous);
    expect(askPrevious({ ...previous, purpose: 'ask_again', statements: [], citations: [] }, previous.question, global)).not.toBeNull();
    // Ask again asks the earlier question itself.
    expect(askPrevious({ ...previous, purpose: 'ask_again' }, 'Who owns it?', global)).toBeNull();
    // A question that fails on its own is the client's to report, as it would be without the earlier turn: that goes as it came.
    expect(askPrevious(previous, '?', global)).toEqual(previous);
    const many = <T>(item: T, count: number) => Array.from({ length: count }, () => item);
    for (const bad of [
      { ...previous, purpose: 'guess' }, { ...previous, question: '' }, { ...previous, question: ` ${previous.question}` }, { ...previous, asked_at: 'today' },
      { ...previous, asked_at: '2026-10-25T11:30:00Z' }, { ...previous, extra: true },
      { ...previous, statements: many(previous.statements[0], 9) }, { ...previous, statements: [{ text: 'x'.repeat(401), citation_indexes: [0] }] },
      { ...previous, statements: [{ text: 'Open.', citation_indexes: [1] }] }, { ...previous, statements: [{ text: 'Open.', citation_indexes: [0, 0, 0, 0, 0] }] },
      { ...previous, statements: [{ text: 'Open.', citation_indexes: [0], private: true }] }, { ...previous, citations: many(cited, 13) },
      { ...previous, citations: [{ ...cited, visibility: 'everyone' }] }, { ...previous, citations: [ticketCitation] },
      // Each citation once, and each sentence citing each once.
      { ...previous, citations: [cited, cited] }, { ...previous, statements: [{ text: 'Open.', citation_indexes: [0, 0] }] },
    ]) expect(asked(bad)).toBeNull();
    // 400 characters as the API counts them: code points, so a sentence of 400 emoji passes, and one more does not.
    expect(asked({ ...previous, statements: [{ text: '🙂'.repeat(400), citation_indexes: [0] }] })).not.toBeNull();
    expect(asked({ ...previous, statements: [{ text: '🙂'.repeat(401), citation_indexes: [0] }] })).toBeNull();
  });

  it('checks 1 to 100 items, each a citation that can change or go, a ticket\'s marker only on a ticket, within 64 KiB', () => {
    const item = { asked_at: '2026-10-25T11:30:00.000Z', citation: ticketCitation, marker: sha('b') };
    const record = { asked_at: item.asked_at, citation: { kind: 'approved_record', atom_id: sha('1'), record_sha256: sha('2'), policy_id: 'project-members-readable-person-v1' } };
    const followUp = { asked_at: item.asked_at, citation: { kind: 'follow_up', item_id: 'itm_timeline-1' } };
    const request = askCheckRequest([item, record, followUp]);
    expect(JSON.parse(request!)).toEqual({ schema_version: 1, kind: 'echo-person-ask-check-request-v1', items: [item, record, followUp] });
    expect(askCheckArgv(request!)).toEqual(['ask-check', `--request=${request}`]);
    for (const bad of [[], Array.from({ length: 101 }, () => item), [{ ...item, asked_at: 'now' }], [{ ...item, marker: 'v1' }], [{ ...record, marker: sha('b') }],
      [{ asked_at: item.asked_at, citation: { kind: 'person', membership_id: ARI.membership_id } }], [{ ...followUp, citation: { kind: 'follow_up', item_id: 'x' } }],
      [{ ...item, extra: 1 }], 'items']) expect(askCheckRequest(bad)).toBeNull();
    const long = { ...ticketCitation, permalink: `https://example.atlassian.net/browse/${'T'.repeat(1_900)}` };
    expect(askCheckRequest(Array.from({ length: 40 }, () => ({ ...item, citation: long })))).toBeNull();
  });
});
