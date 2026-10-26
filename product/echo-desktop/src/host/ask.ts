// An Ask on the host (ADR-0039): the client commands it runs (the Ask, and
// the reads of what it cites), and the reader of the progress lines the Ask
// prints while it works. Kept apart from host.ts so the whole path, Authority
// to page, is tested as it runs.
import {
  validatePersonAnswerCitationV8, validatePersonFollowUpCitationV1, validatePersonPageCitationV1, validatePersonSourceRevisionCitationV1, validatePersonTicketCitationV1,
} from '@echo-brain/organization-api';
import {
  CHECK_KINDS, MAX_CHECK_ITEMS, MAX_CHECK_REQUEST_BYTES, PREVIOUS_LIMITS, type AskCheckItem, type AskPrevious, type AskProgressNotice, type AskScope, type AskStep,
  type CheckCitation, type Expect, type RecordRef, type SourceRef,
} from '../shared/protocol.js';
import { askText } from '../shared/query.js';
import { jsonLines } from './cli.js';
import { askStepView } from './views.js';

/**
 * The client command for an Ask of `text` (already askText's), for the
 * account the page shows. Every Ask, Mine as much as global or project, asks
 * the newest route and its progress, pinned to that account: a client signed
 * in as another by then asks nothing and prints no step, so the page's
 * account check of each step is the client's own. An older Authority answers
 * on its newest route, and one that predates progress with none. A follow-up
 * or Ask again carries the earlier turn (`previous`, ADR-0047), already
 * checked by askPrevious; the client sends it only on `/v7`.
 */
export function askArgv(text: string, scope: AskScope, expect: Expect, previous?: AskPrevious): string[] {
  return ['ask', `--question=${text}`, '--live', '--progress', `--expected-membership-id=${expect.membership_id}`, `--expected-authority=${expect.authority}`,
    ...(scope.kind === 'project' ? [`--project=${scope.project_id}`] : scope.kind === 'mine' ? ['--mine'] : []),
    ...(previous === undefined ? [] : [`--previous=${JSON.stringify(previous)}`])];
}

type Json = Record<string, unknown>;
const record = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);
/** An ISO 8601 UTC time with milliseconds, as the API writes times. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const instant = (value: unknown): value is string => typeof value === 'string' && ISO.test(value) && new Date(value).toISOString() === value;
const checks = (validate: (value: unknown) => unknown, value: unknown): boolean => { try { validate(value); return true; } catch { return false; } };

/**
 * The earlier turn an Ask carries, as C3 bounds it, or null for anything else:
 * a purpose, the earlier full question (as askText would send it), when it was
 * asked, 0 to 8 sentences of at most 400 characters each citing at most 4 of
 * its 0 to 12 distinct citations, each once, and those citations as the API's
 * own validator takes them. The client checks it again, and an Authority checks
 * the whole body.
 */
export function askPrevious(value: unknown): AskPrevious | null {
  if (!record(value) || Object.keys(value).sort().join() !== 'asked_at,citations,purpose,question,statements') return null;
  const { purpose, question, asked_at: askedAt, statements, citations } = value;
  if ((purpose !== 'follow_up' && purpose !== 'ask_again') || typeof question !== 'string' || question === '' || askText(question) !== question || !instant(askedAt)) return null;
  if (!Array.isArray(citations) || citations.length > PREVIOUS_LIMITS.citations || !citations.every(citation => checks(validatePersonAnswerCitationV8, citation))) return null;
  // Each citation once.
  if (new Set(citations.map(citation => JSON.stringify(citation))).size !== citations.length) return null;
  if (!Array.isArray(statements) || statements.length > PREVIOUS_LIMITS.statements) return null;
  // Each sentence at most 400 characters as the API counts them (code points), citing each of its citations once.
  const said = statements.every(statement => record(statement) && Object.keys(statement).sort().join() === 'citation_indexes,text'
    && typeof statement.text === 'string' && statement.text.trim() !== '' && [...statement.text].length <= PREVIOUS_LIMITS.statement_chars
    && Array.isArray(statement.citation_indexes) && statement.citation_indexes.length <= PREVIOUS_LIMITS.statement_citations
    && new Set(statement.citation_indexes).size === statement.citation_indexes.length
    && statement.citation_indexes.every(at => Number.isSafeInteger(at) && at >= 0 && at < citations.length));
  return said ? value as unknown as AskPrevious : null;
}

/** A checkable source's evidence citation, by the API's own validator for its kind. */
function checkCitation(value: unknown): value is CheckCitation {
  if (!record(value) || !(CHECK_KINDS as readonly unknown[]).includes(value.kind)) return false;
  switch (value.kind) {
    case 'ticket': return checks(validatePersonTicketCitationV1, value);
    case 'page': return checks(validatePersonPageCitationV1, value);
    case 'follow_up': return checks(validatePersonFollowUpCitationV1, value);
    case 'source_revision': return checks(citation => validatePersonSourceRevisionCitationV1(citation, 'optional'), value);
    default: return Object.keys(value).sort().join() === 'atom_id,kind,policy_id,record_sha256'
      && [value.atom_id, value.record_sha256].every(digest => typeof digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(digest))
      && typeof value.policy_id === 'string' && value.policy_id.length <= 128;
  }
}

/**
 * The request a check sends (C1), or null when the page's items are not one:
 * 1 to 100 items, each when its turn was asked, a checkable citation, and a
 * ticket's marker, within the route's 64 KiB.
 */
export function askCheckRequest(items: unknown): string | null {
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_CHECK_ITEMS) return null;
  const valid = items.every((item: unknown) => record(item) && instant(item.asked_at) && checkCitation(item.citation)
    && Object.keys(item).sort().join() === (item.marker === undefined ? 'asked_at,citation' : 'asked_at,citation,marker')
    && (item.marker === undefined || (typeof item.marker === 'string' && /^sha256:[0-9a-f]{64}$/.test(item.marker) && (item.citation as Json).kind === 'ticket')));
  if (!valid) return null;
  const request = JSON.stringify({ schema_version: 1, kind: 'echo-person-ask-check-request-v1', items: items as AskCheckItem[] });
  return Buffer.byteLength(request) <= MAX_CHECK_REQUEST_BYTES ? request : null;
}

/** The client command for a check (C1): it validates the request, posts it, and prints the validated response last. */
export function askCheckArgv(request: string): string[] {
  return ['ask-check', `--request=${request}`];
}

/** The client command that reads a cited meeting's approved record, for the pane to light the cited items. */
export function askRecordArgv(record: RecordRef): string[] {
  return ['records', `--record-sha256=${record.record_sha256}`];
}

/**
 * The client command that reads one cited passage of an original, where it
 * was cited: in the project asked, or else under all you may read. What you
 * added is a part of that, so a mine answer's sources read there.
 */
export function askSourceArgv(ref: SourceRef, scope: AskScope): string[] {
  return ['ask-source', `--source-id=${ref.source_id}`, `--revision-id=${ref.revision_id}`, `--source-sha256=${ref.source_sha256}`,
    `--representation-sha256=${ref.representation_sha256}`, `--anchor-sha256=${ref.anchor_sha256}`, ...(ref.document_id ? [`--document-id=${ref.document_id}`] : []),
    ...(scope.kind === 'project' ? [`--project=${scope.project_id}`] : [])];
}

/**
 * An Ask's progress lines: each step the page shows while the Ask runs,
 * posted tagged with the account it runs for and the page's own cancel id,
 * so the page drops a step of any other Ask or account. A line that is not a
 * valid step (`refused` hears of it), and any line once the Ask was cancelled
 * or timed out, goes nowhere.
 */
export function askProgressLines(cancelId: string, expect: Expect, abortSignal: AbortSignal, post: (notice: AskProgressNotice) => void,
  refused: () => void = () => undefined): (line: string) => void {
  const account = { authority: expect.authority, membership_id: expect.membership_id };
  return line => {
    if (abortSignal.aborted) return;
    for (const value of jsonLines(line)) {
      if (value === null || typeof value !== 'object' || !Object.hasOwn(value, 'progress')) continue;
      let step: AskStep;
      try {
        step = askStepView(value);
      } catch {
        refused();
        continue;
      }
      post({ cancel_id: cancelId, expect: account, step });
    }
  };
}
