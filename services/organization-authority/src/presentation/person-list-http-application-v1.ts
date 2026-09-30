import type { PersonListRequestV1, PersonListResponseV1, PersonOpenRequestV1, PersonOpenResponseV1 } from "@echo-brain/organization-api";

/**
 * The person list and open by ref (ADR-0023). Neither needs an answer model;
 * the bearer and the disconnect signal stay in the HTTP boundary.
 */
export interface PersonListHttpApplicationV1 {
  list(input: {
    readonly access_token: string;
    readonly request: PersonListRequestV1;
    readonly signal?: AbortSignal;
  }): Promise<PersonListResponseV1>;
  open(input: {
    readonly access_token: string;
    readonly request: PersonOpenRequestV1;
    readonly signal?: AbortSignal;
  }): Promise<PersonOpenResponseV1>;
}
