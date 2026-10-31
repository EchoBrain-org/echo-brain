import type { PersonRecordListV1 } from "@echo-brain/organization-api";

/** A bearer-only route. Caller identity is never accepted from HTTP input. */
export interface PersonRecordReadHttpApplicationV1 {
  list(input: {
    readonly access_token: string;
    readonly limit?: number;
    readonly record_sha256?: `sha256:${string}`;
    readonly include_source_metadata?: boolean;
  }): PersonRecordListV1;
}
