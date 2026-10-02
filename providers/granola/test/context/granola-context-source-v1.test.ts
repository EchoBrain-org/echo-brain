import { describe, expect, it } from "vitest";
import {
  AdapterError,
  buildContextCaptureEnvelopeV1,
  type AdapterConfig,
  type MeetingSourceAdapter,
} from "@echo-brain/organization-processing/core";
import {
  createGranolaContextSourceV1,
  mapGranolaMeetingToContextCaptureContentV1,
} from "../../src/context/granola-context-source-v1.js";
import type {
  GranolaApiClient,
  GranolaListParams,
  GranolaNoteDetail,
} from "../../src/source/granola-api-client.js";
import { GranolaMeetingSourceAdapter } from "../../src/source/meeting-source-adapter.js";

const config: AdapterConfig = {
  adapter_id: "granola",
  instance_id: "primary",
  settings: { page_size: 1 },
};

const detail: GranolaNoteDetail = {
  id: "note-1",
  title: "Product review",
  created_at: "2026-07-15T16:00:00.000Z",
  updated_at: "2026-07-15T17:00:00.000Z",
  summary_markdown: "## Decision\nShip the canonical bridge.",
  attendees: [{ id: "person-1", email: "alice@example.com" }],
  calendar_event: {
    start: { dateTime: "2026-07-15T15:30:00-07:00" },
  },
  web_url: "https://app.granola.ai/notes/note-1",
  transcript: [{ text: "We should ship it.", speaker: "Alice" }],
};

class FakeGranolaClient implements GranolaApiClient {
  readonly listCalls: GranolaListParams[] = [];
  readonly detailCalls: string[] = [];

  constructor(private readonly note: GranolaNoteDetail) {}

  async listNotes(params: GranolaListParams) {
    this.listCalls.push(params);
    return {
      notes: [
        {
          id: this.note.id,
          created_at: this.note.created_at,
          updated_at: this.note.updated_at,
        },
      ],
      hasMore: false,
      cursor: null,
    };
  }

  async getNote(noteId: string): Promise<GranolaNoteDetail> {
    this.detailCalls.push(noteId);
    return this.note;
  }
}

function meetingSource(note: GranolaNoteDetail, client = new FakeGranolaClient(note)) {
  return {
    client,
    source: new GranolaMeetingSourceAdapter(config, {
      client,
      now: () => "2026-07-16T00:00:00.000Z",
    }),
  };
}

describe("Granola context capture source", () => {
  it("wraps one configured Granola meeting source and retains its normalized observation", async () => {
    const { client, source } = meetingSource(detail);
    const adapter = createGranolaContextSourceV1({
      source,
      now: () => "2026-07-16T01:00:00.000Z",
    });

    const batch = await adapter.pull({ limit: 1 });

    expect(adapter.identity).toEqual({
      kind: "source",
      adapter_id: "granola-context-capture",
      instance_id: "primary",
      version: "1.0.0",
    });
    const captureConfig = { ...config, adapter_id: "granola-context-capture" };
    expect(adapter.validateConfig(captureConfig)).toEqual(source.validateConfig(config));
    expect(adapter.validateConfig(config)).toEqual({
      ok: false,
      errors: ["adapter_id must be 'granola-context-capture'"],
    });
    expect(adapter.validateConfig({ ...captureConfig, instance_id: "other" })).toEqual({
      ok: false,
      errors: ["instance_id does not match the registered adapter instance"],
    });
    expect(client.listCalls).toEqual([{ page_size: 1 }]);
    expect(client.detailCalls).toEqual(["note-1"]);
    expect(batch.next_cursor).toBeDefined();
    expect(batch.sources).toHaveLength(1);
    expect(batch.sources[0]).toMatchObject({
      item: {
        adapter: adapter.identity,
        external_id: "note-1",
      },
      revision: { captured_at: "2026-07-16T01:00:00.000Z" },
      content: {
        source_type: "meeting",
        provenance: {
          origin_ref: "https://app.granola.ai/notes/note-1",
          source_updated_at: "2026-07-15T17:00:00.000Z",
        },
        payload: {
          kind: "meeting",
          started_at: "2026-07-15T22:30:00.000Z",
        },
        representation: {
          kind: "full_snapshot",
          text: "## Decision\nShip the canonical bridge.\n\nWe should ship it.",
        },
      },
    });
    const representation = batch.sources[0]!.content.representation;
    expect(representation.kind).toBe("full_snapshot");
    if (representation.kind === "full_snapshot") {
      expect(representation.passages.map((passage) => passage.text)).toEqual([
        "## Decision\nShip the canonical bridge.",
        "We should ship it.",
      ]);
      for (const passage of representation.passages) {
        expect(representation.text.slice(passage.start, passage.end)).toBe(
          passage.text,
        );
      }
    }
  });

  it("keeps replay revisions semantic while changed normalized content changes them", async () => {
    const { source } = meetingSource(detail);
    const meeting = (await source.pull({ limit: 1 })).meetings[0]!;
    const content = mapGranolaMeetingToContextCaptureContentV1(meeting);
    const identity = {
      kind: "source" as const,
      adapter_id: "granola-context-capture",
      instance_id: "primary",
      version: "1.0.0",
    };
    const first = buildContextCaptureEnvelopeV1({
      identity,
      external_id: meeting.provenance.external_id,
      captured_at: "2026-07-16T01:00:00.000Z",
      content,
    });
    const replay = buildContextCaptureEnvelopeV1({
      identity: { ...identity, version: "1.0.1" },
      external_id: meeting.provenance.external_id,
      captured_at: "2026-07-16T02:00:00.000Z",
      content,
    });
    const changed = mapGranolaMeetingToContextCaptureContentV1({
      ...meeting,
      content: meeting.content.map((block, index) =>
        index === 0 ? { ...block, text: `${block.text} Revised.` } : block,
      ),
    });
    const changedEnvelope = buildContextCaptureEnvelopeV1({
      identity,
      external_id: meeting.provenance.external_id,
      captured_at: "2026-07-16T03:00:00.000Z",
      content: changed,
    });

    expect(replay.revision.revision_id).toBe(first.revision.revision_id);
    expect(replay.revision.captured_at).not.toBe(first.revision.captured_at);
    expect(changedEnvelope.revision.revision_id).not.toBe(first.revision.revision_id);
  });


  it("keeps an ordinary multi-line snapshot exact while bounding its anchor set", async () => {
    const lines = Array.from({ length: 40 }, (_, index) => `Line ${index + 1}`).join("\n");
    const { source } = meetingSource(detail);
    const meeting = (await source.pull({ limit: 1 })).meetings[0]!;
    const captured = mapGranolaMeetingToContextCaptureContentV1({
      ...meeting,
      content: [{ ...meeting.content[0]!, text: lines }],
    });
    const representation = captured.representation;
    expect(representation.kind).toBe("full_snapshot");
    if (representation.kind === "full_snapshot") {
      expect(representation.text).toBe(lines);
      expect(representation.passages).toHaveLength(1);
      expect(representation.passages.length).toBeLessThanOrEqual(32);
      expect(representation.text.slice(
        representation.passages[0]!.start,
        representation.passages[0]!.end,
      )).toBe(lines);
    }
  });

  it("allows an oversized provider body when pointer capture is selected", async () => {
    const oversized: GranolaNoteDetail = {
      ...detail,
      id: "pointer-large",
      summary_markdown: "A".repeat(129 * 1024),
    };
    const { source } = meetingSource(oversized);
    const adapter = createGranolaContextSourceV1({
      source,
      representation: "pointer",
      now: () => "2026-07-16T01:00:00.000Z",
    });

    const batch = await adapter.pull({ limit: 1 });
    expect(batch.sources[0]!.content.representation).toEqual({
      kind: "pointer",
      pointer: "https://app.granola.ai/notes/note-1",
    });
  });

  it("rejects a returned meeting whose provenance is not the configured source", async () => {
    const { source } = meetingSource(detail);
    const meeting = (await source.pull({ limit: 1 })).meetings[0]!;
    const wrongProvenance: MeetingSourceAdapter = {
      identity: source.identity,
      validateConfig: (candidate) => source.validateConfig(candidate),
      healthCheck: (operation) => source.healthCheck(operation),
      pull: async () => ({
        meetings: [{
          ...meeting,
          provenance: {
            ...meeting.provenance,
            source: { ...meeting.provenance.source, instance_id: "other-instance" },
          },
        }],
      }),
    };
    const adapter = createGranolaContextSourceV1({
      source: wrongProvenance,
      now: () => "2026-07-16T01:00:00.000Z",
    });

    await expect(adapter.pull({ limit: 1 })).rejects.toMatchObject({
      code: "permanently_rejected",
      retryable: false,
    } satisfies Partial<AdapterError>);
  });

  it("rejects a wrapped source whose identity changes after construction", async () => {
    const { source } = meetingSource(detail);
    let identity = source.identity;
    const driftingSource: MeetingSourceAdapter = {
      get identity() { return identity; },
      validateConfig: (candidate) => source.validateConfig(candidate),
      healthCheck: (operation) => source.healthCheck(operation),
      pull: (request, operation) => source.pull(request, operation),
    };
    const adapter = createGranolaContextSourceV1({
      source: driftingSource,
      now: () => "2026-07-16T01:00:00.000Z",
    });
    identity = { ...identity, instance_id: "other-instance" };

    await expect(adapter.pull({ limit: 1 })).rejects.toMatchObject({
      code: "permanently_rejected",
      retryable: false,
    } satisfies Partial<AdapterError>);
  });

  it("classifies a note with no source meeting start as a plain-text note", async () => {
    const { source } = meetingSource({ ...detail, calendar_event: undefined });
    const adapter = createGranolaContextSourceV1({
      source,
      now: () => "2026-07-16T01:00:00.000Z",
    });

    const batch = await adapter.pull({ limit: 1 });

    expect(batch.sources[0]!.content).toMatchObject({
      source_type: "note",
      payload: { kind: "note", format: "plain_text" },
    });
  });

  it("rejects an oversized source observation without producing a cursor", async () => {
    const oversized: GranolaNoteDetail = {
      ...detail,
      id: "too-large",
      summary_markdown: "A".repeat(129 * 1024),
    };
    const { client, source } = meetingSource(oversized);
    const adapter = createGranolaContextSourceV1({
      source,
      now: () => "2026-07-16T01:00:00.000Z",
    });

    await expect(adapter.pull({ limit: 1 })).rejects.toMatchObject({
      code: "permanently_rejected",
      retryable: false,
    } satisfies Partial<AdapterError>);
    await expect(adapter.pull({ limit: 1 })).rejects.toMatchObject({
      code: "permanently_rejected",
      retryable: false,
    } satisfies Partial<AdapterError>);
    expect(client.listCalls).toEqual([{ page_size: 1 }, { page_size: 1 }]);
  });
});
