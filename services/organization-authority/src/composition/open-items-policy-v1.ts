/**
 * Who may see and act on an open item, and who may send a run's items (open
 * items and Home v1, section 4; ADR-0033). Every open-items operation asks
 * these functions; nothing else decides access. These rules are a foundation
 * (founder, 2026-10-08): a later organization rule, such as an admin or an
 * org-wide view, changes these functions and their facts, not the table or
 * the queries. An outside item's words stay behind `opens_item` whatever the
 * rules become (ADR-0032).
 */
export interface OpenItemFactsV1 {
  readonly viewer: string;                     // membership ids throughout
  readonly approver: string;
  readonly owner: string;
  readonly approver_active: boolean;
  readonly owner_active: boolean;
  /**
   * The item has reached its owner: it was sent, and Send included it, or it
   * is `open` or `done` since (an approver who reopens an item Send
   * dismissed hands it to its owner, who must be able to see what waits on
   * them). False while the item is `unsent`, and for an item Send dismissed
   * that stays `not_relevant`. Send closes those but still sets their
   * `sent_at`, so `sent_at` alone does not answer this. For a follow-up from
   * a chat it is exactly whether Send included it: a dismissed draft never
   * reaches its owner, whatever its state.
   */
  readonly sent_to_owner: boolean;
  /**
   * The item's stage. An unsent item waits on its approver to send it (on the
   * decision's project leads when the approver has left). Nobody sets its
   * state before Send, and only its approver, who may send it, picks its
   * owner before Send (follow-ups thread v1, F2). A closed item waits on no
   * one.
   */
  readonly state: 'unsent' | 'open' | 'done' | 'not_relevant';
  /** The viewer passes the exact record check for the item's decision now. */
  readonly reads_decision: boolean;
  /** The viewer is an active lead of one of the decision's projects. */
  readonly leads_decision_project: boolean;
  /** The viewer opened the item in its tool in this request; absent when no open was tried. */
  readonly opens_item?: boolean;
  /**
   * A follow-up from a chat (ADR-0053): no run and no decision stand behind it, and `approver` is the person who created it.
   * Its creator always sees it; its owner sees it once it reached them; nobody else ever does. It has no project, so no lead
   * acts on it, and `reads_decision` and `leads_decision_project` are false.
   */
  readonly from_chat: boolean;
}
export interface OpenItemAccessV1 {
  readonly see_row: boolean;
  /** The viewer may see the decision part (title, first line, approval time, projects). */
  readonly see_decision: boolean;
  readonly see_outside: boolean;
  readonly set_state: boolean;
  readonly assign: boolean;
  /** Change its one line and its due date: only a follow-up from a chat, by its creator, until it is closed. */
  readonly edit: boolean;
  /** Send or dismiss it on its own: only a follow-up from a chat, by its creator, while it is unsent. */
  readonly send: boolean;
  /** A follow-up from a chat its creator dismissed: final, so nobody sets its state or hands it on. */
  readonly dismissed_draft: boolean;
  /** Who the item waits on now: the owner, else the approver, else the decision's project leads; an unsent item, its approver, else the leads. */
  readonly waits_on: 'owner' | 'approver' | 'leads';
  readonly waits_on_viewer: boolean;
}
export function openItemAccessV1(facts: OpenItemFactsV1): OpenItemAccessV1 {
  const owner = facts.viewer === facts.owner;
  const approver = facts.viewer === facts.approver;
  const unsent = facts.state === 'unsent';
  const closed = facts.state === 'done' || facts.state === 'not_relevant';
  const waits_on = !unsent && facts.owner_active ? 'owner' as const : facts.approver_active ? 'approver' as const : 'leads' as const;
  const chat = facts.from_chat;
  // A follow-up from a chat has no decision and no project: nobody reads it as a decision or leads it, whatever the facts say.
  const reads_decision = !chat && facts.reads_decision;
  const leads = !chat && facts.leads_decision_project;
  // Its creator (`approver`) always sees it. `sent_to_owner` is exactly whether Send included it, so a draft its creator
  // dismissed is final: it never reached its owner, nobody closes, reopens or hands it on, and it stays its creator's alone.
  const dismissed_draft = chat && !unsent && !facts.sent_to_owner;
  const see_row = reads_decision || (owner && facts.sent_to_owner) || (chat && approver);
  return Object.freeze({
    see_row,
    // An owner who cannot read the decision sees who sent the item, never the decision itself.
    see_decision: openItemDecisionAccessV1({ reads_decision }).see_decision,
    see_outside: see_row && facts.opens_item === true,
    set_state: see_row && !unsent && !dismissed_draft && (approver || owner),
    // Before Send only the approver picks an owner, while they see the row: exactly when the send policy lets them send it.
    assign: see_row && !dismissed_draft && (unsent ? approver : approver || owner || leads),
    // An item from a run keeps its decision's line, and is sent with its run.
    edit: chat && approver && !closed && !dismissed_draft,
    send: chat && approver && unsent,
    dismissed_draft,
    waits_on,
    waits_on_viewer: see_row && !closed && (waits_on === 'owner' ? owner : waits_on === 'approver' ? approver : leads),
  });
}

/**
 * Who sees a decision: its title, first decided line, approval time and
 * projects on a row, its counts in a summary, and its impact check's stage.
 * Those who pass the exact record check now.
 */
export function openItemDecisionAccessV1(facts: { readonly reads_decision: boolean }): { readonly see_decision: boolean } {
  return Object.freeze({ see_decision: facts.reads_decision });
}

/** Who may send a run's items: its approver, while they can read the decision. */
export function openItemSendAccessV1(facts: { readonly viewer: string; readonly approver: string; readonly reads_decision: boolean }): { readonly send: boolean } {
  return Object.freeze({ send: facts.viewer === facts.approver && facts.reads_decision });
}
