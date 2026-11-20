// The Ask timeline's file (ADR-0047): one per account, beside the person
// session, readable by its owner only. The Authority never sees it. A put
// keeps one turn (a new one at the end, an old one in its place). Every turn
// stays, however old and however many, until the file would pass what this
// computer can read back as one file; only then do the oldest go. A put writes
// a private temporary file and renames it over the old one, so a reader never
// meets half a file.
// A file that cannot be read at all, or is not a timeline file, reads as empty
// and is replaced by the next put. Inside a timeline file, one turn the page
// cannot show is skipped on read and the others show; a put keeps it in the
// file as it was (a newer desktop may read it), so saving a turn never loses
// another. Only a turn an older desktop saved that no page draws now goes for
// good. Our own sign-out deletes the account's file; reading one account's
// timeline deletes any other account's, so an account change leaves nothing of
// the last one here. Kept apart from host.ts so all of it is tested on a real
// folder.
import { validatePersonAnswerGapDetailsV1, validateProjectIdV1 } from '@echo-brain/organization-api';
import { constants as buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import {
  ITEM_ID, type AnswerSource, type AnswerStatement, type ArrangedBlock, type AskScope, type Expect,
  type TimelineAnswer, type TimelineTurn,
} from '../shared/protocol.js';

/** The folder's name, inside the person client's own data folder. */
const TIMELINE_FOLDER = 'ask-timeline-v1';
const KIND = 'echo-desktop-ask-timeline-v1';
/**
 * Storage capacity: the file is read back whole as one string, and no string
 * here can be longer than the runtime's MAX_STRING_LENGTH. A UTF-8 file of at
 * most that many bytes always decodes into one, so a put keeps the file within
 * it, and a bigger file is not one a put wrote.
 */
export const MAX_TIMELINE_FILE_BYTES = buffer.MAX_STRING_LENGTH;
/** The file's own bytes around its turns: `{"schema_version":1,"kind":"…","turns":[]}`. */
export const TIMELINE_FILE_FRAME_BYTES = Buffer.byteLength(JSON.stringify({ schema_version: 1, kind: KIND, turns: [] }));

/** Where an account's timeline is: `<person data dir>/ask-timeline-v1/<hex sha256 of "<authority> <membership_id>">.json`. */
export function timelinePath(personDirectory: string, account: Expect): string {
  return join(personDirectory, TIMELINE_FOLDER, `${createHash('sha256').update(`${account.authority} ${account.membership_id}`).digest('hex')}.json`);
}

/**
 * The timeline's folder, owner-only: made so when it is missing, and made so
 * again before a write (`write`). One that is a link, not a folder, or not
 * yours is never used. One open to others is never read from (`read`), but a
 * timeline in it still goes when it should (`delete`): its mode never keeps
 * one that our own sign-out or an account change removes.
 */
function folder(personDirectory: string, use: 'read' | 'write' | 'delete'): string | null {
  const path = join(personDirectory, TIMELINE_FOLDER);
  try {
    if (use === 'write') mkdirSync(path, { recursive: true, mode: 0o700 });
    const found = lstatSync(path);
    const uid = process.getuid?.();
    if (!found.isDirectory() || found.isSymbolicLink() || (uid !== undefined && found.uid !== uid)) return null;
    if ((found.mode & 0o777) !== 0o700 && use !== 'delete') {
      if (use === 'read') return null;
      chmodSync(path, 0o700);
    }
    return path;
  } catch {
    return null;
  }
}

/** A turn as the file holds it, whether or not this page can show it: what a put needs to keep it in its place and prune it. */
type StoredTurn = Json & { readonly id: string; readonly asked_at: string };
const stored = (value: unknown): value is StoredTurn => record(value) && typeof value.id === 'string' && time(value.asked_at);

/**
 * Every turn the account's file holds, oldest first, as it holds them, less
 * those an older desktop saved that no page draws now; each id once, its
 * first. A missing or unreadable file, or one that is not a timeline file,
 * holds none.
 */
function storedTurns(personDirectory: string, account: Expect): StoredTurn[] {
  if (folder(personDirectory, 'read') === null) return [];
  const path = timelinePath(personDirectory, account);
  try {
    const found = lstatSync(path);
    if (!found.isFile() || found.size > MAX_TIMELINE_FILE_BYTES) return [];
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const file = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    if (Object.keys(file).sort().join() !== 'kind,schema_version,turns' || file.schema_version !== 1 || file.kind !== KIND || !Array.isArray(file.turns)) return [];
    const seen = new Set<string>();
    return file.turns.filter((turn): turn is StoredTurn => stored(turn) && !retired(turn) && !seen.has(turn.id) && Boolean(seen.add(turn.id)));
  } catch {
    return [];
  }
}

/**
 * The account's turns the page can show, oldest first. One it cannot is
 * skipped, never the others; a missing or unreadable file is empty.
 */
export function readTimeline(personDirectory: string, account: Expect): TimelineTurn[] {
  return storedTurns(personDirectory, account).map(timelineTurn).filter((turn): turn is TimelineTurn => turn !== null);
}

/**
 * The turns a timeline keeps, in their order: all of them while the file holds
 * them in `bytes`, else the newest that fit, and always the newest one.
 */
export function pruneTurns<T>(turns: readonly T[], bytes = MAX_TIMELINE_FILE_BYTES): T[] {
  // Each turn with the comma after it.
  const sizes = turns.map(turn => Buffer.byteLength(JSON.stringify(turn)) + 1);
  let total = sizes.reduce((sum, size) => sum + size, TIMELINE_FILE_FRAME_BYTES);
  let from = 0;
  while (from < turns.length - 1 && total > bytes) total -= sizes[from++]!;
  return turns.slice(from);
}

/**
 * Keeps `turn` in the account's file: in place of the turn with its id, or at
 * the end; then prunes, and writes the file whole, as the person session's
 * store writes its own: every byte and then the new name on disk before it
 * returns, so a crash leaves the old file or the new one, never part of one.
 */
export function putTimeline(personDirectory: string, account: Expect, turn: TimelineTurn): void {
  const directory = folder(personDirectory, 'write');
  if (directory === null) throw new Error('The Ask timeline folder is not private');
  // Every turn the file holds stays, a turn this page cannot show included.
  const turns: StoredTurn[] = storedTurns(personDirectory, account);
  const at = turns.findIndex(kept => kept.id === turn.id);
  const put = turn as unknown as StoredTurn;
  if (at >= 0) turns[at] = put; else turns.push(put);
  const bytes = Buffer.from(JSON.stringify({ schema_version: 1, kind: KIND, turns: pruneTurns(turns) }), 'utf8');
  const path = timelinePath(personDirectory, account);
  const temporary = join(directory, `.${randomBytes(12).toString('hex')}.tmp`);
  // Created here, owner-only, never through a link: then its bytes on disk before it takes the name.
  const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    try {
      // A write may take only part of what it is given: written on from where it stopped, until every byte is.
      for (let written = 0; written < bytes.length;) {
        const took = writeSync(descriptor, bytes, written, bytes.length - written);
        if (took <= 0) throw new Error('The Ask timeline could not be written');
        written += took;
      }
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  // The folder's new entry on disk too.
  syncFolder(directory);
}

/** A folder's entries on disk: a file renamed into it stays renamed after a crash. */
function syncFolder(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** Our own sign-out: the account's file goes. */
export function deleteTimeline(personDirectory: string, account: Expect): void {
  if (folder(personDirectory, 'delete') === null) return;
  rmSync(timelinePath(personDirectory, account), { force: true });
}

/** An account change: every other account's file goes, and anything a put left half done. */
export function deleteOtherTimelines(personDirectory: string, account: Expect): void {
  const directory = folder(personDirectory, 'delete');
  if (directory === null) return;
  const own = timelinePath(personDirectory, account);
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (path !== own && (/^[0-9a-f]{64}\.json$/.test(name) || /^\.[0-9a-f]{24}\.tmp$/.test(name))) rmSync(path, { force: true });
  }
}

// ---- what a kept turn is ----------------------------------------------------------

type Json = Record<string, unknown>;
const record = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);
// No length or count of its own: the file's size bounds a turn, and the answer's contract was checked when it came.
const string = (value: unknown): value is string => typeof value === 'string';
const index = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const indexes = (value: unknown): value is number[] => Array.isArray(value) && value.every(index);
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const projectId = (value: unknown): boolean => { try { validateProjectIdV1(value); return true; } catch { return false; } };
const time = (value: unknown): value is string => string(value) && !Number.isNaN(Date.parse(value));
const STATUSES: ReadonlySet<unknown> = new Set(['answered', 'partial', 'not_found', 'records_only']);
const OUTCOMES: ReadonlySet<unknown> = new Set(['answered', 'partial', 'not_found']);

function scope(value: unknown): value is AskScope {
  if (!record(value)) return false;
  const keys = Object.keys(value).sort().join();
  return value.kind === 'project' ? keys === 'kind,project_id' && projectId(value.project_id) : value.kind === 'global' && keys === 'kind';
}

function statement(value: unknown): value is AnswerStatement {
  return record(value) && string(value.text) && indexes(value.citation_indexes) && typeof value.private === 'boolean';
}
const statements = (value: unknown): value is AnswerStatement[] => Array.isArray(value) && value.every(statement);

/**
 * A source, by what the page reads of its kind to show and open it: anything
 * else would break the page that shows it. What it cited is kept as the
 * answer had it, with the evidence citation whose kind says whether a check
 * asks about it.
 */
function source(value: unknown): value is AnswerSource {
  if (!record(value) || !string(value.label)) return false;
  if (value.cited !== undefined && !(record(value.cited) && record(value.cited.citation) && string(value.cited.citation.kind))) return false;
  if (value.private !== undefined && value.private !== true) return false;
  switch (value.kind) {
    case 'record': return string(value.atom_id) && record(value.record) && string(value.record.record_sha256) && string(value.record.policy_id);
    case 'original': return record(value.ref) && ['source_id', 'revision_id', 'source_sha256', 'representation_sha256', 'anchor_sha256'].every(key => string((value.ref as Json)[key]))
      && (value.item === undefined || (record(value.item) && string(value.item.kind) && string(value.item.id)));
    case 'follow_up': return string(value.item_id);
    case 'project': return string(value.project_id);
    case 'person': return string(value.membership_id);
    case 'tool': return string(value.tool_id);
    case 'ticket': case 'page': return string(value.tool_id) && string(value.permalink);
    case 'container': return string(value.tool_id) && string(value.permalink) && string(value.container) && (value.key === undefined || string(value.key));
    default: return false;
  }
}

/** A table, as the page draws it: its columns, its caption, and each row's cells and citations. */
function table(block: Json): boolean {
  return Array.isArray(block.columns) && block.columns.every(column => string(column)) && (block.caption === undefined || string(block.caption))
    && Array.isArray(block.rows) && block.rows.every(row => record(row) && Array.isArray(row.cells) && row.cells.every(cell => string(cell)) && indexes(row.citation_indexes));
}

/** Whether `places` are sentences of a part that has `count`, by their place. */
const within = (places: unknown, count: number) => indexes(places) && places.every(place => place < count);

/** One item a sentence: as many `items` as the block has sentences (checked first), each what the page reads of it. */
const each = (block: Json, items: unknown, item: (entry: Json) => boolean) => Array.isArray(items) && items.length === (block.statements as unknown[]).length
  && items.every(entry => record(entry) && item(entry));

/**
 * What the page reads of each kind of block a writer arranges a part in
 * (answer layout v2, ADR-0051), once its sentences and title are checked: a
 * timeline has an event and a card a fact for each of its sentences, and a
 * quote has one sentence.
 */
const ARRANGED: Readonly<Record<ArrangedBlock['kind'], (block: Json) => boolean>> = {
  answer: () => true, text: () => true, points: block => typeof block.ordered === 'boolean', table,
  timeline: block => each(block, block.events, event => string(event.date) && string(event.text) && (event.who === undefined || string(event.who))),
  // Any entity the answer named: the page words one it does not know by its own name.
  card: block => string(block.title) && string(block.entity) && each(block, block.facts, fact => string(fact.label) && string(fact.value)),
  quote: block => (block.statements as unknown[]).length === 1 && string(block.text) && (block.from === undefined || string(block.from)),
};

/**
 * A part's blocks (answer layout v2, ADR-0051), each with its sentences among
 * the part's own and its title a text: the page reads an item by its
 * sentence's place. A kind the page draws has what it reads of it; one it
 * does not know is shown as its sentences' text.
 */
function arranged(value: unknown, count: number): boolean {
  return Array.isArray(value) && value.every(block => record(block) && typeof block.kind === 'string'
    && within(block.statements, count) && (block.title === undefined || string(block.title))
    && (!Object.hasOwn(ARRANGED, block.kind) || ARRANGED[block.kind as ArrangedBlock['kind']](block)));
}

function gapDetails(value: unknown): boolean {
  try { validatePersonAnswerGapDetailsV1(value); return true; } catch { return false; }
}

/**
 * The follow-ups an answer drafted (ADR-0053): their ids alone, at least one and each once. The page reads each card live
 * whenever the turn shows, so a saved turn never keeps what one said.
 */
const followUps = (value: unknown): boolean => Array.isArray(value) && value.length >= 1
  && value.every(id => string(id) && ITEM_ID.test(id)) && new Set(value).size === value.length;

/**
 * An answer as the timeline keeps it: what the page reads back of a turn
 * (TimelineAnswer). A part with statements has them in blocks (answer layout
 * v2, ADR-0051), and one with none has nothing to arrange.
 */
function answer(value: unknown): value is TimelineAnswer {
  if (!record(value) || !scope(value.scope) || !OUTCOMES.has(value.outcome)) return false;
  if (!Array.isArray(value.sources) || !value.sources.every(source)) return false;
  if (value.direct !== undefined && !statement(value.direct)) return false;
  if (value.follow_ups !== undefined && !followUps(value.follow_ups)) return false;
  return Array.isArray(value.parts) && value.parts.every(part => record(part) && string(part.question) && STATUSES.has(part.status)
    && statements(part.statements) && (part.gap === undefined || string(part.gap)) && (part.gap_details === undefined || gapDetails(part.gap_details)) && (part.records === undefined || statements(part.records))
    && (part.blocks === undefined ? part.statements.length === 0 : part.statements.length > 0 && arranged(part.blocks, part.statements.length)));
}

/**
 * A turn an older desktop saved that no page draws now, dropped on read while
 * the rest of its file stays: one asked in Mine (ADR-0049), or one with a part
 * whose statements have no blocks, plain or laid out by answer layout v1
 * (ADR-0045, ADR-0051). Release 1441d68 still keeps and rewrites Mine turns
 * asked around 2026-10-26 to 10-31; the first put after them leaves them out.
 */
function retired(turn: unknown): boolean {
  const parts = record(turn) && record(turn.answer) && Array.isArray(turn.answer.parts) ? turn.answer.parts : [];
  return (record(turn) && record(turn.scope) && turn.scope.kind === 'mine')
    || parts.some(part => record(part) && (Object.hasOwn(part, 'layout') || (part.blocks === undefined && Array.isArray(part.statements) && part.statements.length > 0)));
}

/** A turn as a put writes it, or null for anything else. */
export function timelineTurn(value: unknown): TimelineTurn | null {
  if (!record(value) || !string(value.id) || !ID.test(value.id) || !time(value.asked_at) || !string(value.text) || !string(value.question)
      || !scope(value.scope) || !answer(value.answer)) return null;
  if (value.since !== undefined && !statements(value.since)) return null;
  if (value.again_of !== undefined && !(string(value.again_of) && ID.test(value.again_of))) return null;
  if (value.citations_complete !== undefined && value.citations_complete !== true) return null;
  if (value.typed !== undefined && !string(value.typed)) return null;
  if (value.follows !== undefined && value.follows !== null && !(string(value.follows) && ID.test(value.follows))) return null;
  // The sources a check found unreadable: distinct places among the answer's own sources.
  const sources = (value.answer as TimelineAnswer).sources.length;
  if (value.unreadable !== undefined && !(indexes(value.unreadable) && new Set(value.unreadable).size === value.unreadable.length
      && value.unreadable.every(at => at < sources))) {
    return null;
  }
  return value as unknown as TimelineTurn;
}
