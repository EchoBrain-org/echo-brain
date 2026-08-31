export const PERSON_RECORD_SEARCH_PATH_V1 = "/v1/person/records";

export type PersonRecordSearchDigestV1 = `sha256:${string}`;
export type PersonRecordSearchPolicyV1 =
  | "organization-member-readable-person-v2"
  | "restricted-reviewer-person-v2";

export interface PersonRecordSearchResponseV1 {
  readonly schema_version: 1;
  readonly kind: "echo-clean-person-record-search-v1";
  readonly generation_id: PersonRecordSearchDigestV1;
  readonly record_head: {
    readonly position: number;
    readonly record_sha256: PersonRecordSearchDigestV1 | null;
  };
  readonly items: readonly {
    readonly atom_id: PersonRecordSearchDigestV1;
    readonly record_sha256: PersonRecordSearchDigestV1;
    readonly kind: "decision" | "action" | "rationale";
    readonly text: string;
    readonly policy_id: PersonRecordSearchPolicyV1;
  }[];
}

/** A bearer-only Layer 2 route. Caller identity never appears in the body. */
export interface PersonRecordSearchHttpApplicationV1 {
  search(input: {
    readonly access_token: string;
    readonly query: string;
    readonly limit?: number;
  }): PersonRecordSearchResponseV1;
}
