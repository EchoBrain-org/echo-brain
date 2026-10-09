/** Jira assignees as account ids, for matching an impact card's owners to ECHO members. Server only: an account id never reaches a model, a stored row or an API response. */
export interface JiraOwnerAccountsV1 {
  /** The Jira site (cloud id) this runtime reads. */
  readonly cloud_id: string;
  /** Assignee account ids by ticket id, read live with this person's Jira connection in bulk. A ticket it cannot read, or with no assignee, is left out; a failed read returns an empty map. */
  assignees(input: { readonly access_token: string; readonly ticket_ids: readonly string[]; readonly signal?: AbortSignal }): Promise<ReadonlyMap<string, string>>;
  /** The people whose active Jira connection is this account on this site. */
  people(accountId: string): readonly { readonly organization_id: string; readonly principal_id: string; readonly membership_id: string }[];
}
