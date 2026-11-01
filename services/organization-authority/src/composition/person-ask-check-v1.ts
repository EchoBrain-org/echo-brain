import type Database from 'better-sqlite3';
import { sha256Digest, type Sha256Digest } from '@echo-brain/federation-protocol';
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
import type { ImpactItemRowV1, SqliteImpactItemsV1 } from '../adapters/persistence/sqlite/impact-items-v1.js';
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
 * answers, for each, whether it is the `same`, `changed`, `unreadable` or `unknown`. Readability comes first, through the
 * policy of the read each source stands for, so `changed` and a ticket's marker only ever come for a source the caller can
 * read now, and `unreadable` never says whether a source is hidden, deleted or never existed (ADR-0012). The answer carries
 * no label, text, count or id.
 *
 * - `approved_record`: the Layer 1 exact read with the caller's current grants (`readableDecisionProjects`), with no search
 *   generation. Records are immutable, so a readable one is always the same.
 * - `source_revision`: the originals ACL under global access (`checkSourceRevisions`); changed when a newer readable revision
 *   of the same source exists, as for an imported meeting edited since. Notes and documents never change.
 * - `follow_up`: the open item through the open-items policy (`see_row`), as `runs` `item` reads it; changed when its owner,
 *   state or send moved after the turn was asked.
 * - `ticket`: read in bulk through the caller's own connection to its tool; changed when its marker differs from the
 *   request's. Without one it is the same, and its marker is the asker's baseline.
 * - `page`: its version read by id through the caller's own connection; changed when the version moved and the cited
 *   section's text is no longer on the page (any move for an inventory item, which cites no text).
 *
 * The database kinds are read in one Authority read transaction: no `BEGIN IMMEDIATE`, no audit row, nothing written, since
 * the check releases nothing. The live kinds follow, each tool on its own and all within the deadline. A source whose tool
 * is not connected or fails, or that runs past the budget (two metadata calls per tool, ten page bodies per request) or the
 * deadline, is `unknown`, and the failure is reported without content.
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
export interface PersonAskCheckLiveFailureV1 { readonly kind: 'person_ask_check_live_read'; readonly reason: 'tickets' | 'pages' | 'page_bodies'; readonly code: string }

/** The live budget (Ask timeline v1, C1): per tool two metadata calls of 50 ids, per request ten page bodies and 15 seconds. */
const PERSON_ASK_CHECK_LIVE_BUDGET_V1 = Object.freeze({ ids_per_tool: 100, page_bodies: 10, deadline_ms: 15_000 });

const SAME: PersonAskCheckItemV1 = Object.freeze({ state: 'same' });
const CHANGED: PersonAskCheckItemV1 = Object.freeze({ state: 'changed' });
const UNREADABLE: PersonAskCheckItemV1 = Object.freeze({ state: 'unreadable' });
const UNKNOWN: PersonAskCheckItemV1 = Object.freeze({ state: 'unknown' });
/** What a page inventory or continuation item cites as its text: none. */
const EMPTY_TEXT_SHA256 = sha256Digest('');

type CheckedCitation<K extends PersonAnswerEvidenceCitationV8['kind']> = Extract<PersonAnswerEvidenceCitationV8, { readonly kind: K }>;
interface Entry<C> { readonly index: number; readonly item: PersonAskCheckRequestItemV1; readonly citation: C }

/** The request's items of one kind, with their places. */
function entriesOf<K extends PersonAnswerEvidenceCitationV8['kind']>(items: readonly PersonAskCheckRequestItemV1[], kind: K): Entry<CheckedCitation<K>>[] {
  return items.flatMap((item, index) => (item.citation.kind === kind ? [{ index, item, citation: item.citation as CheckedCitation<K> }] : []));
}

/** The first distinct ids, in request order, that one tool's two metadata calls read. */
function budgeted(ids: readonly string[]): ReadonlySet<string> {
  return new Set([...new Set(ids)].slice(0, PERSON_ASK_CHECK_LIVE_BUDGET_V1.ids_per_tool));
}

/** When a follow-up's row last moved: the latest of its owner, state and send times; undefined while none was set. */
function lastMoved(row: Pick<ImpactItemRowV1, 'owner_set_at' | 'state_set_at' | 'sent_at'>): number | undefined {
  const times = [row.owner_set_at, row.state_set_at, row.sent_at].flatMap(at => (at === null ? [] : [Date.parse(at)]));
  return times.length === 0 ? undefined : Math.max(...times);
}

/** Resolves when the signal aborts. */
function aborted(signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

export function createPersonAskCheckV1(options: CreatePersonAskCheckV1Options): PersonAskCheckHttpApplicationV1 {
  const deadlineMs = options.deadline_ms ?? PERSON_ASK_CHECK_LIVE_BUDGET_V1.deadline_ms;
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
      originals.forEach(({ index }, at) => { answers[index] = states[at] === 'same' ? SAME : states[at] === 'changed' ? CHANGED : UNREADABLE; });
    }
    const followUps = entriesOf(items, 'follow_up');
    if (followUps.length > 0) {
      const found = options.items.readMany(followUps.map(({ citation }) => citation.item_id));
      const seen = new Map(assessOpenItemsV1({ records, people: options.people }, openItemViewerV1(access_token, authorization), [...found.values()]).assessed
        .filter(entry => entry.access.see_row).map(entry => [entry.row.item_id, entry.row] as const));
      for (const { index, item, citation } of followUps) {
        const row = seen.get(citation.item_id);
        const moved = row === undefined ? undefined : lastMoved(row);
        answers[index] = row === undefined ? UNREADABLE : moved !== undefined && moved > Date.parse(item.asked_at) ? CHANGED : SAME;
      }
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
        if (entry.citation.external_scope_id !== check.external_scope_id) answers[entry.index] = UNREADABLE;
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
        const bodies = { remaining: PERSON_ASK_CHECK_LIVE_BUDGET_V1.page_bodies };
        const readTickets = async (check: PersonTicketCheckV1, entries: readonly Entry<PersonTicketCitationV1>[]): Promise<void> => {
          const ids = budgeted(entries.map(({ citation }) => citation.ticket_id));
          const markers = await check.markers({ access_token, ticket_ids: [...ids], signal });
          for (const { index, item, citation } of entries) {
            if (!ids.has(citation.ticket_id)) continue;
            const marker = markers.get(citation.ticket_id);
            // Without a marker of its own, the asker takes the ticket's current one as its baseline. A ticket read with no marker
            // to compare is readable, but nothing is known of it.
            answers[index] = marker === undefined ? UNREADABLE : marker === null ? UNKNOWN
              : Object.freeze({ state: item.marker === undefined || item.marker === marker ? 'same' : 'changed', marker });
          }
        };
        const readPages = async (check: PersonPageCheckV1, entries: readonly Entry<PersonPageCitationV1>[]): Promise<void> => {
          const ids = budgeted(entries.map(({ citation }) => citation.page_id));
          const versions = await check.versions({ access_token, page_ids: [...ids], signal });
          const compared: Entry<PersonPageCitationV1>[] = [];
          for (const entry of entries) {
            const { index, citation } = entry;
            if (!ids.has(citation.page_id)) continue;
            const version = versions.get(citation.page_id);
            if (version === undefined) answers[index] = UNREADABLE;
            else if (version === citation.version) answers[index] = SAME;
            else if (citation.text_sha256 === EMPTY_TEXT_SHA256) answers[index] = CHANGED;
            else compared.push(entry);
          }
          // The request's page bodies go to the first pages that need one; the others stay unknown.
          const read = new Set<string>();
          for (const { citation } of compared) {
            if (!read.has(citation.page_id) && bodies.remaining > 0) { read.add(citation.page_id); bodies.remaining -= 1; }
          }
          if (read.size === 0) return;
          let sections: ReadonlyMap<string, readonly Sha256Digest[] | null>;
          try { sections = await check.sections({ access_token, page_ids: [...read], signal }); }
          catch (error) { failed('page_bodies', error); return; }
          for (const { index, citation } of compared) {
            if (!read.has(citation.page_id)) continue;
            const digests = sections.get(citation.page_id);
            // Section numbers move when an edit above adds or removes one: the cited text anywhere on the page is unchanged.
            answers[index] = digests === undefined ? UNREADABLE : digests === null ? UNKNOWN : digests.includes(citation.text_sha256) ? SAME : CHANGED;
          }
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
