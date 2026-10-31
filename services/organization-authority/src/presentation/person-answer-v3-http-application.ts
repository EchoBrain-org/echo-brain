import type {
  PersonEvidenceDeskResponseV1,
  PersonEvidenceSearchRequestV1,
} from "@echo-brain/organization-api";

/**
 * The evidence desk's `/v3` search (ADR-0022), which keeps the bearer and cancellation signal in the HTTP boundary. Its
 * open and its Ask, `/v3/person/ask`, were retired: Ask is `/v7`.
 */
export interface PersonAnswerV3HttpApplication {
  searchEvidence(input: {
    readonly access_token: string;
    readonly request: PersonEvidenceSearchRequestV1;
    readonly signal?: AbortSignal;
  }): Promise<PersonEvidenceDeskResponseV1>;
}
