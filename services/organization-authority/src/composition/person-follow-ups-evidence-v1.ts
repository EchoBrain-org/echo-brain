import { canonicalSha256, type Sha256Digest } from '@echo-brain/federation-protocol';
import {
  PERSON_FOLLOW_UP_EVIDENCE_LIMITS_V1 as LIMITS,
  validatePersonFollowUpEvidenceV1,
  type PersonFollowUpEvidenceV1,
} from '@echo-brain/organization-api';
import { impactCardLineV1 } from '@echo-brain/organization-authority-kernel/answer-composition/renderers/impact-card-storage-v1';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { EvidenceDeskRevalidateInputV1, EvidenceDeskVisibilityV1 } from '@echo-brain/organization-authority-kernel/shared/evidence-desk-v1';
import type { EvidenceDeskItemV2, EvidenceDeskListInputV2, EvidenceDeskPortV2, EvidenceDeskResultV2, EvidenceDeskUncheckedV1 } from '@echo-brain/organization-authority-kernel/shared/evidence-desk-v2';
import {
  FOLLOW_UP_EVIDENCE_KIND_V1,
  FOLLOW_UPS_LIMITS_V1,
  FOLLOW_UPS_SOURCE_DESCRIPTOR_V1,
  followUpDeskFieldsV1,
  followUpInStatusV1,
  followUpOwnerMatchesV1,
  type FollowUpsSourceDescriptorV1,
} from '@echo-brain/organization-authority-kernel/shared/follow-up-evidence-v1';
import {
  EVIDENCE_ANY_DATE_V1,
  matchesEvidenceDateV1,
  validateEvidenceDateFilterV1,
  type EvidenceDateFilterV1,
  type EvidenceDatesV1,
} from '@echo-brain/organization-authority-kernel/shared/temporal-query-v1';
import type { ImpactItemRowV1, ImpactItemStateV1, SqliteImpactItemsV1 } from '../adapters/persistence/sqlite/impact-items-v1.js';
import type { PersonFollowUpReleaseAuditV1 } from '../adapters/persistence/sqlite/person-agentic-ask-audit-v1.js';
import { evidenceDateFieldsOfV1 } from '../adapters/persistence/sqlite/person-original-context-retrieval-v1.js';
import { createUncheckedTallyV1 } from '../application/evidence-unchecked-v1.js';
import {
  assessOpenItemsV1,
  errorCodeV1,
  observeEventV1,
  openItemCurrentV1,
  openItemDecisionPartsV1,
  openItemIsMeetingActionV1,
  openItemKindV1,
  openItemLiveReadV1,
  openItemNameV1,
  type AssessedOpenItemV1,
  type OpenItemDecisionsReaderV1,
  type OpenItemLiveReadV1,
  type OpenItemSourcesV1,
  type OpenItemsContextV1,
  type OpenItemViewerV1,
} from './person-open-items-v1.js';
import { openItemAccessV1 } from './open-items-policy-v1.js';
import {
  createEvidenceCursorsV1,
  evidenceInvalidV1 as invalid,
  evidenceNotFoundV1 as notFound,
  evidencePageSizeV1,
  evidenceTermsV1,
  evidenceWordsV1,
  newestFirstV1,
} from './person-local-source-helpers-v1.js';
import type { PersonReadableDecisionsV1, PersonReadableDecisionV1, PersonRecordAnchorV1 } from './person-record-search-route.js';

/**
 * ECHO's shared follow-ups (the open items of ADR-0033) as one Ask source
 * (ADR-0040). Who sees which follow-up, and which of its parts, is the
 * open-items policy's answer through the runs API's own assessment
 * (`assessOpenItemsV1`, `openItemAccessV1`, `openItemDecisionPartsV1`):
 * nothing here restates a rule. Search matches only words ECHO holds and the
 * policy shows the asker; an item's title and due date from its tool are read
 * live, as the asker, through the request's own desk, for the follow-ups a
 * call returns. Every release is audited without content before it leaves,
 * and rechecked before each model call (only what is new) and in full before
 * the answer (ADR-0038).
 *
 * Research tool contract v1: a follow-up carries ECHO's own dates (created,
 * sent, reassigned, checked), which a search or list may filter on, and links
 * to its decision's approved-record items and to the tool item it follows.
 * Both are released by the request's desk, which owns them: the decision's
 * through its record open, only where this release carries the decision; the
 * tool item only when this request read it live. They come back in the
 * result's `linked`, never as its rows.
 */

/** Where follow-ups, the facts the policy weighs, each decision's first line and anchor, and the decisions the asker reads now are read. */
export interface PersonFollowUpsSourcesV1 {
  readonly runs: OpenItemSourcesV1['runs'];
  readonly items: Pick<SqliteImpactItemsV1, 'read' | 'forRecords' | 'inOrganization'>;
  readonly people: OpenItemSourcesV1['people'];
  readonly records: OpenItemDecisionsReaderV1<PersonReadableDecisionV1> & Pick<PersonReadableDecisionsV1, 'projectRecords'> & Pick<PersonRecordAnchorV1, 'recordAnchor'>;
  /** Where a failed live read or an unreadable stored card is reported, without content; one line of JSON on standard error by default. */
  readonly on_live_failure?: OpenItemSourcesV1['on_live_failure'];
}

export interface CreatePersonFollowUpsEvidenceSourceV1Options {
  readonly sources: PersonFollowUpsSourcesV1;
  /** The asker, as their session authorized them when the request's desk was bound. */
  readonly viewer: OpenItemViewerV1;
  /** The asker's session now; every call and check reads it again. */
  readonly authenticate: () => PersonAccessAuthorization;
  /** Never Mine: Mine reads only what the asker added. */
  readonly scope: { readonly kind: 'global' } | { readonly kind: 'project'; readonly project_id: string };
  /**
   * The request's own desk. A follow-up's tool item opens through the tool
   * source this Ask bound, as that tool's audited live release, within its
   * per-request caps, and that tool rechecks it at every check.
   */
  readonly desk: Pick<EvidenceDeskPortV2, 'openCitation'>;
  readonly audit: PersonFollowUpReleaseAuditV1;
}

/** One request's follow-ups source; `createRegisteredPersonLiveEvidenceDeskV2` dispatches to it by its selector. */
export interface PersonFollowUpsEvidenceSourceV1 {
  readonly descriptor: FollowUpsSourceDescriptorV1;
  /**
   * `live: false` is a search across sources: its follow-ups carry ECHO-held
   * text only and nothing is read live, since the desk keeps only some of
   * them; a ticket key alone, which needs a live open, then finds none.
   */
  search(input: EvidenceDateFilterV1 & { readonly query: string; readonly limit?: number; readonly live?: boolean; readonly signal?: AbortSignal }): Promise<EvidenceDeskResultV2>;
  list(input: EvidenceDeskListInputV2): Promise<EvidenceDeskResultV2>;
  open(input: { readonly item: string; readonly signal?: AbortSignal }): Promise<EvidenceDeskResultV2>;
  /**
   * The policy pass again, for each follow-up released since the last
   * successful check (`incremental`), or every one (`full`, the default).
   * Synchronous: it reads only ECHO's own state, so the desk runs it with the
   * final local checks. A follow-up the asker no longer sees, or whose
   * decision they no longer read where a release carried it, fails with
   * `stale_access_state`.
   */
  revalidate(input: Pick<EvidenceDeskRevalidateInputV1, 'mode' | 'signal'>): void;
}

type Assessed = AssessedOpenItemV1;
type Context = OpenItemsContextV1;
/** Rows assessed for the asker, and their decisions' parts, with each decision's first line read once. */
type View = { readonly context: Context; readonly decisionPart: ReturnType<typeof openItemDecisionPartsV1> };
type Entry = { readonly entry: Assessed; readonly read?: LiveRead | undefined };
/** A live read and the receipts of the tool releases it made, which the Ask's terminal audit binds. */
type LiveRead = { readonly read: OpenItemLiveReadV1; readonly receipts: readonly Sha256Digest[] };
/** A decision's approved-record items as the request's desk released them, and that release's receipts. */
type DecisionRead = { readonly items: readonly EvidenceDeskItemV2[]; readonly receipts: readonly Sha256Digest[] };

const STATES: readonly ImpactItemStateV1[] = ['unsent', 'open', 'done', 'not_relevant'];
/** Search ranks current work first among equal matches. */
const STATE_ORDER: Readonly<Record<ImpactItemStateV1, number>> = Object.freeze({ open: 0, unsent: 1, done: 2, not_relevant: 3 });
/** The organization's rows a global scope reads at a time; once a request, it reads every page, each through the policy, with no bound before it. */
const ORGANIZATION_PAGE = 1000;
/** A project scope reads what the runs API's project scope reads: the records the asker reads in it now, and their rows. */
const PROJECT_RECORDS_MAX = 500;
const PROJECT_ROWS_MAX = 5000;
const LIVE_READS_AT_ONCE = 4;
/** List owner words that name the asker, as their own display name does. */
const ASKER = new Set(['me', 'myself', 'mine', 'i']);
const TICKET_KEY = /^[A-Z][A-Z0-9_]{0,63}-[1-9][0-9]{0,19}$/u;
const DEFAULT_TITLE = 'Follow-up';
/**
 * Why a ticket key may have found less than every follow-up. Each turns on the
 * query and on the reads the request made before any key lookup, never on
 * whether a follow-up holds the key.
 */
const KEY_ACROSS_SOURCES = 'Follow-ups are found by a ticket key only when follow_ups is searched on its own.';
const KEY_PAST_READS = 'This request has read as many follow-up items as it can, so a ticket key may not find every follow-up.';
/** Private visibilities first: an answer statement citing any of them is private. */
const NARROWEST: readonly EvidenceDeskVisibilityV1[] = ['only_me', 'approver_only', 'project', 'projects', 'team'];

const stale = (): never => { throw new AuthorityOperationError('stale_access_state', 'A follow-up is no longer available to this person'); };

/**
 * The dates a follow-up read takes: ECHO's own, as follow-ups' capabilities declare them (research tool contract v1). A due
 * date is its tool item's and shows only once that item is read, so a list cannot filter on it.
 */
const DATE_FIELDS = evidenceDateFieldsOfV1(FOLLOW_UPS_SOURCE_DESCRIPTOR_V1.capabilities!);
/** Access refusals: a decision the asker cannot open now is left unlinked, as a live read they cannot make is (open items). */
const REFUSED: readonly string[] = ['unauthorized', 'not_found', 'stale_access_state'];

/** A follow-up's own dates, as its desk item carries them: created always, the rest once they happened. */
function rowDates(row: Pick<ImpactItemRowV1, 'created_at' | 'sent_at' | 'owner_set_at' | 'check'>): EvidenceDatesV1 {
  return { created: row.created_at, ...(row.sent_at === null ? {} : { sent: row.sent_at }), ...(row.owner_set_at === null ? {} : { reassigned: row.owner_set_at }), ...(row.check === null ? {} : { checked: row.check.at }) };
}
/**
 * A read's window, or none. A date field follow-ups do not record is refused, never ignored (ADR-0041); a window with no
 * field is any of their dates. A time zone, or a field, without since or until bounds nothing.
 */
function windowOf(input: EvidenceDateFilterV1): EvidenceDateFilterV1 | undefined {
  validateEvidenceDateFilterV1(input, DATE_FIELDS);
  if (input.since === undefined && input.until === undefined) return undefined;
  // One shape however it was asked, so a list cursor's selection names the window, not its spelling.
  return Object.freeze({ ...(input.since === undefined ? {} : { since: input.since }), ...(input.until === undefined ? {} : { until: input.until }),
    date_field: input.date_field ?? EVIDENCE_ANY_DATE_V1, ...(input.time_zone === undefined ? {} : { time_zone: input.time_zone }) });
}
function inWindow(row: Pick<ImpactItemRowV1, 'created_at' | 'sent_at' | 'owner_set_at' | 'check'>, window: EvidenceDateFilterV1 | undefined): boolean {
  return window === undefined || matchesEvidenceDateV1(rowDates(row), window, 'created');
}
/** The rows a window could not test because they do not record its date, and the dates they do record (research tool contract v1). */
function uncheckedOf(rows: readonly Pick<ImpactItemRowV1, 'created_at' | 'sent_at' | 'owner_set_at' | 'check'>[], window: EvidenceDateFilterV1 | undefined): EvidenceDeskUncheckedV1 | undefined {
  if (window === undefined) return undefined;
  // `windowOf` always names the window's field.
  const tally = createUncheckedTallyV1();
  for (const row of rows) tally.tests(rowDates(row), window.date_field ?? EVIDENCE_ANY_DATE_V1);
  return tally.unchecked();
}
/** A ticket key a query names, upper case, from a word that is one once punctuation around it is trimmed. */
function keyOf(word: string): string | undefined {
  const key = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toUpperCase();
  return TICKET_KEY.test(key) ? key : undefined;
}
/**
 * A search's terms (`evidenceTermsV1`) and ticket keys. A ticket key stays one key, matched against a ticket item's own
 * key and against the same key-shaped word where ECHO's text holds it.
 */
function queryOf(query: string): { readonly terms: readonly string[]; readonly keys: readonly string[] } {
  const keys = new Set<string>();
  const terms = new Set<string>();
  for (const word of query.normalize('NFC').trim().split(/\s+/u)) {
    const key = keyOf(word);
    if (key !== undefined) { keys.add(key); continue; }
    for (const term of evidenceTermsV1(word)) terms.add(term);
  }
  return { terms: [...terms], keys: [...keys] };
}
/** Words of ECHO-held text shaped like a ticket key, such as the build name "EVT-2", as written: a query's key matches them too. */
function keysOf(values: readonly (string | null | undefined)[]): ReadonlySet<string> {
  return new Set(values.flatMap(value => (value ?? '').normalize('NFC').split(/\s+/u).flatMap(word => keyOf(word) ?? [])));
}
/** A name as one compares it with another: NFC, lower case, runs of space as one. */
function spelled(name: string): string {
  return name.normalize('NFC').trim().toLowerCase().replace(/\s+/gu, ' ');
}
/** A ticket item's key, from the browse link its stored pointer keeps. Never a page's or a message's pointer, which can hold a title. */
function ticketKeyOf(row: Pick<ImpactItemRowV1, 'pointer'>): string | undefined {
  const { kind, permalink } = row.pointer;
  if (kind !== 'ticket' || typeof permalink !== 'string') return undefined;
  let path: string;
  try { path = new URL(permalink).pathname; } catch { return undefined; }
  const key = /\/browse\/([^/]+)\/?$/u.exec(path)?.[1];
  return key !== undefined && TICKET_KEY.test(key) ? key : undefined;
}
function narrowest(...values: readonly (EvidenceDeskVisibilityV1 | undefined)[]): EvidenceDeskVisibilityV1 {
  return NARROWEST.find(value => values.includes(value)) ?? 'only_me';
}
const newestFirst = newestFirstV1<Pick<ImpactItemRowV1, 'created_at' | 'item_id'>>(row => row.item_id);

export function createPersonFollowUpsEvidenceSourceV1(options: CreatePersonFollowUpsEvidenceSourceV1Options): PersonFollowUpsEvidenceSourceV1 {
  const { sources, viewer, scope } = options;
  /** Each follow-up released in this request, and whether any release of it carried its decision. */
  const released = new Map<string, { decision: boolean }>();
  /** Released since this source's last successful check (ADR-0038). */
  const unchecked = new Set<string>();
  /** Desk id to item id, for `open`. */
  const issued = new Map<string, string>();
  /** One live read per tool item (`item_key`) in the request, at most `live_reads` of them. */
  const reads = new Map<Sha256Digest, Promise<LiveRead>>();
  /** One open of each decision a release links to, by its record, in the request. */
  const decisionReads = new Map<Sha256Digest, Promise<DecisionRead>>();
  const cursors = createEvidenceCursorsV1<Assessed['row']>();
  let running = 0;
  const waiting: (() => void)[] = [];

  /** The asker's session, still the person this desk was bound to. */
  const current = (signal?: AbortSignal): void => {
    signal?.throwIfAborted();
    const authorization = options.authenticate();
    if (authorization.organization_id !== viewer.organization || authorization.principal_id !== viewer.principal || authorization.membership_id !== viewer.membership) stale();
  };
  /** The asker's display name in the directory, as the Ask route names them to research. */
  const askerName = (): string => sources.people.people(viewer.organization, [viewer.membership]).get(viewer.membership)?.name ?? '';
  const projectRecords = (project_id: string): ReadonlySet<Sha256Digest> =>
    new Set(sources.records.projectRecords({ access_token: viewer.token, project_id, limit: PROJECT_RECORDS_MAX }));

  /** Every row this scope shows the asker, through the policy. */
  const scan = (): Context => {
    if (scope.kind === 'project') {
      const context = assessOpenItemsV1(sources, viewer, sources.items.forRecords([...projectRecords(scope.project_id)], { states: STATES, limit: PROJECT_ROWS_MAX }));
      return { ...context, assessed: context.assessed.filter(entry => entry.access.see_row) };
    }
    // Every page of the organization, each through the same policy pass, so a row the asker cannot see never moves another out of view.
    const decisions = new Map<Sha256Digest, PersonReadableDecisionV1>();
    const people = new Map<string, NonNullable<ReturnType<Context['people']['get']>>>();
    const assessed: Assessed[] = [];
    for (let after: Assessed['row'] | undefined; ;) {
      const rows = sources.items.inOrganization(viewer.organization, { states: STATES, limit: ORGANIZATION_PAGE, ...(after === undefined ? {} : { after }) });
      const context = assessOpenItemsV1(sources, viewer, rows);
      for (const [record, decision] of context.decisions) decisions.set(record, decision);
      for (const [membership, person] of context.people) people.set(membership, person);
      assessed.push(...context.assessed.filter(entry => entry.access.see_row));
      after = rows.at(-1);
      if (rows.length < ORGANIZATION_PAGE || after === undefined) return { decisions, people, assessed };
    }
  };
  let shown: View | undefined;
  /**
   * What this scope shows the asker, read once a request at its first search or list, with the asker's session read again
   * on every call. Each release is rechecked against fresh rows before the next model call and in full before the answer
   * (ADR-0038), so a follow-up hidden since this read never reaches either; one shown since appears in the next request.
   */
  const visible = (signal?: AbortSignal): View => {
    current(signal);
    if (shown === undefined) { const context = scan(); shown = Object.freeze({ context, decisionPart: openItemDecisionPartsV1(sources, context) }); }
    return shown;
  };

  const slot = async (): Promise<() => void> => {
    if (running >= LIVE_READS_AT_ONCE) await new Promise<void>(resolve => { waiting.push(resolve); });
    running += 1;
    return () => { running -= 1; waiting.shift()?.(); };
  };
  /**
   * The row's tool item read once in this request, as the asker, through the
   * request's desk; none for a meeting action (ECHO's own data) or past the
   * request's bound. A read a cancelled call left unfinished is tried again.
   */
  const liveRead = async (row: ImpactItemRowV1, signal?: AbortSignal): Promise<LiveRead | undefined> => {
    if (openItemIsMeetingActionV1(row)) return undefined;
    for (let attempt = 0; ; attempt += 1) {
      let read = reads.get(row.item_key);
      if (read === undefined) {
        if (reads.size >= FOLLOW_UPS_LIMITS_V1.live_reads) return undefined;
        read = (async () => {
          const release = await slot();
          try {
            const receipts: Sha256Digest[] = [];
            const desk = { openCitation: async (input: Parameters<NonNullable<EvidenceDeskPortV2['openCitation']>>[0]) => {
              const result = await options.desk.openCitation!(input);
              receipts.push(...result.receipt_digests);
              return result;
            } };
            const value = await openItemLiveReadV1(desk, row, { signal, report: code => observeEventV1(sources.on_live_failure, Object.freeze({ kind: 'open_items_live_read' as const, reason: 'open' as const, code })) });
            return Object.freeze({ read: value, receipts: Object.freeze(receipts) });
          } finally { release(); }
        })();
        reads.set(row.item_key, read);
      }
      try { return await read; }
      catch (error) {
        if (reads.get(row.item_key) === read) reads.delete(row.item_key);
        if (signal?.aborted === true || attempt > 0) throw error;
      }
    }
  };

  /**
   * A decision's approved-record items, opened once in the request through the request's desk, which owns and audits them
   * as any record open: its record's first atom and the atoms beside it. None when the decision cannot be opened now (its
   * index behind the record log, an outage, or access lost meanwhile); a cancelled request throws. As a live read, a read a
   * cancelled call left unfinished is tried again, and a failure is tried again by a later release.
   */
  const decisionRead = async (record: Sha256Digest, signal?: AbortSignal): Promise<DecisionRead | undefined> => {
    for (let attempt = 0; ; attempt += 1) {
      let read = decisionReads.get(record);
      if (read === undefined) {
        read = (async () => {
          const citation = sources.records.recordAnchor({ access_token: viewer.token, record_sha256: record });
          const result = await options.desk.openCitation!({ citation, ...(signal === undefined ? {} : { signal }) });
          // Only the decision's own atoms are its items.
          const items = result.items.filter(item => item.citation.kind === 'approved_record' && item.citation.record_sha256 === record);
          return Object.freeze({ items: Object.freeze(items), receipts: Object.freeze([...result.receipt_digests]) });
        })();
        decisionReads.set(record, read);
      }
      try { return await read; }
      catch (error) {
        if (decisionReads.get(record) === read) decisionReads.delete(record);
        if (signal?.aborted === true) throw error;
        if (attempt > 0) {
          const code = errorCodeV1(error);
          if (!REFUSED.includes(code)) observeEventV1(sources.on_live_failure, Object.freeze({ kind: 'open_items_live_read' as const, reason: 'open' as const, code }));
          return undefined;
        }
      }
    }
  };

  /**
   * One follow-up as the asker may see it now. Its tool's words (title, due
   * date) only when the policy says they opened the item in this request;
   * its decision only when the policy shows them the decision. A part the
   * evidence contract refuses is left out (they see less, never more). The
   * tool item it follows is linked exactly when the asker opened it here.
   */
  const shape = ({ context, decisionPart }: View, { entry, read }: Entry) => {
    const { row, facts } = entry;
    const opened = read?.read.reach === 'opened' ? read.read.item : undefined;
    const access = openItemAccessV1(read === undefined ? facts : { ...facts, opens_item: opened !== undefined });
    if (!access.see_row) return undefined;
    const live = opened !== undefined && access.see_outside && openItemCurrentV1(opened) !== undefined ? opened : undefined;
    const due = live === undefined ? '' : openItemCurrentV1(live)?.due_at ?? '';
    const liveTitle = live === undefined ? '' : impactCardLineV1(live.label, LIMITS.title_chars);
    const expected = impactCardLineV1(row.expected, LIMITS.expected_chars);
    const decision = decisionPart(entry);
    const readable = decision === undefined ? undefined : context.decisions.get(row.record_sha256);
    const evidence = (withLive: boolean, withDecision: boolean): PersonFollowUpEvidenceV1 => {
      const title = (withLive ? liveTitle : '') || expected || DEFAULT_TITLE;
      const decided = decision?.first_line === null || decision?.first_line === undefined ? '' : impactCardLineV1(decision.first_line, LIMITS.first_line_chars);
      return validatePersonFollowUpEvidenceV1({
        item_id: row.item_id, kind: openItemKindV1(row.pointer), title, owner: openItemNameV1(context.people, row.owner_membership_id), status: row.state,
        // ECHO's own dates, which the runs API shows whoever sees the row.
        created_at: row.created_at, ...(row.sent_at === null ? {} : { sent_at: row.sent_at }), ...(row.owner_set_at === null ? {} : { reassigned_at: row.owner_set_at }),
        ...(withLive && liveTitle !== '' && due !== '' ? { due_at: due } : {}),
        ...(row.check === null ? {} : { check: { verdict: row.check.verdict, checked_at: row.check.at } }),
        ...(withDecision && decision !== undefined ? { decision: {
          title: impactCardLineV1(decision.title, LIMITS.decision_title_chars) || 'Approved meeting',
          ...(decided === '' ? {} : { first_line: decided }), ref: `meeting:${row.record_sha256}`,
        } } : {}),
        ...(expected !== '' && expected !== title ? { expected } : {}),
      });
    };
    for (const [withLive, withDecision] of [[true, true], [false, true], [true, false], [false, false]] as const) {
      let value: PersonFollowUpEvidenceV1;
      try { value = evidence(withLive, withDecision); } catch { continue; /* the next, smaller form */ }
      const words = withLive && liveTitle !== '' && live !== undefined;
      // The decision's audience when the asker reads it, else only them; a title from the asker's own tool read is no wider than that read.
      const visibility = narrowest(withDecision && value.decision !== undefined ? readable?.visibility : 'only_me', words ? live.visibility : undefined);
      return { evidence: value, visibility, decision: value.decision !== undefined, record: row.record_sha256, receipts: read?.receipts ?? [],
        ...(opened !== undefined && access.see_outside ? { follows: opened } : {}) };
    }
    throw new AuthorityOperationError('invalid_output', 'Follow-up evidence is invalid');
  };

  /**
   * Audits one call's follow-ups before they leave, then remembers each for `open` and the checks. With `links`, each one
   * links to its decision's items where it carries its decision, and to the tool item it follows where this request read
   * it; those items, which the request's desk released and audited, come back once each in `linked`.
   */
  const release = async (operation: 'search' | 'list' | 'open', view: View, entries: readonly Entry[], truncated: boolean,
    { next_cursor, notice, page_full, untested, links, signal }: {
      readonly next_cursor?: string | undefined; readonly notice?: string | undefined; readonly page_full?: boolean;
      readonly untested?: EvidenceDeskUncheckedV1 | undefined; readonly links: boolean; readonly signal?: AbortSignal | undefined;
    }): Promise<EvidenceDeskResultV2> => {
    const shaped = entries.flatMap(entry => { const value = shape(view, entry); return value === undefined ? [] : [value]; });
    const decided = links ? [...new Set(shaped.flatMap(value => (value.decision ? [value.record] : [])))] : [];
    const decisions = new Map(await Promise.all(decided.map(async record => [record, await decisionRead(record, signal)] as const)));
    signal?.throwIfAborted();
    const receipt = options.audit.record({ operation, items: shaped.map(({ evidence, visibility }) => ({ item_id: evidence.item_id, released_fields_sha256: canonicalSha256({ evidence, visibility }) })) });
    const linked = new Map<string, EvidenceDeskItemV2>();
    const items = shaped.map(({ evidence, visibility, decision, record, follows }): EvidenceDeskItemV2 => {
      const id = `follow_up_${evidence.item_id}`;
      issued.set(id, evidence.item_id);
      const previous = released.get(evidence.item_id);
      released.set(evidence.item_id, { decision: decision || previous?.decision === true });
      unchecked.add(evidence.item_id);
      const decisionItems = decision ? decisions.get(record)?.items ?? [] : [];
      const followed = links ? follows : undefined;
      for (const item of [...decisionItems, ...(followed === undefined ? [] : [followed])]) linked.set(item.id, item);
      const named = { ...(decisionItems.length === 0 ? {} : { decision: Object.freeze(decisionItems.map(item => item.id)) }), ...(followed === undefined ? {} : { follows: Object.freeze([followed.id]) }) };
      return Object.freeze({ id, ...followUpDeskFieldsV1(evidence), visibility, receipt_sha256: receipt, ...(Object.keys(named).length === 0 ? {} : { links: Object.freeze(named) }) });
    });
    return Object.freeze({
      items: Object.freeze(items), truncated,
      receipt_digests: Object.freeze([...new Set([receipt, ...shaped.flatMap(value => value.receipts), ...[...decisions.values()].flatMap(read => read?.receipts ?? [])])]),
      ...(linked.size === 0 ? {} : { linked: Object.freeze([...linked.values()]) }),
      ...(untested === undefined ? {} : { unchecked: untested }),
      ...(next_cursor === undefined ? {} : { next_cursor }),
      ...(notice === undefined ? {} : { notice }),
      ...(page_full === undefined ? {} : { page_full }),
    });
  };
  const withReads = (entries: readonly Assessed[], signal?: AbortSignal): Promise<readonly Entry[]> =>
    Promise.all(entries.map(async entry => ({ entry, read: await liveRead(entry.row, signal) })));

  return Object.freeze<PersonFollowUpsEvidenceSourceV1>({
    descriptor: FOLLOW_UPS_SOURCE_DESCRIPTOR_V1,

    async search(input) {
      const window = windowOf(input);
      const limit = evidencePageSizeV1(input.limit, FOLLOW_UPS_LIMITS_V1.search_hits);
      if (typeof input.query !== 'string') invalid('query is required');
      const live = input.live !== false;
      const { terms, keys } = queryOf(input.query);
      const view = visible(input.signal);
      const { context, decisionPart } = view;
      // Only ECHO-held text the policy shows the asker: the decision's title and first line where the decision is shown, the
      // expected phrase, the owner's name, each with its key-shaped words as written; and a ticket's own key. Never a word read from a tool.
      // A window applies first, to ECHO's own dates, before anything is ranked or read live.
      const candidates = context.assessed.flatMap(entry => {
        if (!inWindow(entry.row, window)) return [];
        const decision = decisionPart(entry);
        const held = [decision?.title, decision?.first_line, entry.row.expected, openItemNameV1(context.people, entry.row.owner_membership_id)];
        const words = evidenceWordsV1(held);
        const written = keysOf(held);
        // A key-shaped word ECHO holds as written ("EVT-2") is one of its words; the key's parts alone are not.
        const matched = terms.filter(term => words.has(term)).length + keys.filter(key => written.has(key)).length;
        const key = ticketKeyOf(entry.row);
        const keyed = key !== undefined && keys.includes(key);
        // Ranked by ECHO's words alone: a key, which the asker may not be able to open, never moves or cuts a hit.
        return matched === 0 && !keyed ? [] : [{ entry, score: matched, keyOnly: matched === 0 }];
      }).sort((left, right) => right.score - left.score || STATE_ORDER[left.entry.row.state] - STATE_ORDER[right.entry.row.state] || newestFirst(left.entry.row, right.entry.row));
      // Every word match is a hit, read live only when follow-ups were searched on their own.
      const worded = candidates.filter(value => !value.keyOnly).map(value => value.entry);
      const chosen = worded.slice(0, limit);
      const hits: Entry[] = live ? [...await withReads(chosen, input.signal)] : chosen.map(entry => ({ entry }));
      const readBefore = reads.size;
      // Home shows an item's key only with the item opened: a hit its key alone matched ranks after every word match, and is a hit
      // only once the live read opened it. One that did not is as if it never matched, and never counts toward truncation.
      const keyOnly = live ? candidates.filter(value => value.keyOnly).map(value => value.entry) : [];
      // Unless the words already overflow the page, look for one opened hit past it: only a real hit there says the page was cut,
      // never a key the asker cannot open.
      const wordsCut = worded.length > chosen.length;
      const wanted = wordsCut ? limit : limit + 1;
      for (let next = 0; hits.length < wanted && next < keyOnly.length;) {
        const round = keyOnly.slice(next, next + wanted - hits.length);
        next += round.length;
        for (const entry of await withReads(round, input.signal)) {
          const read = entry.read?.read;
          if (read?.reach === 'opened' && openItemAccessV1({ ...entry.entry.facts, opens_item: true }).see_outside && openItemCurrentV1(read.item) !== undefined) hits.push(entry);
        }
      }
      input.signal?.throwIfAborted();
      // Each key may need one more read than the request had made before its lookup.
      const notice = keys.length === 0 ? undefined : !live ? KEY_ACROSS_SOURCES : readBefore + keys.length > FOLLOW_UPS_LIMITS_V1.live_reads ? KEY_PAST_READS : undefined;
      // What the window could not test is counted over every follow-up the asker sees, as a meeting search's is, whatever its words
      // match. A search across sources links nothing: the desk keeps only some of its hits, so nothing is opened for them.
      return release('search', view, hits.slice(0, limit), wordsCut || hits.length > limit,
        { notice, untested: uncheckedOf(context.assessed.map(({ row }) => row), window), links: live, signal: input.signal });
    },

    async list(input) {
      const window = windowOf(input);
      if (input.channel !== undefined || input.kinds?.some(kind => kind !== FOLLOW_UP_EVIDENCE_KIND_V1)) invalid('follow-ups take only owner, status and their own dates');
      const size = evidencePageSizeV1(input.limit, FOLLOW_UPS_LIMITS_V1.list_page);
      const owner = input.owner === undefined ? undefined : input.owner.normalize('NFC').trim().replace(/^@/u, '').trim();
      if (owner !== undefined && (owner.length === 0 || owner.length > 80)) invalid('owner must be a person\'s name such as "Dana", or "me"');
      if (input.status !== undefined && input.status !== 'open' && input.status !== 'done') invalid('status must be "open" or "done"');
      const selection = JSON.stringify({ owner: owner?.toLowerCase() ?? null, status: input.status ?? null, window: window ?? null });
      const after = input.cursor === undefined ? undefined : cursors.after(input.cursor, selection);
      const view = visible(input.signal);
      const { context } = view;
      // "me", or the asker's own name, which research passes for "I" and "my" (asked_by): their own follow-ups, by membership,
      // never another member whose name holds theirs.
      const asker = owner !== undefined && (ASKER.has(owner.toLowerCase()) || spelled(owner) === spelled(askerName()));
      // Filters apply before anything is released or read live.
      const status = input.status;
      const selected = context.assessed.filter(({ row }) => (status === undefined || followUpInStatusV1(row.state, status)) &&
        (owner === undefined || (asker ? row.owner_membership_id === viewer.membership : followUpOwnerMatchesV1(openItemNameV1(context.people, row.owner_membership_id), owner))));
      const matching = selected.filter(({ row }) => inWindow(row, window)).sort((left, right) => newestFirst(left.row, right.row));
      const following = after === undefined ? matching : matching.filter(({ row }) => newestFirst(after, row) < 0);
      const page = following.slice(0, size);
      const entries = await withReads(page, input.signal);
      input.signal?.throwIfAborted();
      const next_cursor = following.length > page.length ? cursors.next('follow_ups', selection, page.at(-1)!.row) : undefined;
      // This source holds every matching follow-up, so a list's end is always confirmed (ADR-0041). What its window could not test
      // is of the whole selection, so every page says the same.
      return release('list', view, entries, false, { next_cursor, page_full: false, untested: uncheckedOf(selected.map(({ row }) => row), window), links: true, signal: input.signal });
    },

    async open(input) {
      const itemId = issued.get(input.item);
      if (itemId === undefined) return notFound();
      current(input.signal);
      const row = sources.items.read(itemId);
      if (row === undefined || (scope.kind === 'project' && !projectRecords(scope.project_id).has(row.record_sha256))) return notFound();
      const context = assessOpenItemsV1(sources, viewer, [row]);
      const entry = context.assessed[0];
      if (entry === undefined || !entry.access.see_row) return notFound();
      const entries = await withReads([entry], input.signal);
      input.signal?.throwIfAborted();
      return release('open', { context, decisionPart: openItemDecisionPartsV1(sources, context) }, entries, false, { links: true, signal: input.signal });
    },

    revalidate(input) {
      input.signal?.throwIfAborted();
      const ids = [...(input.mode === 'incremental' ? unchecked : released.keys())];
      if (ids.length === 0) return;
      current(input.signal);
      const rows = ids.map(id => sources.items.read(id) ?? stale());
      const context = assessOpenItemsV1(sources, viewer, rows);
      if (context.assessed.length !== rows.length) stale();
      const inProject = scope.kind === 'project' ? projectRecords(scope.project_id) : undefined;
      for (const { row, access } of context.assessed) {
        // The row still shown, its decision still shown wherever a release carried it, and still in the Ask's project.
        // A state or owner changed meanwhile is not an access change.
        if (!access.see_row || (released.get(row.item_id)!.decision && !access.see_decision) || (inProject !== undefined && !inProject.has(row.record_sha256))) stale();
      }
      input.signal?.throwIfAborted();
      for (const id of ids) unchecked.delete(id);
    },
  });
}
