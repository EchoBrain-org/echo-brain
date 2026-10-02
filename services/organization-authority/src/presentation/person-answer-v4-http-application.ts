import type { PersonAnswerRequestV3, PersonAnswerResponseV5 } from '@echo-brain/organization-api';

/** Additive ticket-capable Ask route; the installed V3/V4 route stays strict. */
export interface PersonAnswerV4HttpApplication {
  ask(input: { readonly access_token: string; readonly request: PersonAnswerRequestV3; readonly signal?: AbortSignal }): Promise<PersonAnswerResponseV5>;
}
