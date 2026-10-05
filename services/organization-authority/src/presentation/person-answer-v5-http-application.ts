import type { PersonAnswerRequestV3, PersonAnswerResponseV6 } from '@echo-brain/organization-api';

/** Additive live-page Ask route. V3 and V4 response contracts remain unchanged. */
export interface PersonAnswerV5HttpApplication {
  ask(input: { readonly access_token: string; readonly request: PersonAnswerRequestV3; readonly signal?: AbortSignal }): Promise<PersonAnswerResponseV6>;
}
