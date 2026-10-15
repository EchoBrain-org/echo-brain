import type { TicketOwnerAccountsV1 } from '../application/ports/ticket-owner-accounts-v1.js';

export interface ImpactOwnerCandidateV1 {
  /** The stored citation pointer of the affected item. */
  readonly pointer: Readonly<Record<string, unknown>>;
  /** The owner name the impact card took from the item's details, if any. */
  readonly owner_name?: string;
}
/** An assignee account match is stored as `jira_account`: a frozen V14 baseline and organization-api value, renamed only by a versioned migration. */
export interface ImpactOwnerMatchResultV1 { readonly owner_membership_id: string; readonly owner_match: 'jira_account' | 'name' | 'approver' }
/** ECHO's member directory as owner matching reads it: the open items' people store. */
export interface ImpactOwnerPeopleV1 {
  activeByName(organizationId: string): (name: string) => readonly string[];
  isActiveMember(organizationId: string, membershipId: string): boolean;
}

/** The ticket id of a ticket on the owner accounts' tool and site, else undefined. */
function siteTicketId(pointer: ImpactOwnerCandidateV1['pointer'], owners: TicketOwnerAccountsV1 | undefined): string | undefined {
  return owners !== undefined && pointer.kind === 'ticket' && pointer.tool_id === owners.tool_id && pointer.external_scope_id === owners.external_scope_id &&
    typeof pointer.ticket_id === 'string' ? pointer.ticket_id : undefined;
}

/** Items whose owner is a name ECHO itself holds: an ECHO record's or document's action, and the approved meeting's own action. */
const NAMED_OWNER_KINDS: readonly unknown[] = ['approved_record', 'source_revision', 'meeting_action'];

/**
 * Exact matches only (open items and Home v1, ruling 1). A ticket on the
 * owner accounts' tool and site: the one active member whose connection is the
 * ticket's assignee account. An ECHO record or document action, or the
 * approved meeting's own action (its approver-confirmed owner; follow-ups
 * thread v1): the one active member whose display name equals the owner name
 * (`activeByName`, the roster read once a call). Anything else, and any
 * failure: the approver. Never throws.
 */
export async function matchImpactOwnersV1(input: {
  readonly candidates: readonly ImpactOwnerCandidateV1[];
  readonly approver: { readonly organization_id: string; readonly membership_id: string };
  readonly access_token: string;
  readonly people: ImpactOwnerPeopleV1;
  readonly owners?: TicketOwnerAccountsV1;
  readonly signal?: AbortSignal;
}): Promise<readonly ImpactOwnerMatchResultV1[]> {
  const { approver, people, owners } = input;
  const organization = approver.organization_id;
  const fallback: ImpactOwnerMatchResultV1 = Object.freeze({ owner_membership_id: approver.membership_id, owner_match: 'approver' });
  const theOne = (memberships: readonly string[], owner_match: 'jira_account' | 'name'): ImpactOwnerMatchResultV1 => {
    const distinct = [...new Set(memberships)];
    return distinct.length === 1 ? Object.freeze({ owner_membership_id: distinct[0]!, owner_match }) : fallback;
  };
  const tickets = input.candidates.map(candidate => siteTicketId(candidate.pointer, owners));
  const ticketIds = [...new Set(tickets.filter((id): id is string => id !== undefined))];
  let assignees: ReadonlyMap<string, string> = new Map();
  if (owners !== undefined && ticketIds.length > 0) {
    try {
      assignees = await owners.assignees({ access_token: input.access_token, ticket_ids: ticketIds, ...(input.signal === undefined ? {} : { signal: input.signal }) });
    } catch { /* A failed read matches no one. */ }
  }
  let named: ((name: string) => readonly string[]) | undefined;
  return Object.freeze(input.candidates.map((candidate, index): ImpactOwnerMatchResultV1 => {
    try {
      const ticket = tickets[index];
      if (ticket !== undefined) {
        // A ticket is matched by its assignee's account only, never by a display name.
        const account = assignees.get(ticket);
        if (account === undefined) return fallback;
        return theOne(owners!.people(account)
          .filter(person => person.organization_id === organization && people.isActiveMember(organization, person.membership_id))
          .map(person => person.membership_id), 'jira_account');
      }
      const name = candidate.owner_name?.trim();
      return NAMED_OWNER_KINDS.includes(candidate.pointer.kind) && name !== undefined && name !== '' ? theOne((named ??= people.activeByName(organization))(name), 'name') : fallback;
    } catch { return fallback; }
  }));
}
