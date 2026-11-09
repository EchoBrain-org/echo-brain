import type { PersonSourceEvidenceReadRequestV1, PersonSourceEvidenceV1 } from "@echo-brain/organization-api";

/**
 * Opening a cited original. It needs no answer model; the bearer stays in the transport. An imported meeting's packet
 * always carries its review state.
 */
export interface PersonSourceEvidenceHttpApplicationV1 {
  readSource(input: { readonly access_token: string; readonly request: PersonSourceEvidenceReadRequestV1 }): PersonSourceEvidenceV1;
}
