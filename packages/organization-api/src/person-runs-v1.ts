import { validatePersonAnswerCitationV6 } from './person-answer-v4.js';
import type { PersonAnswerCitationV6 } from './person-answer-v8.js';
import { validatePersonDiagnosticCaptureIdV1, type PersonDiagnosticCaptureIdV1 } from './person-diagnostics-v1.js';
import { PERSON_IMPACT_CARD_LIMITS_V1, validatePersonImpactCardV1, type PersonImpactCardV1 } from './person-impact-card-v1.js';
import { PERSON_UPLOAD_PROJECT_SET_MAX } from './person-upload-audience-v3.js';
import { validateProjectIdV1 } from './project-context-v1.js';
import {
  asEnumerableRecord, assertDigest, assertExactKeys, assertId, assertString, assertTimestamp, assertUnique as unique, boundedLine as line, boundedList as list, fail, oneOf,
  openItemId as itemId, utf8ByteLength,
} from './validation.js';

/**
 * Trigger runs (runs store and impact card v1, section 5; ADR-0032). A signed-in
 * person lists the runs made for their own approvals, starts the oldest
 * pending one, asks to try a failed one again, and views a finished one as an
 * impact card. One envelope: `{schema_version: 1, operation, ...}`.
 *
 * A run holds no word read from outside ECHO. `view` rebuilds the card from
 * fresh reads for the viewer on every call and the API never returns more than
 * the card, its check time and how many cited items the viewer could not open.
 *
 * Open items (open items and Home v1, section 7; ADR-0033) are the items a
 * finished impact run found, one shared row each: the approved meeting's own
 * actions (follow-ups thread v1) and the existing items the meeting affects.
 * `home` lists what waits on the caller, `items` and `item` show the rows the
 * caller can see, and `send`, `set_state` and `assign` change them. A row's
 * own fields are ECHO's: its decision is shown only to a viewer who can read
 * it, and what the item says now only to a viewer who opened it in its tool
 * in this request. Each row says how that live read went (`reach`), so an
 * outage is never shown as lost access. `read` says how much to read:
 * `rows` answers the same rows with no live read, so a list shows them at once
 * and reads live only the rows it shows; `counts` (`items` only) answers the
 * counts and stages alone and opens nothing. `items` with `states` pages over
 * the items in those states only, so a list reads its current work first and
 * never opens a closed item to throw it away; `mine` and `involved` with
 * `changed_since` page over the items sent, handed on or set since then, so a
 * change check's reader pages only what moved, not every closed item. Each
 * decision's counts say how many of its open items last landed or could not
 * be read, and its stage says whether its impact run is the caller's own
 * (`mine`).
 *
 * Sweep (open items and Home v1, sections 6 and 7) rechecks open items
 * against what was decided and keeps only a verdict per item. `sweep` asks for
 * a sweep of the caller's items (`mine`: those they sent or own), of a
 * decision (`record`) or of a project (`project`), over the items the caller
 * can see; it answers the run, or `nothing_to_check`. `home` reports
 * `sweep_due` when an open item the caller sent or owns was last checked, by
 * anyone, more than 24 hours ago or never, none of their sweeps was asked for
 * in the last hour, and none is running (at most hourly, so a sweep that
 * keeps failing is not asked for on every load; a sweep still waiting after
 * the hour is asked for again, and `sweep` hands back that run to start; an
 * explicit `sweep` request is never limited). `home` read as `rows` never
 * reports a sweep due. `home` lists the newest handoffs first (the latest
 * of `sent_at`, `owner_set_at` and `state_set_at`), with changed items first
 * only when those times tie. Notification discovery pages through `items`
 * separately so Home's twenty-row display limit does not hide assignments.
 */
export const PERSON_RUNS_PATH_V1 = '/v1/person/runs';

export type PersonRunStateV1 = 'pending' | 'running' | 'done' | 'failed';
export type PersonRunErrorCodeV1 = 'no_access' | 'unavailable' | 'timed_out' | 'research_failed';

/**
 * How much an open-items read reads; absent, it reads each row live. `rows`: the same answer with no live read, so every item's
 * reach is `not_read` and no desk is bound (`home` then never says a sweep is due, so a quiet background check never starts
 * one; follow-ups thread v1, F8). `counts` (`items` only): the summary and stages alone, no items and no cursor.
 */
export type PersonOpenItemsReadV1 = 'rows' | 'counts';

// `list` and `home` are separate variants so `Extract<…, { operation: 'list' }>` still names one.
export type PersonRunsRequestV1 =
  | { readonly schema_version: 1; readonly operation: 'list' }
  | { readonly schema_version: 1; readonly operation: 'home'; readonly read?: 'rows' }
  | { readonly schema_version: 1; readonly operation: 'start'; readonly run_id: string; readonly capture_id?: PersonDiagnosticCaptureIdV1 }
  | { readonly schema_version: 1; readonly operation: 'retry'; readonly run_id: string }
  | { readonly schema_version: 1; readonly operation: 'view'; readonly run_id: string }
  | { readonly schema_version: 1; readonly operation: 'items'; readonly scope: 'mine' | 'involved' | 'run' | 'record' | 'project'; readonly id?: string; readonly cursor?: string;
      readonly read?: PersonOpenItemsReadV1;
      /**
       * Items in these states only (a non-empty subset, each once; never beside `counts`): the page and its cursor go over them
       * alone, while the summary and stages still cover the whole scope. A cursor pages the same list: the caller sends the same
       * states with it.
       */
      readonly states?: readonly PersonOpenItemStateV1[];
      /**
       * `mine` and `involved` only, never beside `counts` (desktop refresh and notifications v1; ADR-0036): items whose latest
       * of when they were sent, their owner set and their state set is at or after this UTC millisecond time. Like `states`, it
       * narrows the page and its cursor alone (the caller sends it again with a cursor); the summary and stages still cover the
       * whole scope.
       */
      readonly changed_since?: string }
  | { readonly schema_version: 1; readonly operation: 'item'; readonly item_id: string; readonly read?: 'rows' }
  | { readonly schema_version: 1; readonly operation: 'send'; readonly run_id: string; readonly command_id: string;
      /**
       * Any non-empty subset of the run's unsent items (follow-ups thread v1, F1): `include: true` sends one to its owner
       * (`open`, with an optional owner pick), `include: false` dismisses it (`not_relevant`), and an unsent item not listed
       * stays unsent. A listed item that is no longer unsent answers `conflict` and nothing is written. A `command_id` already
       * sent answers its first counts again when it lists the same items, and `conflict` when it lists any others.
       */
      readonly items: readonly { readonly item_id: string; readonly include: boolean; readonly owner_membership_id?: string }[] }
  | { readonly schema_version: 1; readonly operation: 'set_state'; readonly item_id: string; readonly state: 'open' | 'done' | 'not_relevant' }
  /**
   * Changes an item's owner to an active member. Before Send only its approver may (the owner is stored at once, `picked`;
   * follow-ups thread v1, F2); once sent, its approver, its owner or a lead of one of the decision's active projects
   * (`reassigned`). Its current owner again writes nothing, except the approver taking on an item ECHO gave them for want of
   * a match (`approver`): that is stored as their choice (`picked`, or `reassigned` once sent).
   */
  | { readonly schema_version: 1; readonly operation: 'assign'; readonly item_id: string; readonly owner_membership_id: string }
  | { readonly schema_version: 1; readonly operation: 'sweep'; readonly scope: 'mine' | 'record' | 'project'; readonly id?: string };

export interface PersonRunV1 {
  readonly run_id: string; readonly trigger: 'approved_record' | 'sweep'; readonly event_ref: string;
  readonly state: PersonRunStateV1; readonly error_code: PersonRunErrorCodeV1 | null;
  readonly created_at: string; readonly updated_at: string;
}

export type PersonOpenItemStateV1 = 'unsent' | 'open' | 'done' | 'not_relevant';
export type PersonOpenItemVerdictV1 = 'landed' | 'still_open' | 'changed' | 'unreadable';
/**
 * What an item is: an action the approved meeting decided (`action`, follow-ups thread v1), or an existing item the impact
 * check found the meeting affects: a Jira ticket, a page, another ECHO record or an ECHO document.
 */
export type PersonOpenItemKindV1 = 'action' | 'ticket' | 'page' | 'record' | 'document';
export type PersonOpenItemOwnerMatchV1 = 'jira_account' | 'name' | 'picked' | 'approver' | 'reassigned';
/**
 * How this request's live read of an item went, for this viewer. `opened`: it
 * was read, and `current` shows it. `no_access`: the viewer's own access
 * refused it. `unavailable`: the read failed otherwise (an outage, a rate
 * limit, a timeout), which says nothing about access. `not_read`: no read was
 * tried for it in this request.
 */
export type PersonOpenItemReachV1 = 'opened' | 'no_access' | 'unavailable' | 'not_read';
export interface PersonOpenItemPersonV1 { readonly membership_id: string; readonly name: string; readonly active: boolean }
/** Only for a viewer who can read the decision now. ECHO data. */
export interface PersonOpenItemDecisionV1 {
  readonly approval_id: string; readonly record_sha256: string; readonly title: string;
  /** The impact card's first decided line, when it has one. */
  readonly first_line: string | null;
  readonly approved_at: string; readonly project_ids: readonly string[];
}
/** Only for a viewer who opened the item in its tool in this request. Read live, never stored. */
export interface PersonOpenItemCurrentV1 {
  readonly citation: PersonAnswerCitationV6;
  /** The first 300 characters of its text on one line, else its title and details. */
  readonly says_now: string;
  readonly assignee?: string; readonly status?: string; readonly due_at?: string;
}
export interface PersonOpenItemV1 {
  readonly item_id: string; readonly run_id: string; readonly kind: PersonOpenItemKindV1;
  readonly decision?: PersonOpenItemDecisionV1;
  readonly current?: PersonOpenItemCurrentV1;
  readonly relation: 'conflicts' | 'needs_updating' | null;
  readonly expected: string | null;
  readonly approver: PersonOpenItemPersonV1;
  readonly owner: PersonOpenItemPersonV1 & { readonly match: PersonOpenItemOwnerMatchV1 };
  readonly waits_on: 'owner' | 'approver' | 'leads';
  readonly state: PersonOpenItemStateV1;
  readonly created_at: string; readonly sent_at: string | null; readonly state_set_at: string | null;
  /** Who last set its state (Send included), with `state_set_at`; null exactly when `state_set_at` is (follow-ups thread v1, F3). */
  readonly state_set_by: PersonOpenItemPersonV1 | null;
  /** When and by whom its owner was last picked or reassigned; both null while the owner is the one ECHO matched. */
  readonly owner_set_at: string | null; readonly owner_set_by: PersonOpenItemPersonV1 | null;
  /**
   * What Send did with it, as stored and then frozen: null while it is unsent, true when Send included it (it went to its owner),
   * false when Send dismissed it. A later state change leaves it as Send set it.
   */
  readonly send_included: boolean | null;
  readonly check: { readonly verdict: PersonOpenItemVerdictV1; readonly checked_at: string; readonly checked_by: string } | null;
  readonly can: { readonly set_state: boolean; readonly assign: boolean };
  /** `current` comes exactly with `opened`. */
  readonly reach: PersonOpenItemReachV1;
}
export interface PersonHomeSendV1 {
  readonly run_id: string; readonly decision: PersonOpenItemDecisionV1;
  readonly items: number; readonly kinds: readonly PersonOpenItemKindV1[];
  /** Owner names other than the approver, each once. */
  readonly owners: readonly string[];
  readonly finished_at: string;
}
export interface PersonOpenItemsSummaryV1 {
  readonly unsent: number; readonly open: number; readonly done: number; readonly not_relevant: number;
  readonly landed: number; readonly changed: number; readonly unreadable: number;
  readonly decisions: number; readonly last_checked_at: string | null;
  readonly by_decision: readonly PersonOpenItemsDecisionCountV1[];
}
/** One decision's items in a summary. */
export interface PersonOpenItemsDecisionCountV1 {
  readonly record_sha256: string; readonly unsent: number; readonly open: number;
  /** Of `open`: items whose last check is `landed`, and `unreadable` (so `landed + unreadable <= open`). */
  readonly landed: number; readonly unreadable: number;
}
export interface PersonImpactStageV1 {
  readonly record_sha256: string; readonly run_id: string;
  readonly state: PersonRunStateV1; readonly error_code: PersonRunErrorCodeV1 | null;
  /** The stage's run is the caller's own: they approved the decision, so they may Send or Try again. */
  readonly mine: boolean;
}

export interface PersonRunsResultsV1 {
  list: { readonly runs: readonly PersonRunV1[] };
  /**
   * `running` while an attempt is going, this call's or an earlier one's. `pending` when nothing started and the run stays
   * queued: a run is held, unclaimed, while the search index has not caught up (an impact run's decision is not yet searchable,
   * or a sweep would anchor its decisions and read ECHO records through it). Holding costs the Authority a few reads,
   * so start it again at the next look; unlike `busy`, it is no reason to wait longer.
   */
  start: { readonly state: 'pending' | 'running' | 'busy' | 'done' | 'failed' };
  retry: { readonly state: 'pending' };
  view: { readonly card: PersonImpactCardV1; readonly checked_at: string; readonly hidden: number };
  home: { readonly send: readonly PersonHomeSendV1[];
          /** At most twenty: newest handoffs first; changed items break ties. */
          readonly items: readonly PersonOpenItemV1[];
          readonly landed: number; readonly waiting: number; readonly last_checked_at: string | null;
          /** The caller's open items are due a sweep (section 6): the desktop asks for a `mine` sweep. At most hourly: not within an hour of their last sweep, nor while one of theirs runs. */
          readonly sweep_due: boolean };
  items: { readonly items: readonly PersonOpenItemV1[]; readonly next_cursor: string | null;
           readonly summary: PersonOpenItemsSummaryV1; readonly stages: readonly PersonImpactStageV1[] };
  item: { readonly item: PersonOpenItemV1 };
  send: { readonly sent: number; readonly not_relevant: number };
  set_state: { readonly state: 'open' | 'done' | 'not_relevant' };
  assign: { readonly owner: PersonOpenItemPersonV1 };
  sweep: { readonly run_id: string } | { readonly state: 'nothing_to_check' };
}

/** A card, or a page of open items with their citations, is far below 1 MiB. */
export const PERSON_RUNS_MAX_RESPONSE_BYTES_V1 = 1024 * 1024;
/** The most runs one list returns. */
export const PERSON_RUNS_LIST_LIMIT_V1 = 100;
/** The most open items one `items` page returns. */
export const PERSON_OPEN_ITEMS_PAGE_V1 = 50;
/** The most Send rows, and the most item rows, one `home` returns. */
export const PERSON_HOME_ROWS_V1 = 20;
/**
 * The most meeting actions one impact run makes into items: the first ones in brief order that have text (an action with
 * none makes no item and takes no place). An approved meeting with more actions than this has the rest only in its record.
 */
export const PERSON_RUN_MEETING_ACTIONS_MAX_V1 = 20;
/** The most items one impact run makes: one per affected row of its card, and one per meeting action up to the cap. */
export const PERSON_RUN_ITEMS_MAX_V1 = PERSON_IMPACT_CARD_LIMITS_V1.affected + PERSON_RUN_MEETING_ACTIONS_MAX_V1;

const RUN_ID = /^run_[A-Za-z0-9-]{4,60}$/;
const COMMAND_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,256}$/;
const STATES: readonly string[] = ['pending', 'running', 'done', 'failed'];
const TRIGGERS: readonly string[] = ['approved_record', 'sweep'];
const ERROR_CODES: readonly string[] = ['no_access', 'unavailable', 'timed_out', 'research_failed'];
const REQUEST_KEYS: Readonly<Record<PersonRunsRequestV1['operation'], readonly string[]>> = Object.freeze({
  list: [], home: [], start: ['run_id'], retry: ['run_id'], view: ['run_id'], items: ['scope'], item: ['item_id'],
  send: ['run_id', 'command_id', 'items'], set_state: ['item_id', 'state'], assign: ['item_id', 'owner_membership_id'], sweep: ['scope'],
});
/** Each result's keys; null for a result with more than one shape, whose own case checks them. */
const RESULT_KEYS: Readonly<Record<keyof PersonRunsResultsV1, readonly string[] | null>> = Object.freeze({
  list: ['runs'], start: ['state'], retry: ['state'], view: ['card', 'checked_at', 'hidden'],
  home: ['send', 'items', 'landed', 'waiting', 'last_checked_at', 'sweep_due'], items: ['items', 'next_cursor', 'summary', 'stages'],
  item: ['item'], send: ['sent', 'not_relevant'], set_state: ['state'], assign: ['owner'], sweep: null,
});
const START_STATES: readonly string[] = ['pending', 'running', 'busy', 'done', 'failed'];
/** `involved` (desktop refresh and notifications v1; ADR-0036): `mine` plus the items you last handed on, that you may read. */
const SCOPES = ['mine', 'involved', 'run', 'record', 'project'] as const;
/** A sweep checks the caller's items, a decision's or a project's; a run's items are its decision's. */
const SWEEP_SCOPES = ['mine', 'record', 'project'] as const;
const SET_STATES = ['open', 'done', 'not_relevant'] as const;
const ITEM_STATES = ['unsent', ...SET_STATES] as const;
const VERDICTS = ['landed', 'still_open', 'changed', 'unreadable'] as const;
const KINDS = ['action', 'ticket', 'page', 'record', 'document'] as const;
const OWNER_MATCHES = ['jira_account', 'name', 'picked', 'approver', 'reassigned'] as const;
const RELATIONS = ['conflicts', 'needs_updating'] as const;
const WAITS_ON = ['owner', 'approver', 'leads'] as const;
const REACHES = ['opened', 'no_access', 'unavailable', 'not_read'] as const;
const CURRENT_DETAILS = ['assignee', 'status', 'due_at'] as const;
/** Names, decided lines and what an item says now are bounded as the impact card bounds them. */
const LIMITS = PERSON_IMPACT_CARD_LIMITS_V1;
/** A send lists, and a Send row names the owners of, at most a run's items. */
const RUN_ITEMS_MAX = PERSON_RUN_ITEMS_MAX_V1;
/** The most decisions one `items` summary, or its stages, cover. */
const SCOPE_DECISIONS_MAX = 100;
/** ECHO's phrase of what the decision requires of an item. */
const EXPECTED_CHARS = 120;
/** An item's status or due date; the evidence desk bounds each to 128 bytes. */
const DETAIL_CHARS = 128;

function matching(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) fail(`${label} is invalid`);
  return value;
}

function runId(value: unknown, label: string): string {
  return matching(value, RUN_ID, label);
}

function membershipId(value: unknown, label: string): string {
  assertId(value, 'mem', label);
  return value as string;
}

function recordId(value: unknown, label: string): string {
  assertDigest(value, label);
  return value;
}

function count(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(`${label} is invalid`);
  return value;
}

function timestampOrNull(value: unknown, label: string): string | null {
  if (value === null) return null;
  assertTimestamp(value, label);
  return value;
}

function scopeId(scope: 'run' | 'record' | 'project', value: unknown): string {
  const label = 'Runs request scope id';
  if (scope === 'run') return runId(value, label);
  if (scope === 'record') return recordId(value, label);
  return validateProjectIdV1(value, label);
}

/** The request's read mode, when it names one of `modes`. */
function readMode<T extends PersonOpenItemsReadV1>(request: Record<string, unknown>, modes: readonly T[]): { readonly read?: T } {
  return Object.hasOwn(request, 'read') ? { read: oneOf(request.read, modes, 'Runs request read') } : {};
}

function sendItems(value: unknown): Extract<PersonRunsRequestV1, { readonly operation: 'send' }>['items'] {
  const items = list(value, 'Runs request send list', RUN_ITEMS_MAX, 1).map(raw => {
    const entry = asEnumerableRecord(raw, 'Runs request send item');
    const picked = Object.hasOwn(entry, 'owner_membership_id');
    assertExactKeys(entry, ['item_id', 'include', ...(picked ? ['owner_membership_id'] : [])], 'Runs request send item');
    if (typeof entry.include !== 'boolean') fail('Runs request send include is invalid');
    // Only a ticked item goes to an owner.
    if (picked && !entry.include) fail('Runs request send owner needs a ticked item');
    return Object.freeze({
      item_id: itemId(entry.item_id, 'Runs request send item id'), include: entry.include,
      ...(picked ? { owner_membership_id: membershipId(entry.owner_membership_id, 'Runs request send owner') } : {}),
    });
  });
  unique(items.map(item => item.item_id), 'Runs request send list');
  return Object.freeze(items);
}

export function validatePersonRunsRequestV1(value: unknown): PersonRunsRequestV1 {
  const request = asEnumerableRecord(value, 'Runs request');
  const operation = request.operation;
  if (typeof operation !== 'string' || !Object.hasOwn(REQUEST_KEYS, operation)) fail('Runs request operation is invalid');
  const kind = operation as PersonRunsRequestV1['operation'];
  // `items` may leave out its scope id and its cursor, and may ask for items in some states only; `home`, `items` and `item` may
  // say how much to read; a sweep of `mine` names no id.
  const optional = (kind === 'items' ? ['id', 'cursor', 'read', 'states', 'changed_since'] : kind === 'home' || kind === 'item' ? ['read'] : kind === 'start' ? ['capture_id'] : kind === 'sweep' ? ['id'] : [])
    .filter(key => Object.hasOwn(request, key));
  assertExactKeys(request, ['schema_version', 'operation', ...REQUEST_KEYS[kind], ...optional], 'Runs request');
  if (request.schema_version !== 1) fail('Runs request version is invalid');
  switch (kind) {
    case 'list':
      return Object.freeze({ schema_version: 1 as const, operation: kind });
    case 'home':
      return Object.freeze({ schema_version: 1 as const, operation: kind, ...readMode(request, ['rows'] as const) });
    case 'start':
      return Object.freeze({ schema_version: 1 as const, operation: kind, run_id: runId(request.run_id, 'Runs request run id'),
        ...(Object.hasOwn(request, 'capture_id') ? { capture_id: validatePersonDiagnosticCaptureIdV1(request.capture_id) } : {}) });
    case 'retry':
    case 'view':
      return Object.freeze({ schema_version: 1 as const, operation: kind, run_id: runId(request.run_id, 'Runs request run id') });
    case 'items': {
      const scope = oneOf(request.scope, SCOPES, 'Runs request scope');
      // `mine` and `involved` name no id; every other scope names its run, record or project.
      const personal = scope === 'mine' || scope === 'involved';
      if (personal === Object.hasOwn(request, 'id')) fail('Runs request scope id is invalid');
      const read = readMode(request, ['rows', 'counts'] as const);
      const filtered = Object.hasOwn(request, 'states');
      // Counts cover the whole scope at once and list no items: no next page to ask for, and nothing to filter.
      if (read.read === 'counts' && (Object.hasOwn(request, 'cursor') || filtered)) fail('Runs request counts takes no cursor or states');
      const states = filtered ? list(request.states, 'Runs request states', ITEM_STATES.length, 1).map(state => oneOf(state, ITEM_STATES, 'Runs request state')) : [];
      unique(states, 'Runs request states');
      // What changed since a time: one person's own items only, and a list to page, never the counts of a whole scope.
      const since = Object.hasOwn(request, 'changed_since');
      if (since && (!personal || read.read === 'counts')) fail('Runs request changed_since is for a mine or involved list');
      if (since) assertTimestamp(request.changed_since, 'Runs request changed_since');
      return Object.freeze({
        schema_version: 1 as const, operation: kind, scope,
        ...(scope === 'mine' || scope === 'involved' ? {} : { id: scopeId(scope, request.id) }),
        ...(Object.hasOwn(request, 'cursor') ? { cursor: matching(request.cursor, CURSOR, 'Runs request cursor') } : {}),
        ...read,
        ...(filtered ? { states: Object.freeze(states) } : {}),
        ...(since ? { changed_since: request.changed_since as string } : {}),
      });
    }
    case 'item':
      return Object.freeze({ schema_version: 1 as const, operation: kind, item_id: itemId(request.item_id, 'Runs request item id'), ...readMode(request, ['rows'] as const) });
    case 'send':
      return Object.freeze({
        schema_version: 1 as const, operation: kind, run_id: runId(request.run_id, 'Runs request run id'),
        command_id: matching(request.command_id, COMMAND_ID, 'Runs request command id'), items: sendItems(request.items),
      });
    case 'set_state':
      return Object.freeze({ schema_version: 1 as const, operation: kind, item_id: itemId(request.item_id, 'Runs request item id'), state: oneOf(request.state, SET_STATES, 'Runs request state') });
    case 'sweep': {
      const scope = oneOf(request.scope, SWEEP_SCOPES, 'Runs request scope');
      // As for `items`: `mine` names no id; a record or project scope names its record or project.
      if ((scope === 'mine') === Object.hasOwn(request, 'id')) fail('Runs request scope id is invalid');
      return Object.freeze({ schema_version: 1 as const, operation: kind, scope, ...(scope === 'mine' ? {} : { id: scopeId(scope, request.id) }) });
    }
    default:
      // assign
      return Object.freeze({
        schema_version: 1 as const, operation: kind, item_id: itemId(request.item_id, 'Runs request item id'),
        owner_membership_id: membershipId(request.owner_membership_id, 'Runs request owner'),
      });
  }
}

/** A run's state, with a reason exactly when it failed. */
function runState(entry: Record<string, unknown>, label: string): void {
  if (typeof entry.state !== 'string' || !STATES.includes(entry.state)) fail(`${label} state is invalid`);
  if (entry.error_code !== null && (typeof entry.error_code !== 'string' || !ERROR_CODES.includes(entry.error_code))) fail(`${label} error code is invalid`);
  if ((entry.state === 'failed') !== (entry.error_code !== null)) fail(`${label} error code does not match its state`);
}

function run(value: unknown): PersonRunV1 {
  const entry = asEnumerableRecord(value, 'Run');
  assertExactKeys(entry, ['run_id', 'trigger', 'event_ref', 'state', 'error_code', 'created_at', 'updated_at'], 'Run');
  runId(entry.run_id, 'Run id');
  if (typeof entry.trigger !== 'string' || !TRIGGERS.includes(entry.trigger)) fail('Run trigger is invalid');
  assertString(entry.event_ref, 'Run event ref', 128);
  runState(entry, 'Run');
  assertTimestamp(entry.created_at, 'Run created_at');
  assertTimestamp(entry.updated_at, 'Run updated_at');
  return Object.freeze({
    run_id: entry.run_id as string, trigger: entry.trigger as PersonRunV1['trigger'], event_ref: entry.event_ref as string, state: entry.state as PersonRunStateV1,
    error_code: entry.error_code as PersonRunErrorCodeV1 | null, created_at: entry.created_at as string, updated_at: entry.updated_at as string,
  });
}

function member(entry: Record<string, unknown>, label: string): PersonOpenItemPersonV1 {
  if (typeof entry.active !== 'boolean') fail(`${label} active flag is invalid`);
  return { membership_id: membershipId(entry.membership_id, `${label} membership id`), name: line(entry.name, `${label} name`, LIMITS.name_chars), active: entry.active };
}

function person(value: unknown, label: string): PersonOpenItemPersonV1 {
  const entry = asEnumerableRecord(value, label);
  assertExactKeys(entry, ['membership_id', 'name', 'active'], label);
  return Object.freeze(member(entry, label));
}

function owner(value: unknown): PersonOpenItemV1['owner'] {
  const entry = asEnumerableRecord(value, 'Open item owner');
  assertExactKeys(entry, ['membership_id', 'name', 'active', 'match'], 'Open item owner');
  return Object.freeze({ ...member(entry, 'Open item owner'), match: oneOf(entry.match, OWNER_MATCHES, 'Open item owner match') });
}

function decision(value: unknown): PersonOpenItemDecisionV1 {
  const entry = asEnumerableRecord(value, 'Open item decision');
  assertExactKeys(entry, ['approval_id', 'record_sha256', 'title', 'first_line', 'approved_at', 'project_ids'], 'Open item decision');
  // The same approval id a run names as its event ref.
  assertString(entry.approval_id, 'Open item decision approval id', 128);
  assertTimestamp(entry.approved_at, 'Open item decision approved_at');
  return Object.freeze({
    approval_id: entry.approval_id as string, record_sha256: recordId(entry.record_sha256, 'Open item decision record'),
    title: line(entry.title, 'Open item decision title', LIMITS.name_chars),
    first_line: entry.first_line === null ? null : line(entry.first_line, 'Open item decision first line', LIMITS.line_chars),
    approved_at: entry.approved_at as string,
    // A decision's projects are among its record's associations.
    project_ids: Object.freeze(list(entry.project_ids, 'Open item decision project list', PERSON_UPLOAD_PROJECT_SET_MAX).map(id => validateProjectIdV1(id, 'Open item decision project id'))),
  });
}

function current(value: unknown): PersonOpenItemCurrentV1 {
  const entry = asEnumerableRecord(value, 'Open item current part');
  assertExactKeys(entry, ['citation', 'says_now', ...CURRENT_DETAILS.filter(key => Object.hasOwn(entry, key))], 'Open item current part');
  return Object.freeze({
    citation: validatePersonAnswerCitationV6(entry.citation), says_now: line(entry.says_now, 'Open item says_now', LIMITS.line_chars),
    ...(Object.hasOwn(entry, 'assignee') ? { assignee: line(entry.assignee, 'Open item assignee', LIMITS.name_chars) } : {}),
    ...(Object.hasOwn(entry, 'status') ? { status: line(entry.status, 'Open item status', DETAIL_CHARS) } : {}),
    ...(Object.hasOwn(entry, 'due_at') ? { due_at: line(entry.due_at, 'Open item due date', DETAIL_CHARS) } : {}),
  });
}

function check(value: unknown): PersonOpenItemV1['check'] {
  if (value === null) return null;
  const entry = asEnumerableRecord(value, 'Open item check');
  assertExactKeys(entry, ['verdict', 'checked_at', 'checked_by'], 'Open item check');
  assertTimestamp(entry.checked_at, 'Open item checked_at');
  return Object.freeze({ verdict: oneOf(entry.verdict, VERDICTS, 'Open item check verdict'), checked_at: entry.checked_at as string, checked_by: line(entry.checked_by, 'Open item checked_by', LIMITS.name_chars) });
}

function can(value: unknown): PersonOpenItemV1['can'] {
  const entry = asEnumerableRecord(value, 'Open item permission set');
  assertExactKeys(entry, ['set_state', 'assign'], 'Open item permission set');
  if (typeof entry.set_state !== 'boolean' || typeof entry.assign !== 'boolean') fail('Open item permission set is invalid');
  return Object.freeze({ set_state: entry.set_state, assign: entry.assign });
}

function openItem(value: unknown): PersonOpenItemV1 {
  const entry = asEnumerableRecord(value, 'Open item');
  // What a viewer may not see is left out, never sent empty.
  const parts = ['decision', 'current'].filter(key => Object.hasOwn(entry, key));
  assertExactKeys(entry, ['item_id', 'run_id', 'kind', 'relation', 'expected', 'approver', 'owner', 'waits_on', 'state', 'created_at', 'sent_at', 'state_set_at',
    'state_set_by', 'owner_set_at', 'owner_set_by', 'send_included', 'check', 'can', 'reach', ...parts], 'Open item');
  assertTimestamp(entry.created_at, 'Open item created_at');
  const reach = oneOf(entry.reach, REACHES, 'Open item reach');
  // What the item says now comes exactly with a read that opened it.
  if ((reach === 'opened') !== Object.hasOwn(entry, 'current')) fail('Open item reach does not match its current part');
  const state = oneOf(entry.state, ITEM_STATES, 'Open item state');
  const state_set_at = timestampOrNull(entry.state_set_at, 'Open item state_set_at');
  const owner_set_at = timestampOrNull(entry.owner_set_at, 'Open item owner_set_at');
  const state_set_by = entry.state_set_by === null ? null : person(entry.state_set_by, 'Open item state_set_by');
  const owner_set_by = entry.owner_set_by === null ? null : person(entry.owner_set_by, 'Open item owner_set_by');
  // Who and when come together, as the item stores them.
  if ((state_set_by === null) !== (state_set_at === null)) fail('Open item state_set_by does not match state_set_at');
  if ((owner_set_by === null) !== (owner_set_at === null)) fail('Open item owner_set_by does not match owner_set_at');
  if (entry.send_included !== null && typeof entry.send_included !== 'boolean') fail('Open item send_included is invalid');
  // Send sets it, exactly as the item leaves unsent; nothing sets it before.
  if ((state === 'unsent') !== (entry.send_included === null)) fail('Open item send_included does not match its state');
  return Object.freeze({
    item_id: itemId(entry.item_id, 'Open item id'), run_id: runId(entry.run_id, 'Open item run id'), kind: oneOf(entry.kind, KINDS, 'Open item kind'),
    ...(Object.hasOwn(entry, 'decision') ? { decision: decision(entry.decision) } : {}),
    ...(Object.hasOwn(entry, 'current') ? { current: current(entry.current) } : {}),
    relation: entry.relation === null ? null : oneOf(entry.relation, RELATIONS, 'Open item relation'),
    expected: entry.expected === null ? null : line(entry.expected, 'Open item expected', EXPECTED_CHARS),
    approver: person(entry.approver, 'Open item approver'), owner: owner(entry.owner),
    waits_on: oneOf(entry.waits_on, WAITS_ON, 'Open item waits_on'), state,
    created_at: entry.created_at as string, sent_at: timestampOrNull(entry.sent_at, 'Open item sent_at'), state_set_at,
    state_set_by, owner_set_at, owner_set_by, send_included: entry.send_included,
    check: check(entry.check), can: can(entry.can), reach,
  });
}

function sendRow(value: unknown): PersonHomeSendV1 {
  const entry = asEnumerableRecord(value, 'Home send row');
  assertExactKeys(entry, ['run_id', 'decision', 'items', 'kinds', 'owners', 'finished_at'], 'Home send row');
  const kinds = list(entry.kinds, 'Home send row kind list', KINDS.length).map(kind => oneOf(kind, KINDS, 'Home send row kind'));
  unique(kinds, 'Home send row kind list');
  const owners = list(entry.owners, 'Home send row owner list', RUN_ITEMS_MAX).map(name => line(name, 'Home send row owner', LIMITS.name_chars));
  unique(owners, 'Home send row owner list');
  assertTimestamp(entry.finished_at, 'Home send row finished_at');
  return Object.freeze({
    run_id: runId(entry.run_id, 'Home send row run id'), decision: decision(entry.decision), items: count(entry.items, 'Home send row item count'),
    kinds: Object.freeze(kinds), owners: Object.freeze(owners), finished_at: entry.finished_at as string,
  });
}

function summary(value: unknown): PersonOpenItemsSummaryV1 {
  const entry = asEnumerableRecord(value, 'Open items summary');
  assertExactKeys(entry, ['unsent', 'open', 'done', 'not_relevant', 'landed', 'changed', 'unreadable', 'decisions', 'last_checked_at', 'by_decision'], 'Open items summary');
  const total = (key: string) => count(entry[key], `Open items summary ${key} count`);
  return Object.freeze({
    unsent: total('unsent'), open: total('open'), done: total('done'), not_relevant: total('not_relevant'),
    landed: total('landed'), changed: total('changed'), unreadable: total('unreadable'),
    decisions: total('decisions'), last_checked_at: timestampOrNull(entry.last_checked_at, 'Open items summary last_checked_at'),
    by_decision: Object.freeze(list(entry.by_decision, 'Open items summary decision list', SCOPE_DECISIONS_MAX).map(raw => {
      const row = asEnumerableRecord(raw, 'Open items decision count');
      assertExactKeys(row, ['record_sha256', 'unsent', 'open', 'landed', 'unreadable'], 'Open items decision count');
      const decided: PersonOpenItemsDecisionCountV1 = {
        record_sha256: recordId(row.record_sha256, 'Open items decision count record'),
        unsent: count(row.unsent, 'Open items decision unsent count'), open: count(row.open, 'Open items decision open count'),
        landed: count(row.landed, 'Open items decision landed count'), unreadable: count(row.unreadable, 'Open items decision unreadable count'),
      };
      // Both are last checks of open items: together never more than the open ones.
      if (decided.landed + decided.unreadable > decided.open) fail('Open items decision count is inconsistent');
      return Object.freeze(decided);
    })),
  });
}

function stage(value: unknown): PersonImpactStageV1 {
  const entry = asEnumerableRecord(value, 'Impact stage');
  assertExactKeys(entry, ['record_sha256', 'run_id', 'state', 'error_code', 'mine'], 'Impact stage');
  runState(entry, 'Impact stage');
  if (typeof entry.mine !== 'boolean') fail('Impact stage mine flag is invalid');
  return Object.freeze({
    record_sha256: recordId(entry.record_sha256, 'Impact stage record'), run_id: runId(entry.run_id, 'Impact stage run id'),
    state: entry.state as PersonRunStateV1, error_code: entry.error_code as PersonRunErrorCodeV1 | null, mine: entry.mine,
  });
}

/** Transport bounds apply before parsing; the Authority runs the same checks on what it sends. */
export function validatePersonRunsResultV1<K extends keyof PersonRunsResultsV1>(operation: K, value: unknown): PersonRunsResultsV1[K] {
  if (typeof operation !== 'string' || !Object.hasOwn(RESULT_KEYS, operation)) fail('Runs response operation is invalid');
  const result = asEnumerableRecord(value, 'Runs response');
  const keys = RESULT_KEYS[operation];
  if (keys !== null) assertExactKeys(result, keys, 'Runs response');
  const checked = (response: PersonRunsResultsV1[keyof PersonRunsResultsV1]): PersonRunsResultsV1[K] => {
    if (utf8ByteLength(JSON.stringify(response)) > PERSON_RUNS_MAX_RESPONSE_BYTES_V1) fail('Runs response exceeds its bound');
    return Object.freeze(response) as PersonRunsResultsV1[K];
  };
  switch (operation) {
    case 'list':
      if (!Array.isArray(result.runs) || result.runs.length > PERSON_RUNS_LIST_LIMIT_V1) fail('Runs list is invalid');
      return checked({ runs: Object.freeze(result.runs.map(run)) });
    case 'start':
      if (typeof result.state !== 'string' || !START_STATES.includes(result.state)) fail('Runs start state is invalid');
      return checked({ state: result.state as PersonRunsResultsV1['start']['state'] });
    case 'retry':
      if (result.state !== 'pending') fail('Runs retry state is invalid');
      return checked({ state: 'pending' });
    case 'view': {
      const card = validatePersonImpactCardV1(result.card);
      assertTimestamp(result.checked_at, 'Runs view checked_at');
      if (typeof result.hidden !== 'number' || !Number.isSafeInteger(result.hidden) || result.hidden < 0) fail('Runs view hidden count is invalid');
      return checked({ card, checked_at: result.checked_at, hidden: result.hidden });
    }
    case 'home':
      if (typeof result.sweep_due !== 'boolean') fail('Home sweep_due is invalid');
      return checked({
        send: Object.freeze(list(result.send, 'Home send row list', PERSON_HOME_ROWS_V1).map(sendRow)),
        items: Object.freeze(list(result.items, 'Home item list', PERSON_HOME_ROWS_V1).map(openItem)),
        landed: count(result.landed, 'Home landed count'), waiting: count(result.waiting, 'Home waiting count'),
        last_checked_at: timestampOrNull(result.last_checked_at, 'Home last_checked_at'), sweep_due: result.sweep_due,
      });
    case 'items':
      return checked({
        items: Object.freeze(list(result.items, 'Open items page', PERSON_OPEN_ITEMS_PAGE_V1).map(openItem)),
        next_cursor: result.next_cursor === null ? null : matching(result.next_cursor, CURSOR, 'Open items next cursor'),
        summary: summary(result.summary), stages: Object.freeze(list(result.stages, 'Impact stage list', SCOPE_DECISIONS_MAX).map(stage)),
      });
    case 'item':
      return checked({ item: openItem(result.item) });
    case 'send':
      return checked({ sent: count(result.sent, 'Send sent count'), not_relevant: count(result.not_relevant, 'Send not-relevant count') });
    case 'set_state':
      return checked({ state: oneOf(result.state, SET_STATES, 'Set state result') });
    case 'sweep':
      // A sweep answers its run, or that nothing is open to check.
      if (Object.hasOwn(result, 'run_id')) {
        assertExactKeys(result, ['run_id'], 'Runs response');
        return checked({ run_id: runId(result.run_id, 'Sweep run id') });
      }
      assertExactKeys(result, ['state'], 'Runs response');
      if (result.state !== 'nothing_to_check') fail('Sweep state is invalid');
      return checked({ state: 'nothing_to_check' });
    default:
      // assign
      return checked({ owner: person(result.owner, 'Assigned owner') });
  }
}
