// The Ask timeline's file (ADR-0047): one per account, beside the person
// session, readable by its owner only. The Authority never sees it. A put
// keeps one turn (a new one at the end, an old one in its place), then drops
// turns past 90 days and all but the newest 200; it writes a private temporary
// file and renames it over the old one, so a reader never meets half a file.
// A file that cannot be read, or is not what a put writes, reads as empty and
// is replaced by the next put; a turn an older desktop saved that no page
// draws now goes on its own, and the next put writes the rest. Our own
// sign-out deletes the account's file; reading one account's timeline deletes
// any other account's, so an account change leaves nothing of the last one
// here. Kept apart from host.ts so all of it is tested on a real folder.
import { PERSON_ANSWER_CARD_ENTITIES_V2, validatePersonAnswerGapDetailsV1, validateProjectIdV1 } from '@echo-brain/organization-api';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAX_TIMELINE_PUT_BYTES, MAX_TIMELINE_TURNS, TIMELINE_DAYS, type AnswerSource, type AnswerStatement, type ArrangedBlock, type AskScope, type Expect,
  type TimelineAnswer, type TimelineTurn,
} from '../shared/protocol.js';

/** The folder's name, inside the person client's own data folder. */
const TIMELINE_FOLDER = 'ask-timeline-v1';
const KIND = 'echo-desktop-ask-timeline-v1';
/** More than 200 turns of the largest answers: anything bigger is not a file a put wrote. */
const MAX_FILE_BYTES = MAX_TIMELINE_TURNS * MAX_TIMELINE_PUT_BYTES;
const DAY_MS = 24 * 60 * 60_000;

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

/** The account's turns, oldest first. A missing, unreadable or malformed file is empty. */
export function readTimeline(personDirectory: string, account: Expect): TimelineTurn[] {
  if (folder(personDirectory, 'read') === null) return [];
  const path = timelinePath(personDirectory, account);
  try {
    const found = lstatSync(path);
    if (!found.isFile() || found.size > MAX_FILE_BYTES) return [];
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const file = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    if (Object.keys(file).sort().join() !== 'kind,schema_version,turns' || file.schema_version !== 1 || file.kind !== KIND || !Array.isArray(file.turns)) return [];
    const turns = file.turns.filter(turn => !retired(turn)).map(timelineTurn);
    return turns.every((turn): turn is TimelineTurn => turn !== null) && new Set(turns.map(turn => turn.id)).size === turns.length ? turns : [];
  } catch {
    return [];
  }
}

/**
 * The turns a timeline keeps at `now`: none asked more than 90 days ago, and
 * the newest 200 of the rest, in their order.
 */
export function pruneTurns(turns: readonly TimelineTurn[], now: number): TimelineTurn[] {
  const kept = turns.filter(turn => now - Date.parse(turn.asked_at) <= TIMELINE_DAYS * DAY_MS);
  return kept.slice(Math.max(0, kept.length - MAX_TIMELINE_TURNS));
}

/**
 * Keeps `turn` in the account's file: in place of the turn with its id, or at
 * the end; then prunes, and writes the file whole, as the person session's
 * store writes its own: every byte and then the new name on disk before it
 * returns, so a crash leaves the old file or the new one, never part of one.
 */
export function putTimeline(personDirectory: string, account: Expect, turn: TimelineTurn, now: number): void {
  const directory = folder(personDirectory, 'write');
  if (directory === null) throw new Error('The Ask timeline folder is not private');
  const turns = readTimeline(personDirectory, account);
  const at = turns.findIndex(kept => kept.id === turn.id);
  if (at >= 0) turns[at] = turn; else turns.push(turn);
  const bytes = Buffer.from(JSON.stringify({ schema_version: 1, kind: KIND, turns: pruneTurns(turns, now) }), 'utf8');
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
const string = (value: unknown, maximum = 20_000): value is string => typeof value === 'string' && value.length <= maximum;
const index = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
/** How many statements, places or sources a stored answer may hold: far more than an answer's 64 KiB carries, as an answer has no count of its own (ADR-0051). */
const MOST = 1_000;
const indexes = (value: unknown, maximum = MOST): value is number[] => Array.isArray(value) && value.length <= maximum && value.every(index);
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const projectId = (value: unknown): boolean => { try { validateProjectIdV1(value); return true; } catch { return false; } };
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const time = (value: unknown): value is string => string(value, 64) && !Number.isNaN(Date.parse(value));
const STATUSES: ReadonlySet<unknown> = new Set(['answered', 'partial', 'not_found', 'records_only']);
const OUTCOMES: ReadonlySet<unknown> = new Set(['answered', 'partial', 'not_found']);
/** What a card may show (answer layout v2, ADR-0051). */
const ENTITIES: ReadonlySet<unknown> = new Set(PERSON_ANSWER_CARD_ENTITIES_V2);

function scope(value: unknown): value is AskScope {
  if (!record(value)) return false;
  const keys = Object.keys(value).sort().join();
  return value.kind === 'project' ? keys === 'kind,project_id' && projectId(value.project_id) : value.kind === 'global' && keys === 'kind';
}

function statement(value: unknown): value is AnswerStatement {
  return record(value) && string(value.text) && indexes(value.citation_indexes) && typeof value.private === 'boolean';
}
const statements = (value: unknown, maximum = MOST): value is AnswerStatement[] => Array.isArray(value) && value.length <= maximum && value.every(statement);

/**
 * A source, by what the page reads of its kind to show and open it: anything
 * else would break the page that shows it. What it cited is kept as the
 * answer had it, with the evidence citation whose kind says whether a check
 * asks about it.
 */
function source(value: unknown): value is AnswerSource {
  if (!record(value) || !string(value.label, 2_000)) return false;
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
    case 'ticket': case 'page': return string(value.tool_id) && string(value.permalink, 2_048);
    case 'container': return string(value.tool_id) && string(value.permalink, 2_048) && string(value.container) && (value.key === undefined || string(value.key));
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
  timeline: block => each(block, block.events, event => string(event.date, 64) && string(event.text) && (event.who === undefined || string(event.who))),
  card: block => string(block.title) && ENTITIES.has(block.entity) && each(block, block.facts, fact => string(fact.label) && string(fact.value)),
  quote: block => (block.statements as unknown[]).length === 1 && string(block.text) && (block.from === undefined || string(block.from)),
};

/**
 * A part's blocks (answer layout v2, ADR-0051), each of a kind the page
 * draws, its sentences among the part's own and its title a text: the page
 * reads an item by its sentence's place.
 */
function arranged(value: unknown, count: number): boolean {
  return Array.isArray(value) && value.length <= MOST && value.every(block => record(block) && typeof block.kind === 'string' && Object.hasOwn(ARRANGED, block.kind)
    && within(block.statements, count) && (block.title === undefined || string(block.title)) && ARRANGED[block.kind as ArrangedBlock['kind']](block));
}

function gapDetails(value: unknown): boolean {
  try { validatePersonAnswerGapDetailsV1(value); return true; } catch { return false; }
}

/**
 * An answer as the timeline keeps it: what the page reads back of a turn
 * (TimelineAnswer). A part with statements has them in blocks (answer layout
 * v2, ADR-0051), and one with none has nothing to arrange.
 */
function answer(value: unknown): value is TimelineAnswer {
  if (!record(value) || !scope(value.scope) || !OUTCOMES.has(value.outcome)) return false;
  if (!Array.isArray(value.sources) || value.sources.length > MOST || !value.sources.every(source)) return false;
  if (value.direct !== undefined && !statement(value.direct)) return false;
  return Array.isArray(value.parts) && value.parts.length <= 64 && value.parts.every(part => record(part) && string(part.question) && STATUSES.has(part.status)
    && statements(part.statements) && (part.gap === undefined || string(part.gap)) && (part.gap_details === undefined || gapDetails(part.gap_details)) && (part.records === undefined || statements(part.records))
    && (part.blocks === undefined ? part.statements.length === 0 : part.statements.length > 0 && arranged(part.blocks, part.statements.length)));
}

/**
 * A turn an older desktop saved that no page draws now, dropped on read while
 * the rest of its file stays: one asked in Mine (ADR-0049), or one with a part
 * whose statements have no blocks, plain or laid out by answer layout v1
 * (ADR-0045, ADR-0051).
 */
function retired(turn: unknown): boolean {
  const parts = record(turn) && record(turn.answer) && Array.isArray(turn.answer.parts) ? turn.answer.parts : [];
  return (record(turn) && record(turn.scope) && turn.scope.kind === 'mine')
    || parts.some(part => record(part) && (Object.hasOwn(part, 'layout') || (part.blocks === undefined && Array.isArray(part.statements) && part.statements.length > 0)));
}

/** A turn as a put writes it, or null for anything else. */
export function timelineTurn(value: unknown): TimelineTurn | null {
  if (!record(value) || !string(value.id) || !ID.test(value.id) || !time(value.asked_at) || !string(value.text, 2_000) || !string(value.question, 2_000)
      || !scope(value.scope) || !answer(value.answer)) return null;
  if (value.since !== undefined && !statements(value.since)) return null;
  if (value.again_of !== undefined && !(string(value.again_of) && ID.test(value.again_of))) return null;
  if (value.markers !== undefined && !(record(value.markers) && Object.entries(value.markers).every(([at, marker]) => /^\d{1,3}$/.test(at) && string(marker) && SHA256.test(marker)))) {
    return null;
  }
  // The sources a check found unreadable: distinct places among the answer's own sources.
  const sources = (value.answer as TimelineAnswer).sources.length;
  if (value.unreadable !== undefined && !(indexes(value.unreadable, 256) && new Set(value.unreadable).size === value.unreadable.length
      && value.unreadable.every(at => at < sources))) {
    return null;
  }
  return value as unknown as TimelineTurn;
}
