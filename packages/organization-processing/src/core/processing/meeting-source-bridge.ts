import type { AdapterConfig, AdapterOperationContext } from "../contracts/adapter.js";
import type { MeetingDocument, MeetingProvenance } from "../contracts/meeting.js";
import type { SourceEnvelopeV1, SourcePullRequestV1 } from "../contracts/source.js";
import { assertCanonicalMeetingBatch, assertCanonicalMeetingDocument } from "../contracts/validation.js";
import type { MeetingSourceAdapter } from "../ports/adapters.js";
import type { SourceAdapterV1 } from "../ports/source.js";
import { sourceContentSha256V1, sourceItemIdV1 } from "./source-admission.js";

/** Observation time belongs to the captured revision, not immutable content. */
export type MeetingSourceContentV1 = Omit<MeetingDocument, "provenance"> & {
  readonly provenance: Omit<MeetingProvenance, "observed_at">;
};

export function meetingSourceEnvelopeV1(meeting: MeetingDocument): SourceEnvelopeV1<MeetingSourceContentV1> {
  assertCanonicalMeetingDocument(meeting, meeting.provenance.source);
  const { observed_at: capturedAt, ...provenance } = meeting.provenance;
  const content: MeetingSourceContentV1 = { ...meeting, provenance };
  const sourceId = sourceItemIdV1(provenance.source, provenance.external_id);
  const digest = sourceContentSha256V1(content);
  return {
    item: { schema_version: 1, source_id: sourceId, adapter: provenance.source, external_id: provenance.external_id },
    revision: {
      schema_version: 1,
      source_id: sourceId,
      revision_id: provenance.canonical_revision,
      captured_at: capturedAt,
      content_sha256: digest,
      artifact_refs: [],
      // The canonical meeting is inline retained content, not a separately
      // materialized representation. Only actual stored outputs may be refs.
      representation_refs: [],
      ...(provenance.previous_revision === undefined ? {} : { previous_revision_id: provenance.previous_revision }),
    },
    content,
  };
}

export function meetingFromSourceEnvelopeV1(source: SourceEnvelopeV1<MeetingSourceContentV1>): MeetingDocument {
  const meeting: MeetingDocument = { ...source.content, provenance: { ...source.content.provenance, observed_at: source.revision.captured_at } };
  if (source.item.adapter.kind !== "meeting-source") throw new Error("meeting source adapter kind is invalid");
  assertCanonicalMeetingDocument(meeting, { ...source.item.adapter, kind: "meeting-source" });
  if (meeting.provenance.canonical_revision !== source.revision.revision_id || meeting.provenance.external_id !== source.item.external_id) throw new Error("meeting content does not match its source revision");
  return meeting;
}

/** Compatibility lives at the edge; the processing cycle uses the common port. */
export class MeetingSourceBridgeV1 implements SourceAdapterV1<MeetingSourceContentV1> {
  constructor(private readonly delegate: MeetingSourceAdapter) {}
  get identity() { return this.delegate.identity; }
  validateConfig(config: AdapterConfig) { return this.delegate.validateConfig(config); }
  healthCheck(context?: AdapterOperationContext) { return this.delegate.healthCheck(context); }
  async pull(request: SourcePullRequestV1, context?: AdapterOperationContext) {
    const batch = await this.delegate.pull(request, context);
    assertCanonicalMeetingBatch(batch);
    for (const meeting of batch.meetings) assertCanonicalMeetingDocument(meeting, this.identity);
    return {
      sources: batch.meetings.map(meetingSourceEnvelopeV1),
      ...(batch.next_cursor === undefined ? {} : { next_cursor: batch.next_cursor }),
    };
  }
}
