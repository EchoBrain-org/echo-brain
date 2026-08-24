export const CLEAN_PERSON_ANSWER_PATH_V1 = "/v1/person/ask";

export type CleanPersonAnswerDigestV1 = `sha256:${string}`;
export type CleanPersonAnswerPolicyV1 =
  | "organization-member-readable-person-v2"
  | "restricted-reviewer-person-v2";

export interface CleanPersonAnswerResponseV1 {
  readonly schema_version: 1;
  readonly kind: "echo-clean-person-answer-v1";
  readonly generation_id: CleanPersonAnswerDigestV1;
  readonly record_head: {
    readonly position: number;
    readonly record_sha256: CleanPersonAnswerDigestV1 | null;
  };
  readonly answer: string;
  readonly citations: readonly {
    readonly atom_id: CleanPersonAnswerDigestV1;
    readonly record_sha256: CleanPersonAnswerDigestV1;
    readonly policy_id: CleanPersonAnswerPolicyV1;
  }[];
}

/** A bearer-only Layer 4 route. Caller identity never appears in the body. */
export interface CleanPersonAnswerHttpApplicationV1 {
  ask(input: {
    readonly access_token: string;
    readonly question: string;
  }): Promise<CleanPersonAnswerResponseV1>;
}
