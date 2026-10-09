/**
 * Who may see and act on an open item (open items and Home v1, section 4;
 * ADR-0033). Every open-items operation asks this function; nothing else
 * decides access. These rules are a foundation (founder, 2026-10-08): a later
 * organization rule, such as an admin or an org-wide view, changes this
 * function and its facts, not the table or the queries. An outside item's
 * words stay behind `opens_item` whatever the rules become (ADR-0032).
 */
export interface OpenItemFactsV1 {
  readonly viewer: string;                     // membership ids throughout
  readonly approver: string;
  readonly owner: string;
  readonly approver_active: boolean;
  readonly owner_active: boolean;
  /**
   * The item has gone to its owner: it is `open`, or was before it closed.
   * Send opens the items it ticks, and a later click can open one too. False
   * while the item is `unsent`, and for an item Send left unticked that no
   * one has opened since. Send closes those as `not_relevant` but still sets
   * their `sent_at`, so `sent_at` alone does not answer this.
   */
  readonly sent_to_owner: boolean;
  /**
   * The item's stage. An unsent item waits on its approver to send it (on the
   * decision's project leads when the approver has left), and nobody sets its
   * state or reassigns it before Send: Send picks its owner. A closed item
   * waits on no one.
   */
  readonly state: 'unsent' | 'open' | 'done' | 'not_relevant';
  /** The viewer passes the exact record check for the item's decision now. */
  readonly reads_decision: boolean;
  /** The viewer is an active lead of one of the decision's projects. */
  readonly leads_decision_project: boolean;
  /** The viewer opened the item in its tool in this request; absent when no open was tried. */
  readonly opens_item?: boolean;
}
export interface OpenItemAccessV1 {
  readonly see_row: boolean;
  readonly see_outside: boolean;
  readonly set_state: boolean;
  readonly assign: boolean;
  /** Who the item waits on now: the owner, else the approver, else the decision's project leads; an unsent item, its approver, else the leads. */
  readonly waits_on: 'owner' | 'approver' | 'leads';
  readonly waits_on_viewer: boolean;
}
export function openItemAccessV1(facts: OpenItemFactsV1): OpenItemAccessV1 {
  const owner = facts.viewer === facts.owner;
  const approver = facts.viewer === facts.approver;
  const see_row = facts.reads_decision || (owner && facts.sent_to_owner);
  const unsent = facts.state === 'unsent';
  const closed = facts.state === 'done' || facts.state === 'not_relevant';
  const waits_on = !unsent && facts.owner_active ? 'owner' as const : facts.approver_active ? 'approver' as const : 'leads' as const;
  return Object.freeze({
    see_row,
    see_outside: see_row && facts.opens_item === true,
    set_state: see_row && !unsent && (approver || owner),
    assign: see_row && !unsent && (approver || owner || facts.leads_decision_project),
    waits_on,
    waits_on_viewer: see_row && !closed && (waits_on === 'owner' ? owner : waits_on === 'approver' ? approver : facts.leads_decision_project),
  });
}
