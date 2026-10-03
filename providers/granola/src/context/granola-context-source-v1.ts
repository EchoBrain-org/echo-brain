import { createHash } from "node:crypto";
import {
  AdapterError,
  buildContextCaptureEnvelopeV1,
  CONTEXT_CAPTURE_LIMITS_V1,
  isCanonicalTimestamp,
  type AdapterConfig,
  type AdapterConfigValidation,
  type AdapterHealth,
  type AdapterOperationContext,
  type ContextCaptureContentV1,
  type ContextPassageV1,
  type MeetingDocument,
  type MeetingSourceAdapter,
  type SourceAdapterIdentityV1,
  type SourceAdapterV1,
  type SourceBatchV1,
  type SourcePullRequestV1,
} from "@echo-brain/organization-processing/core";

export const GRANOLA_CONTEXT_CAPTURE_ADAPTER_ID = "granola-context-capture";
export const GRANOLA_CONTEXT_CAPTURE_ADAPTER_VERSION = "1.0.0";

export interface GranolaContextSourceV1Options {
  /** The one already-configured Granola source. This wrapper never creates transport. */
  readonly source: MeetingSourceAdapter;
  /** Injection is for the source revision's observation time, never meeting time. */
  readonly now?: () => string;
}

/** Mapping failure is permanent for this source observation and never returns a cursor. */
class GranolaContextCaptureMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GranolaContextCaptureMappingError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    byteLength(value) <= maximum &&
    !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)
  );
}

function sameIdentity(
  left: SourceAdapterIdentityV1,
  right: SourceAdapterIdentityV1,
): boolean {
  return left.kind === right.kind && left.adapter_id === right.adapter_id &&
    left.instance_id === right.instance_id && left.version === right.version;
}

function sourceIdentitySnapshot(identity: SourceAdapterIdentityV1): SourceAdapterIdentityV1 {
  if (identity.kind !== "meeting-source") {
    throw new Error("Granola context source must wrap a meeting source");
  }
  return Object.freeze({ ...identity });
}

function sourceReference(meeting: MeetingDocument): string {
  const url = meeting.provenance.source_url;
  if (isBoundedText(url, 2_048)) return url;
  return `granola:${meeting.provenance.source.instance_id}:note:${sha256(
    meeting.provenance.external_id,
  )}`;
}

function sourceLabel(meeting: MeetingDocument): string {
  if (isBoundedText(meeting.title, 200)) return meeting.title;
  return `Granola note ${sha256(meeting.provenance.external_id).slice(0, 16)}`;
}

interface SelectedBlock {
  readonly source_anchor: string;
  readonly text: string;
}

function selectedBlocks(meeting: MeetingDocument): readonly SelectedBlock[] {
  const selected = meeting.content.filter(
    (block) =>
      (block.kind === "summary" || block.kind === "note" || block.kind === "transcript") &&
      block.text.trim() !== "",
  );
  if (selected.length === 0) {
    throw new GranolaContextCaptureMappingError(
      "Granola context capture has no completed note or transcript text",
    );
  }
  return selected.map((block) => ({
    source_anchor: `granola:content:${sha256(
      `${meeting.provenance.external_id}\u0000${block.id}`,
    )}`,
    text: block.text,
  }));
}

interface SnapshotAndPassages {
  readonly text: string;
  readonly passages: readonly ContextPassageV1[];
}

/**
 * The snapshot is the exact provider text. Passages are bounded anchors for
 * inspection and may cover only its first bounded chunks; the shared full
 * snapshot contract intentionally permits uncovered text.
 */
function snapshotAndPassages(
  blocks: readonly SelectedBlock[],
): SnapshotAndPassages {
  const text = blocks.map((block) => block.text).join("\n\n");
  if (byteLength(text) > CONTEXT_CAPTURE_LIMITS_V1.snapshot_bytes) {
    throw new GranolaContextCaptureMappingError(
      "Granola context capture exceeds the 128 KiB full-snapshot capability",
    );
  }

  const passages: ContextPassageV1[] = [];
  let snapshotOffset = 0;
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex]!;
    let start = 0;
    let bytes = 0;
    const append = (end: number): void => {
      const value = block.text.slice(start, end);
      if (value.trim() !== "" && passages.length < CONTEXT_CAPTURE_LIMITS_V1.anchors) {
        passages.push({
          id: `granola-${blockIndex + 1}-${passages.length + 1}`,
          source_anchor: block.source_anchor,
          start: snapshotOffset + start,
          end: snapshotOffset + end,
          text: value,
        });
      }
    };

    for (let offset = 0; offset < block.text.length;) {
      const codePoint = block.text.codePointAt(offset)!;
      const width = codePoint > 0xffff ? 2 : 1;
      const characterBytes = byteLength(block.text.slice(offset, offset + width));
      if (bytes > 0 && bytes + characterBytes > CONTEXT_CAPTURE_LIMITS_V1.passage_bytes) {
        append(offset);
        start = offset;
        bytes = 0;
      }
      bytes += characterBytes;
      offset += width;
    }
    append(block.text.length);
    snapshotOffset += block.text.length + (blockIndex + 1 < blocks.length ? 2 : 0);
  }

  if (passages.length === 0) {
    throw new GranolaContextCaptureMappingError(
      "Granola context capture has no valid passage anchors",
    );
  }
  return { text, passages };
}

function meetingPayload(meeting: MeetingDocument): ContextCaptureContentV1["payload"] {
  const startedAt = meeting.time?.actual_start_at ?? meeting.time?.scheduled_start_at;
  if (startedAt === undefined) {
    return { schema_version: 1, kind: "note", format: "plain_text" };
  }
  if (!isCanonicalTimestamp(startedAt)) {
    throw new GranolaContextCaptureMappingError(
      "Granola meeting start time is not canonical UTC",
    );
  }
  const endedAt = meeting.time?.actual_end_at ?? meeting.time?.scheduled_end_at;
  if (endedAt !== undefined && !isCanonicalTimestamp(endedAt)) {
    throw new GranolaContextCaptureMappingError(
      "Granola meeting end time is not canonical UTC",
    );
  }
  if (endedAt !== undefined && Date.parse(endedAt) < Date.parse(startedAt)) {
    throw new GranolaContextCaptureMappingError(
      "Granola meeting ends before it starts",
    );
  }
  const participantRefs = [...new Set(
    meeting.participants.map((participant) =>
      `granola:participant:${sha256(
        `${meeting.provenance.external_id}\u0000${participant.id}`,
      )}`,
    ),
  )].sort();
  if (participantRefs.length > 32) {
    throw new GranolaContextCaptureMappingError(
      "Granola context capture exceeds the 32 participant-reference capability",
    );
  }
  return {
    schema_version: 1,
    kind: "meeting",
    started_at: startedAt,
    ...(endedAt === undefined ? {} : { ended_at: endedAt }),
    participant_refs: participantRefs,
  };
}

/**
 * Converts the existing normalized Granola meeting observation without any
 * provider read. It retains only source-observed text and opaque source refs.
 */
export function mapGranolaMeetingToContextCaptureContentV1(
  meeting: MeetingDocument,
): ContextCaptureContentV1 {
  const sourceUpdatedAt = meeting.provenance.source_updated_at;
  const payload = meetingPayload(meeting);
  const snapshot = snapshotAndPassages(selectedBlocks(meeting));
  return {
    schema_version: 1,
    kind: "echo-context-capture-v1",
    source_type: payload.kind,
    truth_status: "source_observation",
    label: sourceLabel(meeting),
    provenance: {
      origin_ref: sourceReference(meeting),
      ...(isCanonicalTimestamp(sourceUpdatedAt)
        ? { source_updated_at: sourceUpdatedAt }
        : {}),
    },
    payload,
    representation: { kind: "full_snapshot", text: snapshot.text, passages: snapshot.passages },
    observations: [],
  };
}

export class GranolaContextSourceV1
  implements SourceAdapterV1<ContextCaptureContentV1>
{
  readonly identity: SourceAdapterIdentityV1;
  private readonly now: () => string;
  private readonly sourceIdentity: SourceAdapterIdentityV1;

  constructor(private readonly source: MeetingSourceAdapter, options: Omit<GranolaContextSourceV1Options, "source"> = {}) {
    this.sourceIdentity = sourceIdentitySnapshot(source.identity);
    this.identity = Object.freeze({
      kind: "source" as const,
      adapter_id: GRANOLA_CONTEXT_CAPTURE_ADAPTER_ID,
      instance_id: this.sourceIdentity.instance_id,
      version: GRANOLA_CONTEXT_CAPTURE_ADAPTER_VERSION,
    });
    this.now = options.now ?? (() => new Date().toISOString());
  }

  validateConfig(config: AdapterConfig): AdapterConfigValidation {
    if (config.adapter_id !== this.identity.adapter_id) {
      return { ok: false, errors: [`adapter_id must be '${this.identity.adapter_id}'`] };
    }
    if (config.instance_id !== this.identity.instance_id) {
      return { ok: false, errors: ["instance_id does not match the registered adapter instance"] };
    }
    return this.source.validateConfig({
      ...config,
      adapter_id: this.sourceIdentity.adapter_id,
      instance_id: this.sourceIdentity.instance_id,
    });
  }

  healthCheck(operation?: AdapterOperationContext): Promise<AdapterHealth> {
    return this.source.healthCheck(operation);
  }

  async pull(
    request: SourcePullRequestV1,
    operation?: AdapterOperationContext,
  ): Promise<SourceBatchV1<ContextCaptureContentV1>> {
    const capturedAt = this.now();
    if (!isCanonicalTimestamp(capturedAt)) {
      throw new AdapterError(
        "temporarily_unavailable",
        "Granola context capture clock returned an invalid timestamp",
        true,
      );
    }
    if (!sameIdentity(this.source.identity, this.sourceIdentity)) {
      throw new AdapterError("permanently_rejected", "Granola context source identity changed", false);
    }
    const pulled = await this.source.pull(request, operation);
    try {
      if (!sameIdentity(this.source.identity, this.sourceIdentity)) {
        throw new GranolaContextCaptureMappingError("Granola context source identity changed");
      }
      return {
        sources: pulled.meetings.map((meeting) => {
          if (!sameIdentity(meeting.provenance.source, this.sourceIdentity)) {
            throw new GranolaContextCaptureMappingError("Granola meeting provenance differs from configured source");
          }
          return buildContextCaptureEnvelopeV1({
            identity: this.identity,
            external_id: meeting.provenance.external_id,
            captured_at: capturedAt,
            content: mapGranolaMeetingToContextCaptureContentV1(meeting),
          });
        }),
        ...(pulled.next_cursor === undefined
          ? {}
          : { next_cursor: pulled.next_cursor }),
      };
    } catch (error) {
      if (error instanceof GranolaContextCaptureMappingError) {
        throw new AdapterError("permanently_rejected", error.message, false);
      }
      throw error;
    }
  }
}

export function createGranolaContextSourceV1(
  input: GranolaContextSourceV1Options,
): GranolaContextSourceV1 {
  return new GranolaContextSourceV1(input.source, input);
}
