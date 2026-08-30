export const PERSON_ANSWER_PATH_V1 = "/v1/person/ask";

export type PersonAnswerDigestV1 = `sha256:${string}`;
export type PersonAnswerPolicyV1 =
  | "organization-member-readable-person-v2"
  | "restricted-reviewer-person-v2";

export interface PersonAnswerResponseV1 {
  readonly schema_version: 1;
  readonly kind: "echo-clean-person-answer-v1";
  readonly generation_id: PersonAnswerDigestV1;
  readonly record_head: {
    readonly position: number;
    readonly record_sha256: PersonAnswerDigestV1 | null;
  };
  readonly answer: string;
  readonly citations: readonly {
    readonly atom_id: PersonAnswerDigestV1;
    readonly record_sha256: PersonAnswerDigestV1;
    readonly policy_id: PersonAnswerPolicyV1;
  }[];
}

/** A bearer-only answer-composition route. Caller identity never appears in the body. */
export interface PersonAnswerHttpApplicationV1 {
  ask(input: {
    readonly access_token: string;
    readonly question: string;
  }): Promise<PersonAnswerResponseV1>;
}
