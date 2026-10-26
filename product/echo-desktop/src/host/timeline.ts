// The Ask timeline's file (ADR-0047): one per account, beside the person
// session, readable by its owner only. The Authority never sees it. A put
// keeps one turn (a new one at the end, an old one in its place), then drops
// turns past 90 days and all but the newest 200; it writes a private temporary
// file and renames it over the old one, so a reader never meets half a file.
// A file that cannot be read, or is not what a put writes, reads as empty and
// is replaced by the next put. Our own sign-out deletes the account's file;
// reading one account's timeline deletes any other account's, so an account
// change leaves nothing of the last one here. Kept apart from host.ts so all
// of it is tested on a real folder.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAX_TIMELINE_PUT_BYTES, MAX_TIMELINE_TURNS, TIMELINE_DAYS, type AnswerSource, type AnswerStatement, type AskScope, type Expect, type TimelineAnswer,
  type TimelineTurn,
} from '../shared/protocol.js';

/** The folder's name, inside the person client's own data folder. */
export const TIMELINE_FOLDER = 'ask-timeline-v1';
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
    const turns = file.turns.map(timelineTurn);
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
const indexes = (value: unknown, maximum = 64): value is number[] => Array.isArray(value) && value.length <= maximum && value.every(index);
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROJECT = /^prj_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const time = (value: unknown): value is string => string(value, 64) && !Number.isNaN(Date.parse(value));
const STATUSES: ReadonlySet<unknown> = new Set(['answered', 'partial', 'not_found', 'records_only']);
const OUTCOMES: ReadonlySet<unknown> = new Set(['answered', 'partial', 'not_found']);
const BLOCKS: ReadonlySet<unknown> = new Set(['lead', 'heading', 'paragraph', 'bullets', 'table']);

function scope(value: unknown): value is AskScope {
  if (!record(value)) return false;
  const keys = Object.keys(value).sort().join();
  return value.kind === 'project' ? keys === 'kind,project_id' && string(value.project_id) && PROJECT.test(value.project_id)
    : (value.kind === 'global' || value.kind === 'mine') && keys === 'kind';
}

function statement(value: unknown): value is AnswerStatement {
  return record(value) && string(value.text) && indexes(value.citation_indexes) && typeof value.private === 'boolean';
}
const statements = (value: unknown, maximum = 64): value is AnswerStatement[] => Array.isArray(value) && value.length <= maximum && value.every(statement);

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

/** A part's layout, each block's sentences among the part's own: the page reads them by their place. */
function layout(value: unknown, count: number): boolean {
  const within = (places: unknown) => indexes(places) && (places as number[]).every(place => place < count);
  return Array.isArray(value) && value.length <= 64 && value.every(block => record(block) && BLOCKS.has(block.kind) && (block.kind === 'heading' ? string(block.text)
    : block.kind !== 'table' ? within(block.statements)
      : within(block.statements) && Array.isArray(block.columns) && block.columns.every(column => string(column)) && (block.caption === undefined || string(block.caption))
        && Array.isArray(block.rows) && block.rows.every(row => record(row) && Array.isArray(row.cells) && row.cells.every(cell => string(cell)) && indexes(row.citation_indexes))));
}

/** An answer as the timeline keeps it: what the page reads back of a turn (TimelineAnswer). */
function answer(value: unknown): value is TimelineAnswer {
  if (!record(value) || !string(value.text, 200_000) || !scope(value.scope) || !OUTCOMES.has(value.outcome)) return false;
  if (!Array.isArray(value.sources) || value.sources.length > 256 || !value.sources.every(source)) return false;
  if (value.direct !== undefined && !statement(value.direct)) return false;
  return Array.isArray(value.parts) && value.parts.length <= 64 && value.parts.every(part => record(part) && string(part.question) && STATUSES.has(part.status)
    && statements(part.statements) && (part.gap === undefined || string(part.gap)) && (part.records === undefined || statements(part.records))
    && (part.layout === undefined || layout(part.layout, (part.statements as unknown[]).length)));
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
  return value as unknown as TimelineTurn;
}
