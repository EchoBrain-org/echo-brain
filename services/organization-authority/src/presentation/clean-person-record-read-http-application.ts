export const CLEAN_PERSON_RECORDS_PATH_V1 = "/v1/person/records";

/** Presentation-local structural views keep this HTTP seam implementation-free. */
export type CleanPersonRecordDigestV1 = `sha256:${string}`;
export type CleanPersonRecordEnvelopeV1 = Readonly<Record<string, unknown>>;

export interface CleanPersonRecordReadResponseV1 {
  readonly schema_version: 1;
  readonly kind: "echo-clean-person-record-list-v1";
  readonly records: readonly {
    readonly position: number;
    readonly approval_id: string;
    readonly record_sha256: CleanPersonRecordDigestV1;
    readonly envelope: CleanPersonRecordEnvelopeV1;
  }[];
}

/** A bearer-only route. Caller identity is never accepted from HTTP input. */
export interface CleanPersonRecordReadHttpApplicationV1 {
  list(input: {
    readonly access_token: string;
    readonly limit?: number;
  }): CleanPersonRecordReadResponseV1;
}
