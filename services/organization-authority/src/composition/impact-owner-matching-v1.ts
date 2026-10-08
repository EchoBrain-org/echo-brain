import type { JiraOwnerAccountsV1 } from '../application/ports/jira-owner-accounts-v1.js';

export interface ImpactOwnerCandidateV1 {
  /** The stored citation pointer of the affected item. */
  readonly pointer: Readonly<Record<string, unknown>>;
  /** The owner name the impact card took from the item's details, if any. */
  readonly owner_name?: string;
}
export interface ImpactOwnerMatchResultV1 { readonly owner_membership_id: string; readonly owner_match: 'jira_account' | 'name' | 'approver' }
/** ECHO's member directory as owner matching reads it: the open items' people store. */
export interface ImpactOwnerPeopleV1 {
  activeByName(organizationId: string, name: string): readonly string[];
  isActiveMember(organizationId: string, membershipId: string): boolean;
}

/** The ticket id of a Jira ticket on the runtime's site, else undefined. */
function siteTicketId(pointer: ImpactOwnerCandidateV1['pointer'], jira: JiraOwnerAccountsV1 | undefined): string | undefined {
  return jira !== undefined && pointer.kind === 'ticket' && pointer.tool_id === 'jira' && pointer.external_scope_id === jira.cloud_id &&
    typeof pointer.ticket_id === 'string' ? pointer.ticket_id : undefined;
}

/**
 * Exact matches only (open items and Home v1, ruling 1). A Jira ticket on the
 * runtime's site: the one active member whose Jira connection is the ticket's
 * assignee account. An ECHO record or document action: the one active member
 * whose display name equals its owner. Anything else, and any failure: the
 * approver. Never throws.
 */
export async function matchImpactOwnersV1(input: {
  readonly candidates: readonly ImpactOwnerCandidateV1[];
  readonly approver: { readonly organization_id: string; readonly membership_id: string };
  readonly access_token: string;
  readonly people: ImpactOwnerPeopleV1;
  readonly jira?: JiraOwnerAccountsV1;
  readonly signal?: AbortSignal;
}): Promise<readonly ImpactOwnerMatchResultV1[]> {
  const { approver, people, jira } = input;
  const organization = approver.organization_id;
  const fallback: ImpactOwnerMatchResultV1 = Object.freeze({ owner_membership_id: approver.membership_id, owner_match: 'approver' });
  const theOne = (memberships: readonly string[], owner_match: 'jira_account' | 'name'): ImpactOwnerMatchResultV1 => {
    const distinct = [...new Set(memberships)];
    return distinct.length === 1 ? Object.freeze({ owner_membership_id: distinct[0]!, owner_match }) : fallback;
  };
  const tickets = input.candidates.map(candidate => siteTicketId(candidate.pointer, jira));
  const ticketIds = [...new Set(tickets.filter((id): id is string => id !== undefined))];
  let assignees: ReadonlyMap<string, string> = new Map();
  if (jira !== undefined && ticketIds.length > 0) {
    try {
      assignees = await jira.assignees({ access_token: input.access_token, ticket_ids: ticketIds, ...(input.signal === undefined ? {} : { signal: input.signal }) });
    } catch { /* A failed read matches no one. */ }
  }
  return Object.freeze(input.candidates.map((candidate, index): ImpactOwnerMatchResultV1 => {
    try {
      const ticket = tickets[index];
      if (ticket !== undefined) {
        // A ticket is matched by its assignee's account only, never by a display name.
        const account = assignees.get(ticket);
        if (account === undefined) return fallback;
        return theOne(jira!.people(account)
          .filter(person => person.organization_id === organization && people.isActiveMember(organization, person.membership_id))
          .map(person => person.membership_id), 'jira_account');
      }
      const name = candidate.owner_name?.trim();
      const echoAction = candidate.pointer.kind === 'approved_record' || candidate.pointer.kind === 'source_revision';
      return echoAction && name !== undefined && name !== '' ? theOne(people.activeByName(organization, name), 'name') : fallback;
    } catch { return fallback; }
  }));
}
