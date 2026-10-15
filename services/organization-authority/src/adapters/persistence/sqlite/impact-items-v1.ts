import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { AUTHORITY_BASELINE_SCHEMA_VERSION, isCurrentAuthorityState } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/baseline';
import { canonicalJson, type Sha256Digest } from '@echo-brain/federation-protocol';
import type { TriggerRunRowV1 } from './trigger-runs-v1.js';

export type ImpactItemStateV1 = 'unsent' | 'open' | 'done' | 'not_relevant';
export type ImpactItemVerdictV1 = 'landed' | 'still_open' | 'changed' | 'unreadable';
export type ImpactOwnerMatchV1 = 'jira_account' | 'name' | 'picked' | 'approver' | 'reassigned';
/** One affected item an impact run found, as its finishing transaction stores it. */
export interface ImpactItemDraftV1 {
  readonly item_key: Sha256Digest;
  /** A stored citation pointer, no text. */
  readonly pointer: Readonly<Record<string, unknown>>;
  readonly relation: 'conflicts' | 'needs_updating' | null;
  readonly expected: string | null;
  readonly owner_membership_id: string;
  readonly owner_match: 'jira_account' | 'name' | 'approver';
}
export interface ImpactItemRowV1 {
  readonly item_id: string; readonly run_id: string; readonly item_key: Sha256Digest; readonly pointer: Readonly<Record<string, unknown>>;
  readonly record_sha256: Sha256Digest; readonly organization_id: string;
  readonly approver: { readonly principal_id: string; readonly membership_id: string };
  readonly relation: 'conflicts' | 'needs_updating' | null; readonly expected: string | null;
  readonly owner_membership_id: string; readonly owner_match: ImpactOwnerMatchV1;
  /** Who last picked or reassigned the owner, and when; both null while the owner is the one the impact run matched. */
  readonly owner_set_by: string | null; readonly owner_set_at: string | null;
  readonly state: ImpactItemStateV1; readonly state_set_by: string | null; readonly state_set_at: string | null;
  readonly sent_at: string | null; readonly send_command_id: string | null;
  /** Whether Send included the item: null before Send, then frozen. Only an included item went to its owner. */
  readonly send_included: boolean | null;
  readonly check: { readonly verdict: ImpactItemVerdictV1; readonly by: string; readonly at: string; readonly run_id: string } | null;
  readonly created_at: string; readonly updated_at: string;
}
export interface ImpactSendChoiceV1 { readonly item_id: string; readonly include: boolean; readonly owner_membership_id?: string }
/** What a committed send command answers when it is asked again: its own counts, or `stale` when it is asked for other items. */
export type ImpactSendReplayV1 = { readonly kind: 'replayed'; readonly sent: number; readonly not_relevant: number } | { readonly kind: 'stale' };

interface StoredItemV1 {
  readonly item_id: string; readonly run_id: string; readonly item_key: Sha256Digest; readonly pointer_json: string;
  readonly record_sha256: Sha256Digest; readonly organization_id: string; readonly approver_principal_id: string; readonly approver_membership_id: string;
  readonly relation: ImpactItemRowV1['relation']; readonly expected: string | null; readonly owner_membership_id: string; readonly owner_match: ImpactOwnerMatchV1;
  readonly owner_set_by: string | null; readonly owner_set_at: string | null;
  readonly state: ImpactItemStateV1; readonly state_set_by: string | null; readonly state_set_at: string | null;
  readonly sent_at: string | null; readonly send_command_id: string | null; readonly send_included: 0 | 1 | null;
  readonly checked_verdict: ImpactItemVerdictV1 | null; readonly checked_by: string | null; readonly checked_at: string | null; readonly checked_run_id: string | null;
  readonly created_at: string; readonly updated_at: string;
}
const selectItems = `SELECT item.item_id, item.run_id, item.item_key, item.pointer_json, item.record_sha256, item.organization_id,
  item.approver_principal_id, item.approver_membership_id, item.relation, item.expected, item.owner_membership_id, item.owner_match,
  item.owner_set_by, item.owner_set_at, item.state, item.state_set_by, item.state_set_at, item.sent_at, item.send_command_id, item.send_included,
  item.checked_verdict, item.checked_by, item.checked_at, item.checked_run_id, item.created_at, item.updated_at
  FROM authority_impact_items_v1 AS item`;
const ORDER = 'ORDER BY item.created_at, item.item_id';

function frozen<T>(value: T): T {
  if (typeof value === 'object' && value !== null) for (const entry of Object.values(value)) frozen(entry);
  return Object.freeze(value);
}
function publicItem(value: StoredItemV1): ImpactItemRowV1 {
  return Object.freeze({
    item_id: value.item_id, run_id: value.run_id, item_key: value.item_key, pointer: frozen(JSON.parse(value.pointer_json) as Record<string, unknown>),
    record_sha256: value.record_sha256, organization_id: value.organization_id,
    approver: Object.freeze({ principal_id: value.approver_principal_id, membership_id: value.approver_membership_id }),
    relation: value.relation, expected: value.expected, owner_membership_id: value.owner_membership_id, owner_match: value.owner_match,
    owner_set_by: value.owner_set_by, owner_set_at: value.owner_set_at, state: value.state, state_set_by: value.state_set_by, state_set_at: value.state_set_at, sent_at: value.sent_at, send_command_id: value.send_command_id,
    send_included: value.send_included === null ? null : value.send_included === 1,
    check: value.checked_verdict === null ? null
      : Object.freeze({ verdict: value.checked_verdict, by: value.checked_by!, at: value.checked_at!, run_id: value.checked_run_id! }),
    created_at: value.created_at, updated_at: value.updated_at,
  });
}
function limitOf(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError('Open item limit must be a non-negative integer');
  return limit;
}

/**
 * The shared open items (open items and Home v1, section 2; ADR-0033): one row
 * per item an approved decision affects. The database keeps structure only and
 * nothing here is fenced: every caller asks the open-items access policy before
 * it returns or changes a row.
 */
export class SqliteImpactItemsV1 {
  constructor(private readonly database: Database.Database, private readonly now: () => Date = () => new Date()) {
    if (!isCurrentAuthorityState(database)) {
      throw new Error(`Open items require Authority V${AUTHORITY_BASELINE_SCHEMA_VERSION} state with foreign keys enabled`);
    }
  }

  /** Inside the impact run's finishing transaction (`SqliteTriggerRunsV1.finish`'s `then`). `itm_<uuid>` ids. */
  insertForRun(transaction: Database.Database, run: TriggerRunRowV1, drafts: readonly ImpactItemDraftV1[]): void {
    if (!transaction.inTransaction) throw new Error('Open items are written inside the impact run finishing transaction');
    const timestamp = this.timestamp();
    const insert = transaction.prepare(`INSERT INTO authority_impact_items_v1
      (item_id, run_id, item_key, pointer_json, record_sha256, organization_id, approver_principal_id, approver_membership_id,
       relation, expected, owner_membership_id, owner_match, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unsent', ?, ?)`);
    for (const draft of drafts) {
      insert.run(`itm_${randomUUID()}`, run.run_id, draft.item_key, canonicalJson(draft.pointer), run.record_sha256,
        run.actor.organization_id, run.actor.principal_id, run.actor.membership_id,
        draft.relation, draft.expected, draft.owner_membership_id, draft.owner_match, timestamp, timestamp);
    }
  }

  /** Not fenced. */
  read(itemId: string): ImpactItemRowV1 | undefined {
    const found = this.database.prepare(`${selectItems} WHERE item.item_id=?`).get(itemId) as StoredItemV1 | undefined;
    return found === undefined ? undefined : publicItem(found);
  }

  forRun(runId: string): readonly ImpactItemRowV1[] {
    return (this.database.prepare(`${selectItems} WHERE item.run_id=? ${ORDER}`).all(runId) as StoredItemV1[]).map(publicItem);
  }

  /** Oldest first by created_at, then item_id; `after` is the last row of the previous page. */
  forRecords(recordSha256s: readonly Sha256Digest[], options: { readonly states: readonly ImpactItemStateV1[]; readonly limit: number; readonly after?: { readonly created_at: string; readonly item_id: string } }): readonly ImpactItemRowV1[] {
    const limit = limitOf(options.limit);
    if (recordSha256s.length === 0 || options.states.length === 0 || limit === 0) return [];
    const after = options.after;
    return (this.database.prepare(`${selectItems}
      WHERE item.record_sha256 IN (SELECT value FROM json_each(?)) AND item.state IN (SELECT value FROM json_each(?))
      ${after === undefined ? '' : 'AND (item.created_at > ? OR (item.created_at = ? AND item.item_id > ?))'} ${ORDER} LIMIT ?`).all(
      JSON.stringify([...new Set(recordSha256s)]), JSON.stringify([...new Set(options.states)]),
      ...(after === undefined ? [] : [after.created_at, after.created_at, after.item_id]), limit) as StoredItemV1[]).map(publicItem);
  }

  /** Items this member approved or owns. */
  involving(organizationId: string, membershipId: string, options: { readonly states: readonly ImpactItemStateV1[]; readonly limit: number }): readonly ImpactItemRowV1[] {
    const limit = limitOf(options.limit);
    if (options.states.length === 0 || limit === 0) return [];
    return (this.database.prepare(`${selectItems}
      WHERE item.organization_id=? AND (item.approver_membership_id=? OR item.owner_membership_id=?) AND item.state IN (SELECT value FROM json_each(?))
      ${ORDER} LIMIT ?`).all(organizationId, membershipId, membershipId, JSON.stringify([...new Set(options.states)]), limit) as StoredItemV1[]).map(publicItem);
  }

  /** Unsent or open items whose approver and owner memberships are both inactive. */
  orphaned(organizationId: string, options: { readonly limit: number }): readonly ImpactItemRowV1[] {
    const limit = limitOf(options.limit);
    if (limit === 0) return [];
    return (this.database.prepare(`${selectItems}
      JOIN authority_memberships AS approver ON approver.membership_id = item.approver_membership_id
      JOIN authority_memberships AS owner ON owner.membership_id = item.owner_membership_id
      WHERE item.organization_id=? AND item.state IN ('unsent', 'open') AND approver.status != 'active' AND owner.status != 'active'
      ${ORDER} LIMIT ?`).all(organizationId, limit) as StoredItemV1[]).map(publicItem);
  }

  /**
   * What a send of the run under `command_id` did, from its immutable choices;
   * undefined when no item of the run carries it. A retry lists the same items
   * (in any order; what it says to include or whom it picks is ignored: the
   * first answer stands). A command id listed with any other items is `stale`,
   * so an old answer never leaves new items unsent. Later state changes do not
   * change a committed command's answer.
   */
  sentBy(runId: string, commandId: string, itemIds: readonly string[]): ImpactSendReplayV1 | undefined {
    const choices = this.database.prepare('SELECT item_id, send_included FROM authority_impact_items_v1 WHERE run_id=? AND send_command_id=?')
      .all(runId, commandId) as Pick<StoredItemV1, 'item_id' | 'send_included'>[];
    if (choices.length === 0) return undefined;
    const listed = new Set(itemIds);
    if (listed.size !== itemIds.length || listed.size !== choices.length || choices.some(choice => !listed.has(choice.item_id))) return Object.freeze({ kind: 'stale' as const });
    const sent = choices.filter(choice => choice.send_included === 1).length;
    return Object.freeze({ kind: 'replayed' as const, sent, not_relevant: choices.length - sent });
  }

  /**
   * One immediate transaction. Replayed when any item of the run carries `command_id` and `choices` lists exactly those items;
   * stale when it lists any others (`sentBy`).
   * `choices` is any non-empty subset of the run's unsent items (follow-ups thread v1, F1): stale when
   * the run has no unsent item, or a choice names an item twice or names one that is not an unsent item
   * of the run. Included → open, with the picked owner (`owner_match = picked`) when one is given and
   * differs, or is the approver the item fell back to (`approver`); excluded → not_relevant
   * (dismissed); an unsent item `choices` leaves out stays unsent, untouched. Freezes send_included,
   * sets sent_at, send_command_id, state_set_by/at = `by` on each chosen item.
   */
  send(input: { readonly run_id: string; readonly by: string; readonly command_id: string; readonly choices: readonly ImpactSendChoiceV1[] }):
    { readonly kind: 'sent' | 'replayed'; readonly sent: number; readonly not_relevant: number } | { readonly kind: 'stale' } {
    return this.immediate(() => {
      const earlier = this.sentBy(input.run_id, input.command_id, input.choices.map(choice => choice.item_id));
      if (earlier !== undefined) return earlier;
      const items = this.database.prepare('SELECT item_id, owner_membership_id, owner_match, state FROM authority_impact_items_v1 WHERE run_id=?')
        .all(input.run_id) as Pick<StoredItemV1, 'item_id' | 'owner_membership_id' | 'owner_match' | 'state'>[];
      const unsent = new Map(items.filter(item => item.state === 'unsent').map(item => [item.item_id, item]));
      const chosen = new Set(input.choices.map(choice => choice.item_id));
      if (unsent.size === 0 || chosen.size === 0 || chosen.size !== input.choices.length || [...chosen].some(id => !unsent.has(id))) {
        return Object.freeze({ kind: 'stale' as const });
      }
      const timestamp = this.timestamp();
      const move = this.database.prepare(`UPDATE authority_impact_items_v1 SET state=?, sent_at=?, send_command_id=?, send_included=?, state_set_by=?, state_set_at=?, updated_at=?
        WHERE item_id=? AND run_id=? AND state='unsent'`);
      const pick = this.database.prepare(`UPDATE authority_impact_items_v1 SET owner_membership_id=?, owner_match='picked', owner_set_by=?, owner_set_at=?, updated_at=?
        WHERE item_id=? AND run_id=? AND state='unsent'`);
      let sent = 0;
      for (const choice of input.choices) {
        const owner = choice.owner_membership_id;
        const current = unsent.get(choice.item_id)!;
        // The approver ECHO fell back to, picked, is picked: the item no longer waits for an owner to be chosen.
        if (choice.include && owner !== undefined && (owner !== current.owner_membership_id || current.owner_match === 'approver')) {
          pick.run(owner, input.by, timestamp, timestamp, choice.item_id, input.run_id);
        }
        const changes = move.run(choice.include ? 'open' : 'not_relevant', timestamp, input.command_id, choice.include ? 1 : 0, input.by, timestamp, timestamp, choice.item_id, input.run_id).changes;
        if (changes !== 1) throw new Error('Open item send lost its item');
        if (choice.include) sent++;
      }
      return Object.freeze({ kind: 'sent' as const, sent, not_relevant: input.choices.length - sent });
    });
  }

  /** undefined when the item is missing or still unsent. */
  setState(itemId: string, state: 'open' | 'done' | 'not_relevant', by: string): ImpactItemRowV1 | undefined {
    return this.immediate(() => {
      const timestamp = this.timestamp();
      const changes = this.database.prepare(`UPDATE authority_impact_items_v1 SET state=?, state_set_by=?, state_set_at=?, updated_at=?
        WHERE item_id=? AND state!='unsent'`).run(state, by, timestamp, timestamp, itemId).changes;
      return changes === 1 ? this.read(itemId) : undefined;
    });
  }

  /**
   * Stores the owner at once, with who set it and when: `owner_match = picked` on an item still unsent (an owner picked before
   * Send, follow-ups thread v1, F2), `reassigned` once it is sent. It writes even when the owner is the current one: the caller
   * decides when that changes nothing (the runs service: unless the item fell back to its approver). Undefined when the item is
   * missing.
   */
  assign(itemId: string, ownerMembershipId: string, by: string): ImpactItemRowV1 | undefined {
    return this.immediate(() => {
      const timestamp = this.timestamp();
      const changes = this.database.prepare(`UPDATE authority_impact_items_v1 SET owner_membership_id=?,
        owner_match=CASE WHEN state='unsent' THEN 'picked' ELSE 'reassigned' END, owner_set_by=?, owner_set_at=?, updated_at=?
        WHERE item_id=?`).run(ownerMembershipId, by, timestamp, timestamp, itemId).changes;
      return changes === 1 ? this.read(itemId) : undefined;
    });
  }

  /** In the sweep's finishing transaction. False when the item holds an equal or newer check. */
  recordCheck(transaction: Database.Database, input: { readonly item_id: string; readonly verdict: ImpactItemVerdictV1; readonly by: string; readonly at: string; readonly run_id: string }): boolean {
    if (!transaction.inTransaction) throw new Error('An open item check is recorded inside the sweep finishing transaction');
    // Checks are ordered as strings, so only the canonical ISO form keeps string order equal to time order.
    if (typeof input.at !== 'string' || Number.isNaN(Date.parse(input.at)) || new Date(input.at).toISOString() !== input.at) throw new TypeError('Open item check time is invalid');
    return transaction.prepare(`UPDATE authority_impact_items_v1 SET checked_verdict=?, checked_by=?, checked_at=?, checked_run_id=?, updated_at=?
      WHERE item_id=? AND (checked_at IS NULL OR checked_at < ?)`).run(
      input.verdict, input.by, input.at, input.run_id, this.timestamp(), input.item_id, input.at).changes === 1;
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError('Open item clock returned an invalid date');
    return value.toISOString();
  }
  private immediate<T>(operation: () => T): T {
    if (this.database.inTransaction) throw new Error('Open item operation needs an idle database');
    return this.database.transaction(operation).immediate();
  }
}
