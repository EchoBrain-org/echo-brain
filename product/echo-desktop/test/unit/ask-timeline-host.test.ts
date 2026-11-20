// The Ask timeline on the host (ADR-0047): its file, on a real folder (one per
// account, owner-only, written whole through a temporary file, every turn kept
// until the file would pass what it can hold, a bad file read as empty, a turn an older desktop saved
// dropped on its own, our sign-out deleting it and an account change deleting
// the last one's), and the checks of what the page
// sends with an Ask and a source check before the client sees it.
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { constants } from 'node:buffer';
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
import { ASK_RUN_SILENCE_MS, HOST_TIMEOUT_MS } from '../../src/shared/protocol.js';
import { PERSON_ASK_PROGRESS_HEARTBEAT_MS_V1 } from '@echo-brain/organization-api';
import { askArgv, askCheckArgv, askCheckRequest, askPrevious } from '../../src/host/ask.js';
import { askText } from '../../src/shared/query.js';
import {
  deleteOtherTimelines, deleteTimeline, MAX_TIMELINE_FILE_BYTES, pruneTurns, putTimeline, readTimeline, TIMELINE_FILE_FRAME_BYTES, timelinePath, timelineTurn,
} from '../../src/host/timeline.js';
import { answerView } from '../../src/host/views.js';
import { blocksAnswer } from '../fixtures/authority.js';
import { askLine } from './ask-line.js';

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
      scope: { kind: 'global' }, outcome: 'answered',
      sources: [{ kind: 'ticket', tool_id: 'jira', label: 'THERM-482 · Sensor drift', permalink: ticketCitation.permalink, private: true, cited }],
      parts: [{ question: 'What is open on THERM?', status: 'answered', statements: [{ text: 'THERM-482 is open.', citation_indexes: [0], private: true }],
        blocks: [{ kind: 'text', statements: [0] }] }],
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
    putTimeline(person, ARI, first);
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
    putTimeline(person, ARI, first);
    putTimeline(person, ARI, second);
    const marked = { ...first, unreadable: [0] };
    putTimeline(person, ARI, marked);
    expect(readTimeline(person, ARI)).toEqual([marked, second]);
    expect(readdirSync(folder()).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('writes every byte however little a write takes, and has the file and its new name on disk before a put returns', () => {
    const [first, second] = [turn(2), turn(1)];
    putTimeline(person, ARI, first);
    vi.mocked(fsyncSync).mockClear();
    vi.mocked(renameSync).mockClear();
    disk.short = true;
    try {
      putTimeline(person, ARI, second);
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

  it('keeps every turn, however old and however many, while the file holds them', () => {
    const old = turn(400);
    putTimeline(person, ARI, old);
    const recent = turn(89);
    putTimeline(person, ARI, recent);
    expect(readTimeline(person, ARI)).toEqual([old, recent]);
    const many = Array.from({ length: 205 }, (_, at) => turn(0, { asked_at: new Date(NOW - (205 - at) * 60_000).toISOString() }));
    expect(pruneTurns(many)).toEqual(many);
    for (const each of many) putTimeline(person, ARI, each);
    const kept = readTimeline(person, ARI);
    expect(kept).toHaveLength(207);
    expect(kept.at(-1)).toEqual(many.at(-1));
  });

  it('lets the oldest turns go only when the file would pass what it can hold, never the newest', () => {
    const many = Array.from({ length: 10 }, (_, at) => turn(10 - at));
    const one = Buffer.byteLength(JSON.stringify(many[0]));
    const room = TIMELINE_FILE_FRAME_BYTES + 4 * (one + 1);
    expect(pruneTurns(many, room)).toEqual(many.slice(6));
    expect(pruneTurns(many, 1)).toEqual(many.slice(9));
    // The bound is what this computer can read back as one file.
    expect(MAX_TIMELINE_FILE_BYTES).toBe(constants.MAX_STRING_LENGTH);
  });

  it('reads a file that is not a timeline file as empty, and the next put replaces it', () => {
    mkdirSync(folder(), { mode: 0o700 });
    const path = timelinePath(person, ARI);
    for (const text of ['not json', '[]', JSON.stringify({ schema_version: 2, kind: 'echo-desktop-ask-timeline-v1', turns: [] })]) {
      writeFileSync(path, text, { mode: 0o600 });
      expect(readTimeline(person, ARI)).toEqual([]);
    }
    const fresh = turn();
    putTimeline(person, ARI, fresh);
    expect(readTimeline(person, ARI)).toEqual([fresh]);
  });

  it('skips only a turn it cannot show, and a put keeps that turn in the file and every other with it', () => {
    mkdirSync(folder(), { mode: 0o700 });
    const path = timelinePath(person, ARI);
    const [first, second] = [turn(3), turn(2)];
    const unshown = { ...turn(1), answer: { ...turn().answer, parts: 'many' } };
    const nameless = { ...turn(1), id: 'one' };
    writeFileSync(path, JSON.stringify({ schema_version: 1, kind: 'echo-desktop-ask-timeline-v1', turns: [first, unshown, nameless, second, { ...second, text: 'again' }] }), { mode: 0o600 });
    // The rest show: one bad turn never hides them, and an id the file holds twice shows once, as first written.
    expect(readTimeline(person, ARI)).toEqual([first, second]);
    // Saving a new turn rewrites the file with every turn it held, the ones this page cannot show as they were.
    const fresh = turn();
    putTimeline(person, ARI, fresh);
    expect((JSON.parse(readFileSync(path, 'utf8')) as { turns: unknown[] }).turns).toEqual([first, unshown, nameless, second, fresh]);
    expect(readTimeline(person, ARI)).toEqual([first, second, fresh]);
  });

  it('drops a turn an older desktop saved, asked in Mine or with a part without blocks (plain, or laid out by layout v1), and keeps the rest of the file', () => {
    mkdirSync(folder(), { mode: 0o700 });
    const path = timelinePath(person, ARI);
    const current = turn(1);
    const { blocks: _blocks, ...bare } = current.answer.parts[0]!;
    for (const old of [{ ...turn(2), scope: { kind: 'mine' }, answer: { ...current.answer, scope: { kind: 'mine' } } }, { ...turn(2), answer: { ...current.answer, parts: [bare] } },
      { ...turn(2), answer: { ...current.answer, parts: [{ ...current.answer.parts[0]!, layout: [{ kind: 'lead', statements: [0] }] }] } }]) {
      writeFileSync(path, JSON.stringify({ schema_version: 1, kind: 'echo-desktop-ask-timeline-v1', turns: [old, current] }), { mode: 0o600 });
      expect(readTimeline(person, ARI)).toEqual([current]);
    }
    // The next put writes the file without it.
    const fresh = turn();
    putTimeline(person, ARI, fresh);
    expect((JSON.parse(readFileSync(path, 'utf8')) as { turns: TimelineTurn[] }).turns).toEqual([current, fresh]);
  });

  it('never uses a folder that is a link, nor reads one open to others; a put makes it owner-only again', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'echo-elsewhere-'));
    try {
      symlinkSync(elsewhere, folder());
      expect(() => putTimeline(person, ARI, turn())).toThrow();
      expect(readdirSync(elsewhere)).toEqual([]);
      expect(readTimeline(person, ARI)).toEqual([]);
    } finally {
      rmSync(folder(), { force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
    const first = turn();
    putTimeline(person, ARI, first);
    chmodSync(folder(), 0o755);
    expect(readTimeline(person, ARI)).toEqual([]);
    putTimeline(person, ARI, turn());
    expect(mode(folder())).toBe(0o700);
    expect(readTimeline(person, ARI)).toHaveLength(2);
  });

  it('goes with our own sign-out; an account change leaves nothing of the last account, nor a write left half done', () => {
    putTimeline(person, ARI, turn());
    putTimeline(person, MINA, turn());
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
    putTimeline(person, ARI, turn());
    putTimeline(person, MINA, turn());
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
    const good = turn(0, { since: [], again_of: randomUUID(), unreadable: [0], citations_complete: true, typed: 'whats open' });
    expect(timelineTurn(good)).toEqual(good);
    // A turn an older desktop saved has no mark, and is read as it was.
    const { citations_complete: _mark, ...older } = good;
    expect(timelineTurn(older)).toEqual(older);
    const { blocks: _blocks, ...bare } = good.answer.parts[0]!;
    for (const bad of [
      // Never what a put writes: a part's statements without blocks (ADR-0051), a scope the page has not got, and blocks with nothing to arrange.
      { ...good, answer: { ...good.answer, parts: [bare] } },
      { ...good, scope: { kind: 'mine' } }, { ...good, answer: { ...good.answer, parts: [{ ...good.answer.parts[0]!, statements: [] }] } },
      { ...good, id: 'turn-1' }, { ...good, asked_at: 'yesterday' }, { ...good, scope: { kind: 'project', project_id: 'Apollo' } },
      { ...good, again_of: 'turn-0' }, { ...good, citations_complete: false }, { ...good, citations_complete: 1 }, { ...good, typed: 7 },
      // What a check found unreadable: distinct places among the answer's own sources.
      { ...good, unreadable: [0, 0] }, { ...good, unreadable: [good.answer.sources.length] }, { ...good, unreadable: [-1] }, { ...good, unreadable: ['0'] },
      { ...good, answer: { ...good.answer, outcome: 'clarify' } }, { ...good, answer: { ...good.answer, sources: [{ kind: 'ticket', label: 'T' }] } },
      { ...good, answer: { ...good.answer, sources: [{ ...good.answer.sources[0], cited: { ...cited, citation: undefined } }] } },
      { ...good, answer: { ...good.answer, sources: [{ ...good.answer.sources[0], cited: { ...cited, citation: { ...ticketCitation, kind: 7 } } }] } },
    ]) expect(timelineTurn(bad)).toBeNull();
  });

  it('persists bounded typed gap details and rejects malformed saved reasons', () => {
    const original = turn();
    const answer = { ...original.answer, outcome: 'partial' as const, parts: [{ ...original.answer.parts[0]!, status: 'partial' as const,
      gap: 'Not found: the owner. Some list rows did not fit.', gap_details: { not_found: 'Not found: the owner.', unsupported_action: true as const } }] };
    const kept = { ...original, answer };
    putTimeline(person, ARI, kept);
    expect(readTimeline(person, ARI)).toEqual([kept]);
    for (const gap_details of [{}, { unsupported_action: false }, { interrupted: 'true' }, { not_found: '' }, { technical: true }]) {
      expect(timelineTurn({ ...kept, answer: { ...answer, parts: [{ ...answer.parts[0], gap_details }] } })).toBeNull();
    }
  });

  it('keeps the ids of the follow-ups an answer drafted, and never a card itself (ADR-0053)', () => {
    const original = turn();
    const kept = { ...original, answer: { ...original.answer, follow_ups: ['itm_chat-0001', 'itm_chat-0002'] } };
    putTimeline(person, ARI, kept);
    expect(readTimeline(person, ARI)).toEqual([kept]);
    for (const follow_ups of [[], ['itm_chat-0001', 'itm_chat-0001'], ['run_1'], [{ item_id: 'itm_chat-0001', expected: 'Update the pricing page' }], 'itm_chat-0001']) {
      expect(timelineTurn({ ...kept, answer: { ...kept.answer, follow_ups } })).toBeNull();
    }
    // No count of its own: the answer's contract says how many an answer drafts.
    const many = Array.from({ length: 11 }, (_, at) => `itm_chat-${String(at).padStart(4, '0')}`);
    expect(timelineTurn({ ...kept, answer: { ...kept.answer, follow_ups: many } })).not.toBeNull();
  });

  it('keeps an answer arranged in blocks (ADR-0051) as the page wrote it, and refuses blocks the page could not draw', () => {
    const scope = { kind: 'global' } as const;
    /** An answer as the page keeps it: what the host handed it, less what only its Ask reads. */
    const kept = (result: Record<string, unknown>): TimelineTurn['answer'] => {
      const { receipt: _receipt, question: _question, since: _since, choices: _choices, ...answer } = answerView(askLine(result), scope);
      return answer;
    };
    const arranged = turn(1, { answer: kept(blocksAnswer('Can THERM start PVT?', scope)) });
    putTimeline(person, ARI, arranged);
    const [readArranged] = readTimeline(person, ARI);
    expect(readArranged).toEqual(arranged);
    expect(readArranged!.answer.parts[0]!.blocks!.map(block => block.kind)).toEqual(['answer', 'table', 'timeline', 'card', 'points', 'text', 'quote']);
    // An answer in blocks has no count of statements of its own (ADR-0051): 70 read back as written.
    const wide = arranged.answer.parts[0]!;
    const seventy = Array.from({ length: 70 }, (_, at) => ({ text: `Step ${at + 1}.`, citation_indexes: [0], private: wide.statements[0]!.private }));
    const long = turn(2, { answer: { ...arranged.answer, parts: [{ ...wide, statements: seventy, blocks: [{ kind: 'answer', statements: [0] }, { kind: 'points', ordered: true, statements: seventy.slice(1).map((_, at) => at + 1) }] }] } });
    putTimeline(person, ARI, long);
    expect(readTimeline(person, ARI).find(entry => entry.id === long.id)?.answer.parts[0]!.statements).toHaveLength(70);
    const part = arranged.answer.parts[0]!;
    const blocks = part.blocks! as unknown as Record<string, unknown>[];
    const timeline = blocks[2] as { events: Record<string, unknown>[] };
    const card = blocks[3] as { facts: Record<string, unknown>[] };
    /** The arranged turn with `fields` in its blocks' place `at`. */
    const changed = (at: number, fields: Record<string, unknown>) => ({ ...arranged, answer: { ...arranged.answer, parts: [{ ...part,
      blocks: blocks.map((block, place) => place === at ? { ...block, ...fields } : block) }] } });
    expect(timelineTurn(changed(4, { ordered: false }))).not.toBeNull();
    // A kind of block, or a card's entity, the page does not know is kept: the page shows it as text, or by the entity's name.
    expect(timelineTurn(changed(0, { kind: 'lead' }))).not.toBeNull();
    expect(timelineTurn(changed(3, { entity: 'meeting' }))).not.toBeNull();
    // No length of its own: a long question and a long sentence are kept as they were asked and answered.
    expect(timelineTurn({ ...arranged, text: 'q'.repeat(5_000), question: 'q'.repeat(5_000) })).not.toBeNull();
    for (const bad of [
      changed(0, { kind: 7 }), changed(0, { statements: [10] }), changed(5, { title: 7 }), changed(4, { ordered: 'yes' }),
      changed(1, { rows: [{ cells: 'THERM-52', citation_indexes: [4] }] }),
      // An event, a fact and a quote are each one sentence: the page reads them by its place.
      changed(2, { events: [timeline.events[0]] }), changed(2, { events: [timeline.events[0], { text: 'No day.' }] }),
      changed(3, { entity: 7 }), changed(3, { title: undefined }), changed(3, { facts: [card.facts[0], { label: 'Owner' }] }),
      changed(6, { statements: [8, 9] }), changed(6, { text: null }),
    ]) expect(timelineTurn(bad)).toBeNull();
  });
});

describe('what the page sends with an Ask and a check', () => {
  const previous: AskPrevious = {
    purpose: 'follow_up', question: 'What is open on THERM?', asked_at: '2026-10-25T11:30:00.000Z',
    statements: [{ text: 'THERM-482 is open.', citation_indexes: [0] }], citations: [cited],
  };

  it('sends a long natural-language question on two lines whole, as the person typed it', () => {
    const question = 'Can you summarize what the hardware and firmware teams decided about the thermal fix, who owns each follow-up, '
      + "what's still blocked on supplier samples, and what changed since last Tuesday's review?\nAnd which of those are due before Friday's build review?";
    expect(new Set(question.match(/[\p{L}\p{N}]+/gu)!.map(word => word.toLowerCase())).size).toBeGreaterThan(32);
    expect(question.length).toBeGreaterThan(240);
    expect(askArgv(askText(` ${question} `), { kind: 'global' })).toEqual(['ask', `--question=${question}`, '--progress']);
  });

  it('waits on liveness: an Ask\'s silence outlasts the client\'s own 40 s stall and two session refreshes; a cited passage its 15 s read and 15 s session', () => {
    expect(HOST_TIMEOUT_MS['ask.run']).toBe(ASK_RUN_SILENCE_MS);
    expect(ASK_RUN_SILENCE_MS).toBeGreaterThan(4 * PERSON_ASK_PROGRESS_HEARTBEAT_MS_V1 + 2 * 15_000);
    expect(HOST_TIMEOUT_MS['ask.source']).toBeGreaterThan(30_000);
  });

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
    // The question is the Authority's to judge: any question carries the earlier turn, a long one on two lines too.
    expect(askPrevious(previous, '?', global)).toEqual(previous);
    expect(askPrevious(previous, `${'Who owns the retest and what is blocked? '.repeat(10).trim()}\nAnd when?`, global)).toEqual(previous);
    const many = <T>(item: T, count: number) => Array.from({ length: count }, () => item);
    for (const bad of [
      { ...previous, purpose: 'guess' }, { ...previous, question: '' }, { ...previous, question: ` ${previous.question}` }, { ...previous, asked_at: 'today' },
      { ...previous, asked_at: '2026-10-25T11:30:00Z' }, { ...previous, extra: true },
      { ...previous, statements: [{ text: 'Open.', citation_indexes: [1] }] },
      { ...previous, statements: [{ text: 'Open.', citation_indexes: [0], private: true }] },
      { ...previous, citations: [{ ...cited, visibility: 'everyone' }] }, { ...previous, citations: [ticketCitation] },
      // Each citation once, and each sentence citing each once.
      { ...previous, citations: [cited, cited] }, { ...previous, statements: [{ text: 'Open.', citation_indexes: [0, 0] }] },
    ]) expect(asked(bad)).toBeNull();
    // No count or length of its own: many sentences, a long one, and many citations all go.
    expect(asked({ ...previous, statements: many(previous.statements[0], 300) })).not.toBeNull();
    expect(asked({ ...previous, statements: [{ text: '🙂'.repeat(5_000), citation_indexes: [0] }] })).not.toBeNull();
  });

  it('checks any number of items, each a citation that can go, within the 1 MiB request body', () => {
    const item = { asked_at: '2026-10-25T11:30:00.000Z', citation: ticketCitation };
    const record = { asked_at: item.asked_at, citation: { kind: 'approved_record', atom_id: sha('1'), record_sha256: sha('2'), policy_id: 'project-members-readable-person-v1' } };
    const followUp = { asked_at: item.asked_at, citation: { kind: 'follow_up', item_id: 'itm_timeline-1' } };
    const request = askCheckRequest([item, record, followUp]);
    expect(JSON.parse(request!)).toEqual({ schema_version: 1, kind: 'echo-person-ask-check-request-v1', items: [item, record, followUp] });
    expect(askCheckArgv(request!)).toEqual(['ask-check', `--request=${request}`]);
    // Any number of items within the body's bound.
    expect(JSON.parse(askCheckRequest(Array.from({ length: 101 }, () => item))!).items).toHaveLength(101);
    for (const bad of [[], [{ ...item, asked_at: 'now' }],
      [{ asked_at: item.asked_at, citation: { kind: 'person', membership_id: ARI.membership_id } }], [{ ...followUp, citation: { kind: 'follow_up', item_id: 'x' } }],
      [{ ...item, extra: 1 }], 'items']) expect(askCheckRequest(bad)).toBeNull();
    const long = { ...ticketCitation, permalink: `https://example.atlassian.net/browse/${'T'.repeat(1_900)}` };
    expect(askCheckRequest(Array.from({ length: 600 }, () => ({ ...item, citation: long })))).toBeNull();
  });
});
