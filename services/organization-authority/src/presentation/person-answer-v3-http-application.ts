import type {
  PersonAnswerRequestV3,
  PersonAnswerResponseV4,
  PersonEvidenceDeskResponseV1,
  PersonEvidenceOpenRequestV1,
  PersonEvidenceSearchRequestV1,
} from "@echo-brain/organization-api";

/** The V3 route keeps the bearer and cancellation signal in the HTTP boundary. */
export interface PersonAnswerV3HttpApplication {
  ask(input: {
    readonly access_token: string;
    readonly request: PersonAnswerRequestV3;
    readonly signal?: AbortSignal;
  }): Promise<PersonAnswerResponseV4>;
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
