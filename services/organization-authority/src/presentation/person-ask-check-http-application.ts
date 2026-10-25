import type { PersonAskCheckRequestV1, PersonAskCheckV1 } from "@echo-brain/organization-api";

/**
 * The Ask source check (Ask timeline v1, C1; ADR-0047): whether each source an old answer cited is the same, changed,
 * unreadable or unknown now, and no content. The bearer and the disconnect signal stay in the HTTP boundary.
 */
export interface PersonAskCheckHttpApplicationV1 {
  check(input: {
    readonly access_token: string;
    readonly request: PersonAskCheckRequestV1;
    readonly signal?: AbortSignal;
  }): Promise<PersonAskCheckV1>;
}
