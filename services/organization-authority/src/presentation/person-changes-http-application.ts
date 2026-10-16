import type { PersonChangesV1 } from "@echo-brain/organization-api";

/**
 * The change check (desktop refresh and notifications v1; ADR-0036): what
 * moved in the signed-in person's own view, one fingerprint per area and no
 * content. The bearer and the disconnect signal stay in the HTTP boundary.
 */
export interface PersonChangesHttpApplicationV1 {
  read(input: {
    readonly access_token: string;
    readonly signal?: AbortSignal;
  }): Promise<PersonChangesV1>;
}
