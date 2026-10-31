import type { PersonRecordSearchV2 } from "@echo-brain/organization-api";

/** A bearer-only Layer 2 route. Caller identity never appears in the body. */
export interface PersonRecordSearchHttpApplicationV1 {
  search(input: {
    readonly access_token: string;
    readonly query: string;
    readonly limit?: number;
  }): PersonRecordSearchV2;
}
