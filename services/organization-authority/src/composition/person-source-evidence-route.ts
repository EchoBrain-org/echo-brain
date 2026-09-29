import type { PersonMeetingTranscriptReadRequestV1, PersonMeetingTranscriptV1, PersonSourceEvidenceReadRequestV1, PersonSourceEvidenceV1 } from "@echo-brain/organization-api";
import { validatePersonMeetingTranscriptV1, validatePersonSourceEvidenceV1 } from "@echo-brain/organization-api";
import type { PersonAskScopeV2, PersonOriginalContextRetrievalPortV1 } from "../application/ports/person-original-context-retrieval-v1.js";
import type { PersonMeetingTranscriptHttpApplicationV1, PersonSourceEvidenceHttpApplicationV1 } from "../presentation/person-source-evidence-http-application.js";

function scopeOf(scope: PersonSourceEvidenceReadRequestV1["scope"]): PersonAskScopeV2 {
  return scope.kind === "global"
    ? Object.freeze({ kind: "global" })
    : Object.freeze({ kind: "project", project_id: scope.project_id });
}

/**
 * Opens one cited original (a note, document passage or shared transcript
 * packet) through the Layer-3 originals port, under the asker's current
 * access. Any Ask answer's source_revision citation opens here.
 */
export function createPersonSourceEvidenceRouteV1(input: {
  readonly originals: PersonOriginalContextRetrievalPortV1;
}): PersonSourceEvidenceHttpApplicationV1 {
  return Object.freeze({
    readSource(request: { readonly access_token: string; readonly request: PersonSourceEvidenceReadRequestV1 }): PersonSourceEvidenceV1 {
      const proof = input.originals.read({
        access_token: request.access_token,
        scope: scopeOf(request.request.scope),
        citation: request.request.citation,
      });
      return validatePersonSourceEvidenceV1({
        schema_version: 1,
        kind: "echo-person-source-evidence-v1",
        scope: proof.scope,
        citation: {
          kind: "source_revision",
          source_id: proof.atom.source_id,
          revision_id: proof.atom.revision_id,
          source_sha256: proof.atom.source_sha256,
          representation_sha256: proof.atom.representation_sha256,
          anchor_sha256: proof.atom.anchor_sha256,
          ...(proof.atom.document_id === undefined ? {} : { document_id: proof.atom.document_id }),
          label: proof.atom.label ?? "Saved context",
        },
        text: proof.atom.text,
      });
    },
  });
}

/** Reuses the Layer-3 originals port without selecting an answer model. */
export function createPersonMeetingTranscriptReadRouteV1(input: {
  readonly originals: PersonOriginalContextRetrievalPortV1;
}): PersonMeetingTranscriptHttpApplicationV1 {
  return Object.freeze({
    readTranscript(request: { readonly access_token: string; readonly request: PersonMeetingTranscriptReadRequestV1 }): PersonMeetingTranscriptV1 {
      const proof = input.originals.readApprovedMeetingTranscript({
        access_token: request.access_token,
        scope: scopeOf(request.request.scope),
        citation: request.request.citation,
        ...(request.request.offset === undefined ? {} : { offset: request.request.offset }),
      });
      return validatePersonMeetingTranscriptV1({
        schema_version: 1,
        kind: "echo-person-meeting-transcript-v1",
        scope: proof.scope,
        citation: proof.citation,
        text: proof.text,
        next_offset: proof.next_offset,
      });
    },
  });
}
