import type { PersonSourceEvidenceReadRequestV1, PersonSourceEvidenceV1, PersonMeetingTranscriptReadRequestV1, PersonMeetingTranscriptV1 } from "@echo-brain/organization-api";

/** Opening a cited original. It needs no answer model; the bearer stays in the transport. */
export interface PersonSourceEvidenceHttpApplicationV1 {
  readSource(input: {
    readonly access_token: string;
    readonly request: PersonSourceEvidenceReadRequestV1;
  }): PersonSourceEvidenceV1;
}

/** Direct approval-gated transcript reads do not require an Ask model. */
export interface PersonMeetingTranscriptHttpApplicationV1 {
  readTranscript(input: {
    readonly access_token: string;
    readonly request: PersonMeetingTranscriptReadRequestV1;
  }): PersonMeetingTranscriptV1;
}
