import type Database from 'better-sqlite3';
import {
  PERSON_ASK_CHECK_KIND_V1,
  validatePersonAskCheckV1,
  type PersonAnswerEvidenceCitationV8,
  type PersonAskCheckItemV1,
  type PersonAskCheckRequestItemV1,
  type PersonAskCheckV1,
  type PersonPageCitationV1,
  type PersonTicketCitationV1,
} from '@echo-brain/organization-api';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { SqliteImpactItemsV1 } from '../adapters/persistence/sqlite/impact-items-v1.js';
import type { SqliteOpenItemPeopleV1 } from '../adapters/persistence/sqlite/open-item-people-v1.js';
import type { SqlitePersonOriginalContextRetrievalV1 } from '../adapters/persistence/sqlite/person-original-context-retrieval-v1.js';
import type { SqliteProjectContextRepositoryV1 } from '../adapters/persistence/sqlite/project-context-v1.js';
import type { PersonPageCheckV1, PersonSourceCheckV1, PersonTicketCheckV1 } from '../application/ports/person-source-check-v1.js';
import type { PersonAskCheckHttpApplicationV1 } from '../presentation/person-ask-check-http-application.js';
import { assessOpenItemsV1, errorCodeV1, observeEventV1, openItemDecisionsReaderV1, openItemViewerV1 } from './person-open-items-v1.js';
import { recordProjectAuthorizationOfGrantsV1, type RecordProjectAuthorizationV1 } from './person-record-project-scope-v1.js';
import type { PersonReadableDecisionProjectsV1 } from './person-record-search-route.js';

/**
 * The Ask source check (Ask timeline v1, C1; ADR-0047): `POST /v1/person/ask/check` takes the sources old answers cited and
 * answers, for each, only whether the caller can read it now: `same` when they can, `unreadable` when they cannot, `unknown`
 * when its tool cannot tell. Readability goes through the policy of the read each source stands for, and
 * `unreadable` never says whether a source is hidden, deleted or never existed (ADR-0012). The answer carries no label,
 * text, count or id.
 *
 * - `approved_record`: the Layer 1 exact read with the caller's current grants (`readableDecisionProjects`), with no search
 *   generation.
 * - `source_revision`: the cited revision through the originals ACL under global access (`checkSourceRevisions`).
 * - `follow_up`: the open item through the open-items policy (`see_row`), as `runs` `item` reads it.
 * - `ticket`: read in bulk through the caller's own connection to its tool; no ticket field is read.
 * - `page`: its version read by id through the caller's own connection; no page body is read.
 *
 * The database kinds are read in one Authority read transaction: no `BEGIN IMMEDIATE`, no audit row, nothing written, since
 * the check releases nothing. The live kinds follow, each tool on its own and all within the deadline. A source whose tool
 * is not connected or fails, or that runs past the deadline, is `unknown`, and the failure is reported without content.
 */
export interface CreatePersonAskCheckV1Options {
  /** The Authority database the database kinds are read from; the check's one read transaction is opened on it. */
  readonly database: Database.Database;
  readonly sessions: { authenticateAccess(input: { readonly access_token: string }): PersonAccessAuthorization };
  /** The caller's project grants, for the record check, read inside the check's own read transaction. */
  readonly projects: Pick<SqliteProjectContextRepositoryV1, 'personChangeView'>;
  readonly records: PersonReadableDecisionProjectsV1;
  readonly originals: Pick<SqlitePersonOriginalContextRetrievalV1, 'checkSourceRevisions'>;
  readonly items: Pick<SqliteImpactItemsV1, 'readMany'>;
  readonly people: Pick<SqliteOpenItemPeopleV1, 'people' | 'leadsAny'>;
  /** Each connected tool's own check, one per tool and kind; none when no live connector is configured. */
  readonly live?: readonly PersonSourceCheckV1[];
  /** Where a live read that failed or ran out of time is reported; one content-free line of JSON on standard error by default. */
  readonly on_live_failure?: (event: PersonAskCheckLiveFailureV1) => void;
  /** The live reads' deadline: the contract's 15 seconds, unless a test shortens it. */
  readonly deadline_ms?: number;
}
/** A live read the check could not finish: which read, and the error's Authority code (`error` otherwise) or `deadline`. Nothing else. */
export interface PersonAskCheckLiveFailureV1 { readonly kind: 'person_ask_check_live_read'; readonly reason: 'tickets' | 'pages'; readonly code: string }

/** The live reads' deadline (Ask timeline v1, C1): 15 seconds per request. */
const PERSON_ASK_CHECK_DEADLINE_MS_V1 = 15_000;

const SAME: PersonAskCheckItemV1 = Object.freeze({ state: 'same' });
const UNREADABLE: PersonAskCheckItemV1 = Object.freeze({ state: 'unreadable' });
const UNKNOWN: PersonAskCheckItemV1 = Object.freeze({ state: 'unknown' });

type CheckedCitation<K extends PersonAnswerEvidenceCitationV8['kind']> = Extract<PersonAnswerEvidenceCitationV8, { readonly kind: K }>;
interface Entry<C> { readonly index: number; readonly citation: C }

/** The request's items of one kind, with their places. */
function entriesOf<K extends PersonAnswerEvidenceCitationV8['kind']>(items: readonly PersonAskCheckRequestItemV1[], kind: K): Entry<CheckedCitation<K>>[] {
  return items.flatMap((item, index) => (item.citation.kind === kind ? [{ index, citation: item.citation as CheckedCitation<K> }] : []));
}

/** Resolves when the signal aborts. */
function aborted(signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

export function createPersonAskCheckV1(options: CreatePersonAskCheckV1Options): PersonAskCheckHttpApplicationV1 {
  const deadlineMs = options.deadline_ms ?? PERSON_ASK_CHECK_DEADLINE_MS_V1;
  const report = (reason: PersonAskCheckLiveFailureV1['reason'], code: string): void =>
    observeEventV1(options.on_live_failure, Object.freeze({ kind: 'person_ask_check_live_read' as const, reason, code }));
  const checkOf = (kind: 'ticket' | 'page', toolId: string): PersonSourceCheckV1 | undefined =>
    options.live?.find(check => check.kind === kind && check.tool_id === toolId);

  /** The database kinds, in one Authority read transaction, into `answers`. */
  function readDatabase(access_token: string, items: readonly PersonAskCheckRequestItemV1[], answers: (PersonAskCheckItemV1 | undefined)[]): void {
    const authorization = options.sessions.authenticateAccess({ access_token });
    let grants: RecordProjectAuthorizationV1 | undefined;
    // The record checks read the grants read in this transaction (a capture of its own would need a transaction of its own),
    // and each record once: a cited record and a cited follow-up's record are one lookup.
    const records = openItemDecisionsReaderV1(options.records, access_token, () => (grants ??= recordProjectAuthorizationOfGrantsV1(options.projects.personChangeView(authorization).grants)));
    const decisions = entriesOf(items, 'approved_record');
    if (decisions.length > 0) {
      const readable = records.readableDecisions({ access_token, record_sha256s: [...new Set(decisions.map(({ citation }) => citation.record_sha256))] });
      for (const { index, citation } of decisions) answers[index] = readable.has(citation.record_sha256) ? SAME : UNREADABLE;
    }
    const originals = entriesOf(items, 'source_revision');
    if (originals.length > 0) {
      const states = options.originals.checkSourceRevisions({ access_token, citations: originals.map(({ citation }) => citation) });
      originals.forEach(({ index }, at) => { answers[index] = states[at] === 'same' ? SAME : UNREADABLE; });
    }
    const followUps = entriesOf(items, 'follow_up');
    if (followUps.length > 0) {
      const found = options.items.readMany(followUps.map(({ citation }) => citation.item_id));
      const seen = new Set(assessOpenItemsV1({ records, people: options.people }, openItemViewerV1(access_token, authorization), [...found.values()]).assessed
        .filter(entry => entry.access.see_row).map(entry => entry.row.item_id));
      for (const { index, citation } of followUps) answers[index] = seen.has(citation.item_id) ? SAME : UNREADABLE;
    }
  }

  return Object.freeze({
    async check(input: Parameters<PersonAskCheckHttpApplicationV1['check']>[0]): Promise<PersonAskCheckV1> {
      input.signal?.throwIfAborted();
      const started = performance.now();
      if (options.database.inTransaction) throw new Error('The Ask source check opens its own read transaction');
      const { access_token, request: { items } } = input;
      const answers: (PersonAskCheckItemV1 | undefined)[] = items.map(() => undefined);
      options.database.transaction(() => { readDatabase(access_token, items, answers); }).deferred();

      // Tickets and pages, grouped by the tool whose own check reads them. A tool this Authority does not connect leaves its
      // sources unknown; one on another site than the tool's is never readable through it.
      const tickets = new Map<PersonTicketCheckV1, Entry<PersonTicketCitationV1>[]>();
      const pages = new Map<PersonPageCheckV1, Entry<PersonPageCitationV1>[]>();
      const group = <C, K>(groups: Map<K, Entry<C>[]>, check: K, entry: Entry<C>): void => { groups.set(check, [...(groups.get(check) ?? []), entry]); };
      for (const entry of [...entriesOf(items, 'ticket'), ...entriesOf(items, 'page')]) {
        const check = checkOf(entry.citation.kind, entry.citation.tool_id);
        if (check === undefined) continue;
        if (entry.citation.external_scope_id !== (typeof check.external_scope_id === 'function' ? check.external_scope_id(access_token) : check.external_scope_id)) answers[entry.index] = UNREADABLE;
        else if (check.kind === 'ticket') group(tickets, check, entry as Entry<PersonTicketCitationV1>);
        else group(pages, check, entry as Entry<PersonPageCitationV1>);
      }
      if (tickets.size + pages.size > 0) {
        const deadline = new AbortController();
        const signal = input.signal === undefined ? deadline.signal : AbortSignal.any([input.signal, deadline.signal]);
        let timedOut = false;
        // A cancelled request is not an outage, and reports nothing.
        const failed = (reason: PersonAskCheckLiveFailureV1['reason'], error: unknown): void => {
          if (input.signal?.aborted !== true) report(reason, timedOut ? 'deadline' : errorCodeV1(error));
        };
        // Each tool reads each distinct id once, in request order: a request's at most 100 items keep it to its two metadata
        // calls of 50 ids.
        const readTickets = async (check: PersonTicketCheckV1, entries: readonly Entry<PersonTicketCitationV1>[]): Promise<void> => {
          const readable = await check.readable({ access_token, ticket_ids: [...new Set(entries.map(({ citation }) => citation.ticket_id))], signal });
          for (const { index, citation } of entries) answers[index] = readable.has(citation.ticket_id) ? SAME : UNREADABLE;
        };
        const readPages = async (check: PersonPageCheckV1, entries: readonly Entry<PersonPageCitationV1>[]): Promise<void> => {
          const versions = await check.versions({ access_token, page_ids: [...new Set(entries.map(({ citation }) => citation.page_id))], signal });
          for (const { index, citation } of entries) answers[index] = versions.has(citation.page_id) ? SAME : UNREADABLE;
        };
        const reads = [
          ...[...tickets].map(([check, entries]) => readTickets(check, entries).catch(error => { failed('tickets', error); })),
          ...[...pages].map(([check, entries]) => readPages(check, entries).catch(error => { failed('pages', error); })),
        ];
        // The deadline counts from the start of the request, the database read included.
        const timer = setTimeout(() => { timedOut = true; deadline.abort(new AuthorityOperationError('unavailable', 'The Ask source check ran out of time')); },
          Math.max(0, deadlineMs - (performance.now() - started)));
        // The response is built as soon as this race ends (every read done, the deadline or a cancel): a read that answers later
        // answers nothing, and its sources stay unknown.
        try {
          await Promise.race([Promise.all(reads), aborted(signal)]);
        } finally {
          clearTimeout(timer);
          // Whatever is still reading stops.
          deadline.abort();
        }
      }
      input.signal?.throwIfAborted();
      try {
        return validatePersonAskCheckV1({ schema_version: 1, kind: PERSON_ASK_CHECK_KIND_V1, items: answers.map(answer => answer ?? UNKNOWN) }, input.request);
      } catch {
        throw new AuthorityOperationError('invalid_output', 'Ask check response is invalid');
      }
    },
  });
}
