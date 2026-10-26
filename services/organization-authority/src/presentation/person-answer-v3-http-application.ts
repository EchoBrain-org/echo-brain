import type {
  PersonEvidenceDeskResponseV1,
  PersonEvidenceOpenRequestV1,
  PersonEvidenceSearchRequestV1,
} from "@echo-brain/organization-api";

/**
 * The evidence desk's two `/v3` reads (ADR-0022), which keep the bearer and cancellation signal in the HTTP boundary.
 * Their Ask, `/v3/person/ask`, was retired: Ask is `/v7`.
 */
export interface PersonAnswerV3HttpApplication {
  searchEvidence(input: {
    readonly access_token: string;
    readonly request: PersonEvidenceSearchRequestV1;
    readonly signal?: AbortSignal;
  }): Promise<PersonEvidenceDeskResponseV1>;
  openEvidence(input: {
    readonly access_token: string;
    readonly request: PersonEvidenceOpenRequestV1;
    readonly signal?: AbortSignal;
  }): Promise<PersonEvidenceDeskResponseV1>;
}
