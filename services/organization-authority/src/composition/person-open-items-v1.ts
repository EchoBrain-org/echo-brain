import { randomUUID } from 'node:crypto';
import type { Sha256Digest } from '@echo-brain/federation-protocol';
import {
  PERSON_HOME_ROWS_V1,
  PERSON_IMPACT_CARD_LIMITS_V1 as LIMITS,
  PERSON_OPEN_ITEMS_PAGE_V1,
  PERSON_UPLOAD_PROJECT_SET_MAX,
  validatePersonAnswerCitationV6,
  validatePersonRunsResultV1,
  type PersonAnswerCitationV6,
  type PersonHomeSendV1,
  type PersonImpactStageV1,
  type PersonOpenItemCurrentV1,
  type PersonOpenItemDecisionV1,
  type PersonOpenItemKindV1,
  type PersonOpenItemPersonV1,
  type PersonOpenItemReachV1,
  type PersonOpenItemsSummaryV1,
  type PersonOpenItemV1,
  type PersonRunsResultsV1,
} from '@echo-brain/organization-api';
import { AGENTIC_TRIGGER_DEFINITIONS_V1 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-trigger-definitions-v1';
import { currentImpactLineV1, impactCardLineV1, impactItemKeyV1 } from '@echo-brain/organization-authority-kernel/answer-composition/renderers/impact-card-storage-v1';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import { AuthorityOperationError, type AuthorityErrorCode } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { ImpactItemRowV1, ImpactItemStateV1, SqliteImpactItemsV1 } from '../adapters/persistence/sqlite/impact-items-v1.js';
import type { SqliteOpenItemPeopleV1 } from '../adapters/persistence/sqlite/open-item-people-v1.js';
import { triggerRunStateAtV1, type SqliteTriggerRunsV1, type TriggerRunRowV1, type TriggerRunScopeV1 } from '../adapters/persistence/sqlite/trigger-runs-v1.js';
import type { PersonTriggerRunsHttpApplicationV1 } from '../presentation/person-trigger-runs-http-application.js';
import { openItemAccessV1, openItemDecisionAccessV1, openItemSendAccessV1, type OpenItemAccessV1, type OpenItemFactsV1 } from './open-items-policy-v1.js';
import type { bindPersonLiveEvidenceDeskV1, CreatePersonLiveAnswerRouteOptionsV1, PersonLiveRequestContextV1 } from './person-live-answer-route-v1.js';
import type { PersonReadableDecisionV1, PersonReadableDecisionsV1 } from './person-record-search-route.js';
import { readStoredImpactCardV1 } from './person-stored-impact-card-v1.js';

/**
 * The shared open items on the runs API (open items and Home v1, sections 4,
 * 5 and 7; ADR-0033): `home`, `items` and `item` show the rows a person can
 * see, and `send`, `set_state` and `assign` change them. Every see and act
 * question goes to the open-items policy (`openItemAccessV1`, and
 * `openItemSendAccessV1` for Send); this module only gathers its facts.
 * A row's own fields are ECHO's. An item's title, text, assignee, status and
 * due date are read live on every call, as the viewer, on one desk per
 * request, and shown only when the policy says the viewer opened the item.
 * Each row says how its read went (`reach`): a refusal by the viewer's own
 * access is `no_access`; anything else that stops a read (an outage, a rate
 * limit, a timeout) is `unavailable` and is reported without content, so an
 * outage is never shown as lost access.
 *
 * `sweep` asks for a sweep run of the open items the caller can see in a
 * scope, and `home` says when one is due (section 6); the sweep run itself
 * reads the same items through `sweepScopeOpenItemsV1`.
 */
export interface CreatePersonOpenItemsV1Options extends OpenItemSourcesV1 {
  readonly sessions: { authenticateAccess(input: { readonly access_token: string }): PersonAccessAuthorization };
  readonly runs: SqliteTriggerRunsV1;
  readonly items: SqliteImpactItemsV1;
  readonly people: SqliteOpenItemPeopleV1;
  /** Kept injectable for focused service tests, as the runs service keeps it. */
  readonly bindDesk: typeof bindPersonLiveEvidenceDeskV1;
  readonly bind_options: CreatePersonLiveAnswerRouteOptionsV1;
  readonly live_sources?: CreatePersonLiveAnswerRouteOptionsV1['live_sources'];
  /** The clock Home tells a stale check and a recent sweep by, and a stage a lapsed lease. */
  readonly now?: () => Date;
}
/** Where open items, the facts the policy weighs for them, and each decision's first line are read. */
export interface OpenItemSourcesV1 {
  readonly runs: Pick<SqliteTriggerRunsV1, 'readUnfenced'>;
  readonly items: Pick<SqliteImpactItemsV1, 'involving' | 'forRecords'>;
  readonly people: Pick<SqliteOpenItemPeopleV1, 'people' | 'leadsAny'>;
  readonly records: PersonReadableDecisionsV1;
  /** Where a failed live read, or a stored card whose first line cannot be read, is reported; one line of JSON on standard error by default. */
  readonly on_live_failure?: (event: OpenItemsLiveFailureV1) => void;
}
/**
 * A live read that failed for a reason other than the viewer's access, or a
 * stored card whose first line could not be read. Content-free by
 * construction: no id, title, pointer or outside word, only where it failed
 * and the error's code (`error` for anything that is not an Authority error).
 */
export interface OpenItemsLiveFailureV1 {
  readonly kind: 'open_items_live_read';
  readonly reason: 'bind' | 'open' | 'fence' | 'first_line';
  readonly code: string;
}
export type PersonOpenItemsApplicationV1 = Pick<PersonTriggerRunsHttpApplicationV1, 'home' | 'items' | 'item' | 'send' | 'set_state' | 'assign' | 'sweep'>;

/** The signed-in person an open-items read is for. */
export interface OpenItemViewerV1 { readonly token: string; readonly authorization: PersonAccessAuthorization; readonly organization: string; readonly principal: string; readonly membership: string }
/** One row with the facts the policy was given and its answer. */
export interface AssessedOpenItemV1 { readonly row: ImpactItemRowV1; readonly facts: OpenItemFactsV1; readonly access: OpenItemAccessV1 }
/** Rows assessed for one viewer, with the decisions the viewer reads now and the people the rows name. */
export interface OpenItemsContextV1 { readonly decisions: ReadonlyMap<Sha256Digest, PersonReadableDecisionV1>; readonly people: People; readonly assessed: readonly AssessedOpenItemV1[] }

type Desk = Awaited<ReturnType<typeof bindPersonLiveEvidenceDeskV1>>;
type DeskItem = Awaited<ReturnType<NonNullable<Desk['openCitation']>>>['items'][number];
type Pointer = ImpactItemRowV1['pointer'];
type People = ReturnType<SqliteOpenItemPeopleV1['people']>;
type Viewer = OpenItemViewerV1;
type Assessed = AssessedOpenItemV1;
type Context = OpenItemsContextV1;
/** How one item's live read went: the item read, or why there is none. An item no read was tried for has no entry. */
type LiveRead = { readonly reach: 'opened'; readonly item: DeskItem } | { readonly reach: 'no_access' | 'unavailable' };

const STATES: readonly ImpactItemStateV1[] = ['unsent', 'open', 'done', 'not_relevant'];
/** `involving` and `orphaned` apply their limit before any access check and have no cursor: a bound far above one person's open items. */
const INVOLVING_MAX = 1000;
/** The most rows one `items` scope reads; its pages and summary are within them. */
const SCOPE_ROWS_MAX = 5000;
/** The most records a project scope reads (the record lookup's own bound). */
const PROJECT_RECORDS_MAX = 500;
/** The most decisions a summary's per-decision counts, or the stages, cover. */
const SCOPE_DECISIONS_MAX = 100;
/** Live opens per call, each item at most once, a few at a time. */
const LIVE_OPENS_MAX = 50;
const LIVE_OPENS_AT_ONCE = 4;
/** An item's status and due date, as the API bounds them. */
const DETAIL_CHARS = 128;
const ITEM_ID = /^itm_[A-Za-z0-9-]{4,60}$/;
const CANONICAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const GLOBAL = Object.freeze({ kind: 'global' as const });
/** Send row kinds in one fixed order. */
const KIND_ORDER: readonly PersonOpenItemKindV1[] = ['ticket', 'page', 'slack_message', 'record', 'document'];
const UNKNOWN_MEMBER = 'Unknown member';
/** The codes an Authority error can carry: an observation names one of these, else `error`, never a message. */
const ERROR_CODES: readonly AuthorityErrorCode[] = ['conflict', 'invalid_request', 'invalid_output', 'not_found', 'stale_access_state', 'unauthorized', 'rate_limited', 'quota_exceeded', 'unavailable'];
/** A desk that refuses an item with one of these refused the viewer's access to it; any other failure says nothing about access. */
const ACCESS_REFUSED: readonly AuthorityErrorCode[] = ['unauthorized', 'not_found', 'stale_access_state'];
/** A last check older than a day makes a sweep due; a person's sweep is asked for at most hourly (R32). */
const DAY_MS = 24 * 3_600_000;
const HOUR_MS = 3_600_000;
const SWEEP_TRIGGER = AGENTIC_TRIGGER_DEFINITIONS_V1.find(definition => definition.name === 'sweep')!;

const notFound = () => new AuthorityOperationError('not_found', 'item is not available');
/** An error's Authority code, or `error`. */
function codeOf(error: unknown): string {
  return error instanceof AuthorityOperationError && ERROR_CODES.includes(error.code) ? error.code : 'error';
}
function refusedAccess(error: unknown): boolean {
  return error instanceof AuthorityOperationError && ACCESS_REFUSED.includes(error.code);
}
function invalidOutput(): never {
  throw new AuthorityOperationError('invalid_output', 'open items response is invalid');
}

/** The tool an item lives in, from its stored pointer. */
export function openItemKindV1(pointer: Pointer): PersonOpenItemKindV1 {
  switch (pointer.kind) {
    case 'ticket': case 'page': case 'slack_message': return pointer.kind;
    case 'approved_record': return 'record';
    case 'source_revision': return 'document';
    default: return invalidOutput();
  }
}

/** Code point order, as SQLite's binary collation and canonical ISO times order. */
function ascending(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
/** Oldest first: created_at, then item_id, as the items store orders rows. */
function oldestFirst(left: Pick<ImpactItemRowV1, 'created_at' | 'item_id'>, right: Pick<ImpactItemRowV1, 'created_at' | 'item_id'>): number {
  return ascending(left.created_at, right.created_at) || ascending(left.item_id, right.item_id);
}

/** A page cursor: base64url of `created_at|item_id` of the page's last row. */
function cursorOf(row: Pick<ImpactItemRowV1, 'created_at' | 'item_id'>): string {
  return Buffer.from(`${row.created_at}|${row.item_id}`, 'utf8').toString('base64url');
}
function cursorAfter(cursor: string): { readonly created_at: string; readonly item_id: string } {
  const [created_at, item_id, ...rest] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (rest.length > 0 || created_at === undefined || item_id === undefined || !CANONICAL_TIME.test(created_at) || Number.isNaN(Date.parse(created_at)) ||
      !ITEM_ID.test(item_id) || cursorOf({ created_at, item_id }) !== cursor) throw new AuthorityOperationError('invalid_request', 'Runs request cursor is invalid');
  return { created_at, item_id };
}

/** A member's display name as one line of the API's name rule; directory names are not otherwise bounded. */
function nameOf(people: People, membershipId: string): string {
  return impactCardLineV1(people.get(membershipId)?.name, LIMITS.name_chars) || UNKNOWN_MEMBER;
}
function personOf(people: People, membershipId: string): PersonOpenItemPersonV1 {
  return Object.freeze({ membership_id: membershipId, name: nameOf(people, membershipId), active: people.get(membershipId)?.active === true });
}

/** What an item says now, from one fresh open as the viewer. Undefined when the read gives nothing the API can carry. */
function currentOf(item: DeskItem): PersonOpenItemCurrentV1 | undefined {
  let citation: PersonAnswerCitationV6;
  try { citation = validatePersonAnswerCitationV6({ citation: item.citation, kind: item.kind, label: item.label, visibility: item.visibility }); } catch { return undefined; }
  const says_now = currentImpactLineV1({ citation, label: item.label, ...(item.text === undefined ? {} : { text: item.text }), ...(item.attributes === undefined ? {} : { attributes: item.attributes }) });
  if (says_now.length === 0) return undefined;
  const assignee = impactCardLineV1(item.attributes?.owner, LIMITS.name_chars);
  const status = impactCardLineV1(item.attributes?.status, DETAIL_CHARS);
  const due_at = impactCardLineV1(item.attributes?.due_at, DETAIL_CHARS);
  return Object.freeze({ citation, says_now, ...(assignee === '' ? {} : { assignee }), ...(status === '' ? {} : { status }), ...(due_at === '' ? {} : { due_at }) });
}

/** The API's own result check on everything this service answers. */
function checked<K extends keyof PersonRunsResultsV1>(operation: K, value: unknown): PersonRunsResultsV1[K] {
  try { return validatePersonRunsResultV1(operation, value); } catch { return invalidOutput(); }
}

/**
 * One item as the API carries it. A live part, or a decision, the API refuses
 * is left out (the viewer sees less, never more) rather than failing the whole
 * response for everyone; an item still refused is a bug. A live part left out
 * makes the read `unavailable`: read, but not in a form ECHO can show, which
 * `unshowable` reports.
 */
function checkedItem(item: PersonOpenItemV1, unshowable: () => void): PersonOpenItemV1 {
  const { current: _current, ...rest } = item;
  const withoutLive: PersonOpenItemV1 = item.reach === 'opened' ? { ...rest, reach: 'unavailable' } : rest;
  const { decision: _decision, ...withoutDecision } = item;
  const { decision: _both, ...withoutEither } = withoutLive;
  for (const candidate of [item, withoutLive, withoutDecision, withoutEither]) {
    let shown: PersonOpenItemV1;
    try { shown = validatePersonRunsResultV1('item', { item: candidate }).item; } catch { continue; /* the next, smaller form */ }
    if (shown.reach !== item.reach) unshowable();
    return shown;
  }
  return invalidOutput();
}

/** Where a read failed and the error's code, nothing else. An observer that fails never fails the read. */
function reportLiveFailure(sources: Pick<OpenItemSourcesV1, 'on_live_failure'>, reason: OpenItemsLiveFailureV1['reason'], code: string): void {
  const event = Object.freeze({ kind: 'open_items_live_read' as const, reason, code });
  try { (sources.on_live_failure ?? (value => { console.error(JSON.stringify(value)); }))(event); } catch { /* observation only */ }
}

/** The person an open-items read is for, as their session authorized them. */
export function openItemViewerV1(token: string, authorization: PersonAccessAuthorization): OpenItemViewerV1 {
  return Object.freeze({ token, authorization, organization: authorization.organization_id, principal: authorization.principal_id, membership: authorization.membership_id });
}
/** The viewer approved the item's decision: they sent it, once it is open. */
function approvedBy(row: ImpactItemRowV1, viewer: Viewer): boolean {
  return row.approver.membership_id === viewer.membership && row.approver.principal_id === viewer.principal;
}

/**
 * The policy's facts and answer for each row, with no live read: which
 * decisions the viewer reads now, who is still an active member, whether the
 * viewer leads one of a decision's projects, and whether the item reached its owner.
 */
export function assessOpenItemsV1(sources: Pick<OpenItemSourcesV1, 'records' | 'people'>, viewer: Viewer, found: readonly ImpactItemRowV1[], scopeRecords: readonly Sha256Digest[] = []): Context {
  const rows = found.filter(row => row.organization_id === viewer.organization);
  const records = [...new Set([...rows.map(row => row.record_sha256), ...scopeRecords])];
  const decisions = records.length === 0 ? new Map<Sha256Digest, PersonReadableDecisionV1>() : sources.records.readableDecisions({ access_token: viewer.token, record_sha256s: records });
  const people = sources.people.people(viewer.organization, [...new Set(rows.flatMap(row => [row.approver.membership_id, row.owner_membership_id, ...(row.check === null ? [] : [row.check.by])]))]);
  const leads = new Map<Sha256Digest, boolean>();
  const leadsDecision = (record: Sha256Digest): boolean => {
    if (!leads.has(record)) {
      const decision = decisions.get(record);
      leads.set(record, decision !== undefined && sources.people.leadsAny(viewer.membership, decision.project_ids));
    }
    return leads.get(record)!;
  };
  const assessed = rows.map(row => {
    const facts: OpenItemFactsV1 = Object.freeze({
      viewer: viewer.membership, approver: row.approver.membership_id, owner: row.owner_membership_id,
      approver_active: people.get(row.approver.membership_id)?.active === true, owner_active: people.get(row.owner_membership_id)?.active === true,
      // Sent, and Send included it, or it was reopened since: an open item waits on an owner who must be able to see it (R54).
      sent_to_owner: row.sent_at !== null && (row.send_included === true || row.state === 'open' || row.state === 'done'), state: row.state,
      reads_decision: decisions.has(row.record_sha256), leads_decision_project: leadsDecision(row.record_sha256),
    });
    return Object.freeze({ row, facts, access: openItemAccessV1(facts) });
  });
  return { decisions, people, assessed };
}

/** The impact card's first decided line, read once per run; only ever shown to a decision reader. A card that cannot be read gives none and is reported. */
function firstDecidedLines(sources: Pick<OpenItemSourcesV1, 'runs' | 'on_live_failure'>) {
  const lines = new Map<string, string | null>();
  return (run: TriggerRunRowV1 | string): string | null => {
    const runId = typeof run === 'string' ? run : run.run_id;
    if (!lines.has(runId)) {
      const row = typeof run === 'string' ? sources.runs.readUnfenced(run) : run;
      let line: string | null = null;
      try { if (row?.result_json !== null && row?.result_json !== undefined) line = readStoredImpactCardV1(row.result_json).decided[0]?.text ?? null; }
      catch (error) { reportLiveFailure(sources, 'first_line', codeOf(error)); line = null; }
      lines.set(runId, line);
    }
    return lines.get(runId)!;
  };
}
function decisionOf(decision: PersonReadableDecisionV1, first_line: string | null): PersonOpenItemDecisionV1 {
  return Object.freeze({
    approval_id: decision.approval_id, record_sha256: decision.record_sha256,
    title: impactCardLineV1(decision.title, LIMITS.name_chars) || 'Approved meeting', first_line, approved_at: decision.approved_at,
    project_ids: Object.freeze(decision.project_ids.slice(0, PERSON_UPLOAD_PROJECT_SET_MAX)),
  });
}
/**
 * Each row's decision part (its title, first decided line, approval time and
 * projects), exactly when the policy shows the viewer the decision. Each
 * run's stored card is read once.
 */
export function openItemDecisionPartsV1(sources: Pick<OpenItemSourcesV1, 'runs' | 'on_live_failure'>, context: Pick<Context, 'decisions'>): (entry: Assessed) => PersonOpenItemDecisionV1 | undefined {
  const firstLine = firstDecidedLines(sources);
  return ({ row, access }) => {
    const decision = access.see_decision ? context.decisions.get(row.record_sha256) : undefined;
    return decision === undefined ? undefined : decisionOf(decision, firstLine(row.run_id));
  };
}

/**
 * A sweep re-reads an item through its pointer, as a finding's citation the
 * sweep trigger takes: a ticket, a page, an ECHO record or document, and no
 * Slack message today. An item on any other pointer is never swept, so it
 * never makes a sweep due either.
 */
function sweepTakesItem(row: Pick<ImpactItemRowV1, 'pointer'>): boolean {
  // No Slack message: no desk can read a Slack citation yet, so a swept one would always be recorded unreadable (R62).
  try {
    SWEEP_TRIGGER.parseEvent({ findings: [{ finding: 'An open item', expected: 'the approved decision', citations: [row.pointer] }] });
    return true;
  } catch (error) {
    if (error instanceof AuthorityOperationError && error.code === 'invalid_request') return false;
    throw error;
  }
}
/**
 * The open items a sweep of `scope` rechecks for this viewer (section 6):
 * open, shown to the viewer by the policy, and on a pointer a sweep re-reads.
 * `mine` is what they sent or own; a decision's or a project's are its items
 * the viewer sees, as `items` shows them. `assessed` holds those items only.
 */
export function sweepScopeOpenItemsV1(sources: OpenItemSourcesV1, viewer: Viewer, scope: TriggerRunScopeV1): Context {
  let rows: readonly ImpactItemRowV1[];
  switch (scope.kind) {
    case 'mine':
      rows = sources.items.involving(viewer.organization, viewer.membership, { states: ['open'], limit: INVOLVING_MAX })
        .filter(row => approvedBy(row, viewer) || row.owner_membership_id === viewer.membership);
      break;
    case 'record':
      rows = sources.items.forRecords([scope.record_sha256], { states: ['open'], limit: SCOPE_ROWS_MAX });
      break;
    default:
      rows = sources.items.forRecords(sources.records.projectRecords({ access_token: viewer.token, project_id: scope.project_id, limit: PROJECT_RECORDS_MAX }), { states: ['open'], limit: SCOPE_ROWS_MAX });
  }
  const context = assessOpenItemsV1(sources, viewer, rows.filter(sweepTakesItem));
  return { ...context, assessed: context.assessed.filter(entry => entry.access.see_row) };
}

export function createPersonOpenItemsV1(options: CreatePersonOpenItemsV1Options): PersonOpenItemsApplicationV1 {
  const compatible = (options.live_sources ?? []).filter(source => source.minimum_response_version <= 6);
  const now = options.now ?? (() => new Date());
  const viewerOf = (access_token: string, signal?: AbortSignal): Viewer => {
    signal?.throwIfAborted();
    return openItemViewerV1(access_token, options.sessions.authenticateAccess({ access_token }));
  };
  const report = (reason: OpenItemsLiveFailureV1['reason'], code: string): void => reportLiveFailure(options, reason, code);
  /** The run was made for the viewer: they approved its decision. */
  const runFor = (run: TriggerRunRowV1, viewer: Viewer) => run.actor.membership_id === viewer.membership && run.actor.principal_id === viewer.principal;
  const actorOf = (viewer: Viewer) => ({ organization_id: viewer.organization, principal_id: viewer.principal, membership_id: viewer.membership });
  const requestContext = (viewer: Viewer): PersonLiveRequestContextV1 => ({
    authority_id: options.bind_options.authority_id, organization_id: viewer.organization, state_lineage_id: options.bind_options.state_lineage_id,
    principal_id: viewer.principal, membership_id: viewer.membership, session_family_id: viewer.authorization.session_family_id, request_id: `open_items_${randomUUID()}`,
  });
  const assess = (viewer: Viewer, found: readonly ImpactItemRowV1[], scopeRecords: readonly Sha256Digest[] = []): Context => assessOpenItemsV1(options, viewer, found, scopeRecords);

  /**
   * One desk for the request, bound to the viewer in the global scope; each
   * item opened at most once, at most 50 per call, then the desk's fence. An
   * open the desk refuses for the viewer's access (`unauthorized`,
   * `not_found`, `stale_access_state`), an empty one, or one that releases
   * anything but the item itself: the viewer cannot open it (`no_access`).
   * Any other failure says nothing about access: a desk that cannot be bound,
   * a provider down or rate limited, a timeout, or a fence that fails (then
   * nothing read in the request is shown) is `unavailable`, and reported.
   */
  const openLive = async (viewer: Viewer, rows: readonly ImpactItemRowV1[], signal?: AbortSignal): Promise<ReadonlyMap<Sha256Digest, LiveRead>> => {
    const targets = new Map<Sha256Digest, Pointer>();
    for (const row of rows) if (targets.size < LIVE_OPENS_MAX && !targets.has(row.item_key)) targets.set(row.item_key, row.pointer);
    if (targets.size === 0) return new Map();
    const withSignal = signal === undefined ? {} : { signal };
    const unavailable = Object.freeze({ reach: 'unavailable' as const });
    const noAccess = Object.freeze({ reach: 'no_access' as const });
    /** The whole request could not be read: every item tried is unavailable. A cancelled request is not an outage. */
    const outage = (reason: 'bind' | 'fence', error: unknown): ReadonlyMap<Sha256Digest, LiveRead> => {
      if (signal?.aborted === true) throw error;
      report(reason, codeOf(error));
      return new Map([...targets.keys()].map(key => [key, unavailable]));
    };
    let desk: Desk;
    try { desk = await options.bindDesk(options.bind_options, compatible, { access_token: viewer.token, scope: GLOBAL, ...withSignal }, requestContext(viewer)); }
    catch (error) { return outage('bind', error); }
    const reads = new Map<Sha256Digest, LiveRead>();
    const queue = [...targets];
    const openNext = async (): Promise<void> => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        const [key, pointer] = next;
        try {
          const result = await desk.openCitation!({ citation: pointer, ...withSignal });
          const item = result.items.find(entry => impactItemKeyV1(entry.citation) === key);
          reads.set(key, item === undefined ? noAccess : Object.freeze({ reach: 'opened' as const, item }));
        } catch (error) {
          if (signal?.aborted === true) throw error;
          if (refusedAccess(error)) { reads.set(key, noAccess); continue; }
          report('open', codeOf(error));
          reads.set(key, unavailable);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(LIVE_OPENS_AT_ONCE, queue.length) }, openNext));
    try { await desk.revalidate(withSignal); } catch (error) { return outage('fence', error); }
    return reads;
  };

  /** Rows the policy lets the viewer see, as the API carries them, with live parts from one open each. */
  const present = async (viewer: Viewer, context: Context, shown: readonly Assessed[], signal?: AbortSignal): Promise<readonly PersonOpenItemV1[]> => {
    const reads = await openLive(viewer, shown.map(entry => entry.row), signal);
    const decisionPart = openItemDecisionPartsV1(options, context);
    const unshowable = () => report('open', 'invalid_output');
    return Object.freeze(shown.map(entry => {
      const { row, facts } = entry;
      const read = reads.get(row.item_key);
      // The policy hears whether the viewer opened the item in this request; nothing, when no open was tried.
      const access = openItemAccessV1(read === undefined ? facts : { ...facts, opens_item: read.reach === 'opened' });
      const current = read?.reach === 'opened' && access.see_outside ? currentOf(read.item) : undefined;
      // A read the API cannot carry is ECHO's failure to read it, not the viewer's lack of access.
      if (read?.reach === 'opened' && access.see_outside && current === undefined) unshowable();
      const reach: PersonOpenItemReachV1 = read === undefined ? 'not_read' : read.reach !== 'opened' ? read.reach
        : !access.see_outside ? 'no_access' : current === undefined ? 'unavailable' : 'opened';
      const decision = decisionPart(entry);
      return checkedItem({
        item_id: row.item_id, run_id: row.run_id, kind: openItemKindV1(row.pointer),
        ...(decision === undefined ? {} : { decision }),
        ...(current === undefined ? {} : { current }),
        relation: row.relation, expected: row.expected,
        approver: personOf(context.people, row.approver.membership_id),
        owner: Object.freeze({ ...personOf(context.people, row.owner_membership_id), match: row.owner_match }),
        waits_on: access.waits_on, state: row.state,
        created_at: row.created_at, sent_at: row.sent_at, state_set_at: row.state_set_at,
        check: row.check === null ? null : Object.freeze({ verdict: row.check.verdict, checked_at: row.check.at, checked_by: nameOf(context.people, row.check.by) }),
        can: Object.freeze({ set_state: access.set_state, assign: access.assign }),
        reach,
      }, unshowable);
    }));
  };

  /** The item, when the policy lets this viewer take `right` on it. */
  const actable = (viewer: Viewer, itemId: string, right: 'set_state' | 'assign'): ImpactItemRowV1 => {
    const row = options.items.read(itemId);
    if (row === undefined) throw notFound();
    const entry = assess(viewer, [row]).assessed[0];
    if (entry === undefined || !entry.access.see_row) throw notFound();
    // An unsent item is its approver's to send first. Whoever could act on it once sent hears that; anyone else gets not_found.
    if (row.state === 'unsent') {
      if (openItemAccessV1({ ...entry.facts, state: 'open' })[right]) throw new AuthorityOperationError('invalid_request', 'Send it first');
      throw notFound();
    }
    if (!entry.access[right]) throw notFound();
    return row;
  };
  const activeMember = (viewer: Viewer, membershipId: string): void => {
    if (!options.people.isActiveMember(viewer.organization, membershipId)) throw new AuthorityOperationError('invalid_request', 'The owner must be an active member');
  };

  return Object.freeze({
    async home(input: Parameters<PersonOpenItemsApplicationV1['home']>[0]) {
      const viewer = viewerOf(input.access_token, input.signal);
      const actor = actorOf(viewer);
      const unsent = options.items.involving(viewer.organization, viewer.membership, { states: ['unsent'], limit: INVOLVING_MAX }).filter(row => approvedBy(row, viewer));
      const open = new Map<string, ImpactItemRowV1>();
      // Leads take an item when its approver and owner have both left.
      for (const row of [...options.items.involving(viewer.organization, viewer.membership, { states: ['open'], limit: INVOLVING_MAX }), ...options.items.orphaned(viewer.organization, { limit: INVOLVING_MAX })]) {
        if (row.state === 'open') open.set(row.item_id, row);
      }
      const context = assess(viewer, [...unsent, ...open.values()]);
      const firstLine = firstDecidedLines(options);

      // Send: the caller's own finished impact runs with an unsent item, which the send policy lets them send.
      const byRun = new Map<string, ImpactItemRowV1[]>();
      for (const row of unsent) byRun.set(row.run_id, [...(byRun.get(row.run_id) ?? []), row]);
      const send: PersonHomeSendV1[] = [];
      for (const [runId, rows] of byRun) {
        const run = options.runs.read(actor, runId);
        if (run === undefined || run.trigger !== 'approved_record' || run.state !== 'done' || run.record_sha256 === null) continue;
        const reads_decision = context.decisions.has(run.record_sha256);
        const { send: sends } = openItemSendAccessV1({ viewer: viewer.membership, approver: run.actor.membership_id, reads_decision });
        // A Send row names its decision, which only its sender, a reader, is shown.
        const decision = sends && openItemDecisionAccessV1({ reads_decision }).see_decision ? context.decisions.get(run.record_sha256) : undefined;
        if (decision === undefined) continue;
        const owners = [...new Set(rows.filter(row => row.owner_membership_id !== viewer.membership).map(row => nameOf(context.people, row.owner_membership_id)))];
        send.push(Object.freeze({
          run_id: runId, decision: decisionOf(decision, firstLine(run)), items: rows.length,
          kinds: Object.freeze(KIND_ORDER.filter(kind => rows.some(row => openItemKindV1(row.pointer) === kind))),
          owners: Object.freeze(owners.sort((left, right) => left.localeCompare(right)).slice(0, LIMITS.affected)), finished_at: run.updated_at,
        }));
      }
      send.sort((left, right) => ascending(right.finished_at, left.finished_at) || ascending(left.run_id, right.run_id));

      // Items: open items that wait on the caller, and those the caller approved whose last check saw them change.
      const visible = context.assessed.filter(entry => entry.row.state === 'open' && entry.access.see_row);
      const changed = (entry: Assessed) => entry.row.check?.verdict === 'changed';
      const shown = visible.filter(entry => entry.access.waits_on_viewer || (approvedBy(entry.row, viewer) && changed(entry)))
        .sort((left, right) => Number(changed(right)) - Number(changed(left)) || ascending(left.row.sent_at ?? '', right.row.sent_at ?? '') || oldestFirst(left.row, right.row))
        .slice(0, PERSON_HOME_ROWS_V1);

      // The footer counts open items the caller approved or owns, with no live read.
      const theirs = visible.filter(entry => approvedBy(entry.row, viewer) || entry.row.owner_membership_id === viewer.membership);
      const checks = theirs.flatMap(entry => (entry.row.check === null ? [] : [entry.row.check.at])).sort();

      // A sweep is due (section 6) for one of those items that a sweep would check and nobody checked in the last day, unless the
      // caller asked for a sweep in the last hour (R32: one that keeps failing, or leaves items unassessed, is not asked for on every
      // load) or one of theirs is running. A sweep still waiting after the hour lets the desktop ask again, which hands back that run
      // to start (R58). Check now is the caller's own request, and never limited.
      const time = now().getTime();
      const dayAgo = new Date(time - DAY_MS).toISOString();
      const stale = theirs.some(entry => (entry.row.check === null || entry.row.check.at < dayAgo) && sweepTakesItem(entry.row));
      const newest = stale ? options.runs.newestSweep(actor) : undefined;
      const sweep_due = stale && (newest === undefined || newest.created_at <= new Date(time - HOUR_MS).toISOString()) && options.runs.runningSweep(actor) === undefined;
      return checked('home', {
        send: send.slice(0, PERSON_HOME_ROWS_V1), items: await present(viewer, context, shown, input.signal),
        landed: theirs.filter(entry => entry.row.check?.verdict === 'landed').length,
        waiting: theirs.filter(entry => approvedBy(entry.row, viewer) && !entry.access.waits_on_viewer).length,
        last_checked_at: checks.at(-1) ?? null,
        sweep_due,
      });
    },

    async items(input: Parameters<PersonOpenItemsApplicationV1['items']>[0]) {
      const viewer = viewerOf(input.access_token, input.signal);
      const { request } = input;
      const after = request.cursor === undefined ? undefined : cursorAfter(request.cursor);
      let rows: readonly ImpactItemRowV1[];
      /** Decisions whose impact stage this scope shows when the viewer reads them, besides those of its visible rows. */
      let scopeRecords: readonly Sha256Digest[] = [];
      let projectRecords: readonly Sha256Digest[] | undefined;
      switch (request.scope) {
        case 'mine':
          rows = options.items.involving(viewer.organization, viewer.membership, { states: STATES, limit: SCOPE_ROWS_MAX });
          break;
        case 'run': {
          rows = options.items.forRun(request.id!);
          const run = options.runs.readUnfenced(request.id!);
          scopeRecords = run !== undefined && run.trigger === 'approved_record' && run.record_sha256 !== null && run.actor.organization_id === viewer.organization ? [run.record_sha256] : [];
          break;
        }
        case 'record':
          rows = options.items.forRecords([request.id as Sha256Digest], { states: STATES, limit: SCOPE_ROWS_MAX });
          scopeRecords = [request.id as Sha256Digest];
          break;
        default:
          // project: the records the viewer reads in it now, newest first.
          projectRecords = options.records.projectRecords({ access_token: input.access_token, project_id: request.id!, limit: PROJECT_RECORDS_MAX });
          rows = options.items.forRecords(projectRecords, { states: STATES, limit: SCOPE_ROWS_MAX });
      }
      const context = assess(viewer, rows, scopeRecords);
      const visible = context.assessed.filter(entry => entry.access.see_row).sort((left, right) => oldestFirst(left.row, right.row));
      const open = visible.filter(entry => entry.row.state === 'open');
      // Open items only (Did it land?): pages over them alone, so a closed item is never opened only to be left out (R51).
      const pageable = request.open_only === true ? open : visible;
      const following = after === undefined ? pageable : pageable.filter(entry => oldestFirst(entry.row, after) > 0);
      const page = following.slice(0, PERSON_OPEN_ITEMS_PAGE_V1);

      // The whole visible scope, counted with no live read. Last checks count on open items only: a check reads open items.
      const verdicts = (verdict: string) => open.filter(entry => entry.row.check?.verdict === verdict).length;
      // A decision is named, with its counts, only to those the policy shows its decision part. Of its open items, those whose
      // last check landed or could not read them, so a decision's open count reads as its Impact line does (R35).
      const byDecision = new Map<Sha256Digest, { unsent: number; open: number; landed: number; unreadable: number; latest: string }>();
      for (const { row, access } of visible) {
        if (!access.see_decision) continue;
        const counts = byDecision.get(row.record_sha256) ?? { unsent: 0, open: 0, landed: 0, unreadable: 0, latest: row.created_at };
        if (row.state === 'unsent') counts.unsent += 1;
        if (row.state === 'open') {
          counts.open += 1;
          if (row.check?.verdict === 'landed') counts.landed += 1;
          if (row.check?.verdict === 'unreadable') counts.unreadable += 1;
        }
        if (row.created_at > counts.latest) counts.latest = row.created_at;
        byDecision.set(row.record_sha256, counts);
      }
      const checkTimes = visible.flatMap(entry => (entry.row.check === null ? [] : [entry.row.check.at])).sort();
      const summary: PersonOpenItemsSummaryV1 = {
        unsent: visible.filter(entry => entry.row.state === 'unsent').length, open: open.length,
        done: visible.filter(entry => entry.row.state === 'done').length, not_relevant: visible.filter(entry => entry.row.state === 'not_relevant').length,
        landed: verdicts('landed'), changed: verdicts('changed'), unreadable: verdicts('unreadable'),
        decisions: new Set(visible.map(entry => entry.row.record_sha256)).size, last_checked_at: checkTimes.at(-1) ?? null,
        // Most recent decisions first, when a scope holds more than the API carries.
        by_decision: [...byDecision].sort(([leftRecord, left], [rightRecord, right]) => ascending(right.latest, left.latest) || ascending(leftRecord, rightRecord))
          .slice(0, SCOPE_DECISIONS_MAX).map(([record_sha256, { latest: _latest, ...counts }]) => ({ record_sha256, ...counts })),
      };

      // Each decision's impact check stage, for the decisions in scope the policy shows the viewer: a project lists the records they read now.
      const listed = new Set(projectRecords ?? []);
      const stageRecords = (projectRecords ?? [...new Set([...scopeRecords, ...visible.map(entry => entry.row.record_sha256)])])
        .filter(record => openItemDecisionAccessV1({ reads_decision: listed.has(record) || context.decisions.has(record) }).see_decision);
      const latestRun = new Map<Sha256Digest, TriggerRunRowV1>();
      for (const run of options.runs.impactRunsFor(stageRecords)) if (run.record_sha256 !== null) latestRun.set(run.record_sha256, run);
      // A check whose attempt stopped without finishing reads as pending, as its run is listed (R60).
      const at = now().toISOString();
      const stages: PersonImpactStageV1[] = stageRecords.flatMap(record => {
        const run = latestRun.get(record);
        return run === undefined ? [] : [{
          record_sha256: record, run_id: run.run_id, state: triggerRunStateAtV1(run, at), error_code: run.state === 'failed' ? run.error_code ?? 'research_failed' : null, mine: runFor(run, viewer),
        }];
      }).slice(0, SCOPE_DECISIONS_MAX);

      // Counts only (the project and Impact lines): no item is listed, so none is opened and no desk is bound.
      const countsOnly = request.summary_only === true;
      return checked('items', {
        items: countsOnly ? [] : await present(viewer, context, page, input.signal),
        next_cursor: !countsOnly && following.length > page.length ? cursorOf(page.at(-1)!.row) : null,
        summary, stages,
      });
    },

    async item(input: Parameters<PersonOpenItemsApplicationV1['item']>[0]) {
      const viewer = viewerOf(input.access_token, input.signal);
      const row = options.items.read(input.request.item_id);
      if (row === undefined) throw notFound();
      const context = assess(viewer, [row]);
      const entry = context.assessed[0];
      if (entry === undefined || !entry.access.see_row) throw notFound();
      return checked('item', { item: (await present(viewer, context, [entry], input.signal))[0] });
    },

    async send(input: Parameters<PersonOpenItemsApplicationV1['send']>[0]) {
      const viewer = viewerOf(input.access_token, input.signal);
      const { request } = input;
      const runNotFound = () => new AuthorityOperationError('not_found', 'run is not available');
      // Sends come from the caller's own finished impact run.
      const run = options.runs.read({ organization_id: viewer.organization, principal_id: viewer.principal, membership_id: viewer.membership }, request.run_id);
      if (run === undefined || run.trigger !== 'approved_record' || run.state !== 'done' || run.record_sha256 === null) throw runNotFound();
      // A command already sent answers what it did, whatever changed since: a retry never turns a committed send into an error.
      const earlier = options.items.sentBy(run.run_id, request.command_id);
      if (earlier !== undefined) return checked('send', earlier);
      // Only a new command is checked: the approver, while they can read the decision; picks who are active members; the items as drawn.
      const reads_decision = options.records.readableDecisions({ access_token: input.access_token, record_sha256s: [run.record_sha256] }).has(run.record_sha256);
      if (!openItemSendAccessV1({ viewer: viewer.membership, approver: run.actor.membership_id, reads_decision }).send) throw runNotFound();
      for (const choice of request.items) if (choice.owner_membership_id !== undefined) activeMember(viewer, choice.owner_membership_id);
      const result = options.items.send({ run_id: run.run_id, by: viewer.membership, command_id: request.command_id, choices: request.items });
      // A card drawn before the items changed: open them again. A conflict, not a loss of access (the desktop reads that as signed out).
      if (result.kind === 'stale') throw new AuthorityOperationError('conflict', 'The items changed. Open them again.');
      return checked('send', { sent: result.sent, not_relevant: result.not_relevant });
    },

    async set_state(input: Parameters<PersonOpenItemsApplicationV1['set_state']>[0]) {
      const viewer = viewerOf(input.access_token, input.signal);
      const row = actable(viewer, input.request.item_id, 'set_state');
      // A click that changes nothing writes nothing: an item Send left unticked keeps its stamp (R13), and a closed item who closed it.
      if (row.state === input.request.state) return checked('set_state', { state: row.state });
      const updated = options.items.setState(row.item_id, input.request.state, viewer.membership);
      if (updated === undefined) throw notFound();
      return checked('set_state', { state: updated.state });
    },

    async assign(input: Parameters<PersonOpenItemsApplicationV1['assign']>[0]) {
      const viewer = viewerOf(input.access_token, input.signal);
      const row = actable(viewer, input.request.item_id, 'assign');
      activeMember(viewer, input.request.owner_membership_id);
      // Its own owner again changes nothing, so nothing is written: the item keeps how its owner was found.
      let owner = row.owner_membership_id;
      if (owner !== input.request.owner_membership_id) {
        const updated = options.items.assign(row.item_id, input.request.owner_membership_id, viewer.membership);
        if (updated === undefined) throw notFound();
        owner = updated.owner_membership_id;
      }
      return checked('assign', { owner: personOf(options.people.people(viewer.organization, [owner]), owner) });
    },

    async sweep(input: Parameters<PersonOpenItemsApplicationV1['sweep']>[0]): Promise<PersonRunsResultsV1['sweep']> {
      const viewer = viewerOf(input.access_token, input.signal);
      const { request } = input;
      const scope: TriggerRunScopeV1 = request.scope === 'mine' ? { kind: 'mine' }
        : request.scope === 'record' ? { kind: 'record', record_sha256: request.id as Sha256Digest } : { kind: 'project', project_id: request.id! };
      // A scope with nothing the caller can see to check queues nothing, and says nothing of whether its record or project exists.
      if (sweepScopeOpenItemsV1(options, viewer, scope).assessed.length === 0) return checked('sweep', { state: 'nothing_to_check' });
      // The caller's waiting or running sweep of the same scope, else a new one; the desktop starts it after any pending impact check.
      return checked('sweep', { run_id: options.runs.enqueueSweep(actorOf(viewer), scope).run_id });
    },
  });
}
