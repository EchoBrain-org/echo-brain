import type { PersonSourceEvidenceReadRequestV1, PersonSourceEvidenceV1 } from "@echo-brain/organization-api";

/** Opening a cited original. It needs no answer model; the bearer stays in the transport. */
export interface PersonSourceEvidenceHttpApplicationV1 {
  readSource(input: {
    readonly access_token: string;
    readonly request: PersonSourceEvidenceReadRequestV1;
    /** Set only by the source-review request header; absent for installed readers of the original exact-key response. */
    readonly include_imported_meeting_review?: true;
  }): PersonSourceEvidenceV1;
}
