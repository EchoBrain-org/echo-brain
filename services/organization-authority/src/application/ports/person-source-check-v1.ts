/** One live read of the check, as the caller, with the caller's own connection to the tool. */
interface PersonSourceCheckReadV1 { readonly access_token: string; readonly signal?: AbortSignal }

/**
 * A connected tool's reads for the Ask source check (Ask timeline v1, C1; ADR-0047). Server only and content-free: whether a
 * ticket can be read, and a page's version, never their text. A ticket or page the caller cannot read now is left out of an answer, never
 * named; a read that fails for any other reason, the caller's tool not connected included, rejects.
 */
export type PersonSourceCheckV1 = PersonTicketCheckV1 | PersonPageCheckV1;

export interface PersonTicketCheckV1 {
  readonly kind: 'ticket';
  /** The tool and site its tickets belong to; a ticket cited on another site is not one this check reads. */
  readonly tool_id: string;
  readonly external_scope_id: string | ((access_token: string) => string | undefined);
  /** The ids of the tickets the caller can read now, read in bulk: at most 100 ids, in two calls. */
  readable(input: PersonSourceCheckReadV1 & { readonly ticket_ids: readonly string[] }): Promise<ReadonlySet<string>>;
}

export interface PersonPageCheckV1 {
  readonly kind: 'page';
  readonly tool_id: string;
  readonly external_scope_id: string | ((access_token: string) => string | undefined);
  /** Each readable page's current version by its id, read by id: at most 100 ids, in two calls. */
  versions(input: PersonSourceCheckReadV1 & { readonly page_ids: readonly string[] }): Promise<ReadonlyMap<string, string>>;
}
