export const PERSON_ANSWER_PATH_V1 = "/v1/person/ask";

export type PersonAnswerDigestV1 = `sha256:${string}`;
export type PersonAnswerPolicyV1 =
  | "organization-member-readable-person-v2"
  | "restricted-reviewer-person-v2";
export type PersonAnswerOutcomeV1 = "authorship_unsupported";

export interface PersonAnswerResponseV2 {
  readonly schema_version: 2;
  readonly kind: "echo-clean-person-answer-v2";
  readonly answer: string;
  readonly citations: readonly {
    readonly atom_id: PersonAnswerDigestV1;
    readonly record_sha256: PersonAnswerDigestV1;
    readonly policy_id: PersonAnswerPolicyV1;
  }[];
  /** Present when personal authorship cannot be established from accessible records. */
  readonly outcome?: PersonAnswerOutcomeV1;
}

/** A bearer-only answer-composition route. Caller identity never appears in the body. */
export interface PersonAnswerHttpApplicationV1 {
  ask(input: {
    readonly access_token: string;
    readonly question: string;
  }): Promise<PersonAnswerResponseV2>;
}
