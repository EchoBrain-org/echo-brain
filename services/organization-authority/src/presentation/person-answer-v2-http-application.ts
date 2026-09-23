import type { PersonAnswerRequestV2, PersonAnswerResponseV3, PersonSourceEvidenceReadRequestV1, PersonSourceEvidenceV1 } from "@echo-brain/organization-api";

/** V2 Ask keeps the bearer in the transport, while scope remains server-bound. */
export interface PersonAnswerV2HttpApplication {
  ask(input: {
    readonly access_token: string;
    readonly request: PersonAnswerRequestV2;
  }): Promise<PersonAnswerResponseV3>;
  readSource(input: {
    readonly access_token: string;
    readonly request: PersonSourceEvidenceReadRequestV1;
  }): PersonSourceEvidenceV1;
}
