import { describe, expect, it } from "vitest";
import { AdapterError, type AdapterConfig } from "../../../src/processing/core/index.js";
import {
  GranolaApiError,
  GranolaMeetingSourceAdapter,
  HttpGranolaApiClient,
  createGranolaPostCutoffCursor,
  granolaCursorPhase,
  type GranolaApiClient,
  type GranolaListParams,
  type GranolaListResponse,
  type GranolaNoteDetail,
} from "../../../src/processing/adapters/meeting-sources/granola/index.js";
import { adapterConformance } from "../../../../../tests/support/adapter-conformance.js";

const config: AdapterConfig = {
  adapter_id: "granola",
  instance_id: "primary",
  credential_ref: "env:GRANOLA_API_KEY",
  settings: {
    page_size: 2,
    cursor_overlap_ms: 1_000,
  },
};

const ownerBoundaryConfig: AdapterConfig = {
  ...config,
  settings: {
    ...config.settings,
    owner_email: "audrey@echobrain.org",
  },
};

const detail: GranolaNoteDetail = {
  id: "note-1",
  object: "note",
  title: "Product review",
  created_at: "2026-07-15T16:00:00.000Z",
  updated_at: "2026-07-15T17:00:00.000Z",
  summary_markdown: "## Decision\nShip the canonical bridge.",
  attendees: [
    { id: "person-1", name: "Alice", email: "ALICE@example.com" },
    "bob@example.com",
  ],
  owner: { name: "Owner", email: "owner@example.com" },
  calendar_event: {
    start: { dateTime: "2026-07-15T15:30:00-07:00" },
  },
  folder_membership: [
    {
      object: "folder",
      id: "fol_4y6LduVdwSKC27",
      name: "echo-restricted",
      parent_folder_id: null,
      space_id: "spa_4y6LduVdwSKC27",
    },
  ],
  web_url: "https://app.granola.ai/notes/note-1",
  transcript: [
    {
      text: "We should ship it.",
      start_time: 1.25,
      end_time: 3.5,
      speaker: { name: "Alice", email: "alice@example.com" },
    },
    { text: "Agreed.", start: "4.0", speaker: "Owner" },
    { text: "   ", speaker: "Ignored" },
  ],
};

const liveCalendarShapeDetail: GranolaNoteDetail = {
  id: "note-live-calendar-shape",
  object: "note",
  title: "Live calendar shape",
  created_at: "2026-07-15T16:00:00.000Z",
  updated_at: "2026-07-15T17:00:00.000Z",
  summary_text: "Preserve the live calendar fields.",
  calendar_event: {
    calendar_event_id: "calendar-event-123",
    event_title: "Live calendar shape",
    scheduled_start_time: "2026-07-15T09:30:00-07:00",
    scheduled_end_time: "2026-07-15T10:15:00-07:00",
    organiser: "FOUNDER@example.com",
    invitees: [
      { email: "founder@example.com" },
      { email: "teammate@example.com" },
    ],
  },
  transcript: [
    {
      text: "We should preserve the live calendar fields.",
      start_time: 0,
      speaker: { name: "Founder", email: "founder@example.com" },
    },
    {
      text: "And link invitees to transcript speakers.",
      start_time: 2.5,
      speaker: { name: "Teammate", email: "teammate@example.com" },
    },
  ],
};

const documentedSpeakerShapeDetail = {
  id: "note-documented-speaker-shape",
  object: "note",
  title: "Documented speaker shape",
  created_at: "2026-07-15T18:00:00.000Z",
  updated_at: "2026-07-15T19:00:00.000Z",
  summary_text: "Documented speaker-shape summary.",
  owner: { name: "Note Owner", email: "owner@example.com" },
  transcript: [
    {
      text: "Local audio, first turn.",
      start_time: "2026-07-15T18:00:00.000Z",
      speaker: { source: "microphone" },
    },
    {
      text: "Remote audio.",
      start_time: "2026-07-15T18:00:01.000Z",
      speaker: { source: "speaker" },
    },
    {
      text: "Local audio, second turn.",
      start_time: "2026-07-15T18:00:02.000Z",
      speaker: { source: "microphone" },
    },
    {
      text: "Diarized speaker A, first turn.",
      start_time: "2026-07-15T18:00:03.000Z",
      speaker: { source: "microphone", diarization_label: "Speaker A" },
    },
    {
      text: "Diarized speaker B.",
      start_time: "2026-07-15T18:00:04.000Z",
      speaker: { source: "microphone", diarization_label: "Speaker B" },
    },
    {
      text: "Diarized speaker A, second turn.",
      start_time: "2026-07-15T18:00:05.000Z",
      speaker: { source: "microphone", diarization_label: "Speaker A" },
    },
  ],
} as unknown as GranolaNoteDetail;

class FakeClient implements GranolaApiClient {
  readonly listCalls: GranolaListParams[] = [];
  readonly detailCalls: string[] = [];

  constructor(
    private readonly responses: GranolaListResponse[],
    private readonly details: ReadonlyMap<string, GranolaNoteDetail> = new Map([
      [detail.id, detail],
    ]),
  ) {}

  async listNotes(params: GranolaListParams): Promise<GranolaListResponse> {
    this.listCalls.push(params);
    const response = this.responses.shift();
    if (response === undefined)
      return { notes: [], hasMore: false, cursor: null };
    return response;
  }

  async getNote(noteId: string): Promise<GranolaNoteDetail> {
    this.detailCalls.push(noteId);
    const note = this.details.get(noteId);
    if (note === undefined) throw new Error(`missing fixture ${noteId}`);
    return note;
  }
}

function emptyClient(): GranolaApiClient {
  return new FakeClient([{ notes: [], hasMore: false, cursor: null }]);
}

function ownerBoundaryAdapter(
  responses: GranolaListResponse[],
  details?: ReadonlyMap<string, GranolaNoteDetail>,
): { client: FakeClient; adapter: GranolaMeetingSourceAdapter } {
  const client = new FakeClient(responses, details);
  return {
    client,
    adapter: new GranolaMeetingSourceAdapter(ownerBoundaryConfig, {
      client,
      now: () => "2026-07-16T00:00:00.000Z",
    }),
  };
}

adapterConformance({
  name: "Granola meeting source",
  kind: "meeting-source",
  create: () =>
    new GranolaMeetingSourceAdapter(config, {
      client: emptyClient(),
      now: () => "2026-07-16T00:00:00.000Z",
    }),
  validConfig: config,
  invalidConfig: {
    adapter_id: "granola",
    instance_id: "Invalid Instance",
    credential_ref: "env:SECRET_MUST_NOT_APPEAR",
    settings: { page_size: 31 },
  },
});

describe("Granola canonical meeting mapping", () => {
  it("forwards host cancellation to list/detail work and stops the page", async () => {
    const controller = new AbortController();
    let listSignal: AbortSignal | undefined;
    let detailSignal: AbortSignal | undefined;
    let announceDetail!: () => void;
    const detailStarted = new Promise<void>((resolve) => {
      announceDetail = resolve;
    });
    const client: GranolaApiClient = {
      async listNotes(_params, options) {
        listSignal = options?.signal;
        return {
          notes: [{ id: "note-1" }, { id: "note-2" }],
          hasMore: false,
          cursor: null,
        };
      },
      async getNote(_noteId, options) {
        detailSignal = options?.signal;
        announceDetail();
        return await new Promise<GranolaNoteDetail>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new GranolaApiError("cancelled", "timeout")),
            {
              once: true,
            },
          );
        });
      },
    };
    const adapter = new GranolaMeetingSourceAdapter(config, {
      client,
      now: () => "2026-07-16T00:00:00.000Z",
    });
    const pull = adapter.pull({}, { signal: controller.signal });
    await detailStarted;
    controller.abort(new Error("shutdown"));

    await expect(pull).rejects.toMatchObject({
      code: "timeout",
      retryable: true,
    });
    expect(listSignal).toBe(controller.signal);
    expect(detailSignal).toBe(controller.signal);
  });

  it("maps notes, participants, transcript turns, revision, and provenance", async () => {
    const response: GranolaListResponse = {
      notes: [
        {
          id: detail.id,
          title: detail.title,
          created_at: detail.created_at,
          updated_at: detail.updated_at,
        },
      ],
      hasMore: false,
      cursor: null,
    };
    const firstClient = new FakeClient([response]);
    const secondClient = new FakeClient([
      { ...response, notes: [...response.notes] },
    ]);
    const first = await new GranolaMeetingSourceAdapter(config, {
      client: firstClient,
      now: () => "2026-07-16T00:00:00.000Z",
    }).pull({ limit: 1 });
    const second = await new GranolaMeetingSourceAdapter(config, {
      client: secondClient,
      now: () => "2026-07-16T01:00:00.000Z",
    }).pull({ limit: 1 });

    const meeting = first.meetings[0]!;
    expect(firstClient.listCalls).toEqual([{ page_size: 1 }]);
    expect(firstClient.detailCalls).toEqual(["note-1"]);
    expect(meeting).toMatchObject({
      schema_version: 1,
      id: "granola:primary:note-1",
      title: "Product review",
      time: { scheduled_start_at: "2026-07-15T22:30:00.000Z" },
      artifacts: [],
      provenance: {
        source: {
          kind: "meeting-source",
          adapter_id: "granola",
          instance_id: "primary",
          version: "2.2.0",
        },
        external_id: "note-1",
        observed_at: "2026-07-16T00:00:00.000Z",
        normalizer_version: "2.2.0",
        source_created_at: "2026-07-15T16:00:00.000Z",
        source_updated_at: "2026-07-15T17:00:00.000Z",
        source_url: "https://app.granola.ai/notes/note-1",
      },
    });
    expect(meeting.participants).toEqual([
      {
        id: "source:person-1",
        display_name: "Alice",
        identities: [
          { kind: "source", value: "person-1" },
          { kind: "email", value: "alice@example.com" },
        ],
        roles: ["attendee", "speaker"],
      },
      {
        id: "email:bob@example.com",
        display_name: "bob@example.com",
        identities: [{ kind: "email", value: "bob@example.com" }],
        roles: ["attendee"],
      },
      {
        id: "name:sha256:4c1029697ee358715d3a14a2add817c4b01651440de808371f78165ac90dc581",
        display_name: "Owner",
        roles: ["speaker"],
      },
    ]);
    expect(meeting.content).toEqual([
      {
        id: "note-1:summary",
        kind: "summary",
        text: "## Decision\nShip the canonical bridge.",
        origin: "source_ai",
        metadata: { format: "markdown" },
      },
      {
        id: "note-1:transcript:0",
        kind: "transcript",
        text: "We should ship it.",
        speaker_participant_id: "source:person-1",
        sequence: 0,
        start_offset_ms: 1_250,
        end_offset_ms: 3_500,
        origin: "imported",
        metadata: {
          source_index: 0,
          granola: {
            speaker: { name: "Alice", email: "alice@example.com" },
            speaker_resolution: "named_identity",
          },
        },
      },
      {
        id: "note-1:transcript:1",
        kind: "transcript",
        text: "Agreed.",
        speaker_participant_id:
          "name:sha256:4c1029697ee358715d3a14a2add817c4b01651440de808371f78165ac90dc581",
        sequence: 1,
        start_offset_ms: 4_000,
        origin: "imported",
        metadata: {
          source_index: 1,
          granola: {
            speaker: "Owner",
            speaker_resolution: "named_identity",
          },
        },
      },
    ]);
    expect(meeting.capture).toMatchObject({
      state: "complete",
      components: expect.arrayContaining([
        { kind: "summary", state: "available" },
        { kind: "transcript", state: "available" },
        { kind: "recording", state: "not_provided" },
      ]),
    });
    expect(meeting.extensions).toMatchObject({
      granola: {
        folder_membership: [
          {
            object: "folder",
            id: "fol_4y6LduVdwSKC27",
            name: "echo-restricted",
            parent_folder_id: null,
            space_id: "spa_4y6LduVdwSKC27",
          },
        ],
      },
    });
    expect(meeting.provenance.canonical_revision).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
    expect(second.meetings[0]!.provenance.canonical_revision).toBe(
      meeting.provenance.canonical_revision,
    );
    expect(second.meetings[0]!.provenance.observed_at).not.toBe(
      meeting.provenance.observed_at,
    );

    const withoutFolderClient = new FakeClient(
      [{ ...response, notes: [...response.notes] }],
      new Map([[detail.id, { ...detail, folder_membership: [] }]]),
    );
    const withoutFolder = await new GranolaMeetingSourceAdapter(config, {
      client: withoutFolderClient,
      now: () => "2026-07-16T02:00:00.000Z",
    }).pull({ limit: 1 });
    expect(withoutFolder.meetings[0]!.provenance.canonical_revision).not.toBe(
      meeting.provenance.canonical_revision,
    );
  });

  it("skips notes without both generated summary and transcript content", async () => {
    const missingSummary: GranolaNoteDetail = {
      ...detail,
      id: "note-missing-summary",
      summary_markdown: null,
      summary_text: null,
    };
    const missingTranscript: GranolaNoteDetail = {
      ...detail,
      id: "note-missing-transcript",
      transcript: [{ text: "   " }],
    };
    const client = new FakeClient(
      [
        {
          notes: [
            {
              id: missingSummary.id,
              updated_at: missingSummary.updated_at,
            },
            {
              id: missingTranscript.id,
              updated_at: missingTranscript.updated_at,
            },
          ],
          hasMore: false,
          cursor: null,
        },
      ],
      new Map([
        [missingSummary.id, missingSummary],
        [missingTranscript.id, missingTranscript],
      ]),
    );

    const batch = await new GranolaMeetingSourceAdapter(config, {
      client,
      now: () => "2026-07-16T00:00:00.000Z",
    }).pull({});

    expect(client.detailCalls).toEqual([
      missingSummary.id,
      missingTranscript.id,
    ]);
    expect(batch.meetings).toEqual([]);
  });

  it("admits a skipped note after Granola publishes a completed revision", async () => {
    const partial: GranolaNoteDetail = {
      ...detail,
      id: "note-completes-later",
      updated_at: "2026-07-15T17:00:00.000Z",
      transcript: null,
    };
    const completed: GranolaNoteDetail = {
      ...partial,
      updated_at: "2026-07-15T18:00:00.000Z",
      transcript: [{ text: "The transcript is now complete." }],
    };
    const details = new Map([[partial.id, partial]]);
    const client = new FakeClient(
      [
        {
          notes: [{ id: partial.id, updated_at: partial.updated_at }],
          hasMore: false,
          cursor: null,
        },
        {
          notes: [{ id: completed.id, updated_at: completed.updated_at }],
          hasMore: false,
          cursor: null,
        },
      ],
      details,
    );
    const adapter = new GranolaMeetingSourceAdapter(config, {
      client,
      now: () => "2026-07-16T00:00:00.000Z",
    });

    const first = await adapter.pull({});
    details.set(completed.id, completed);
    const second = await adapter.pull({ cursor: first.next_cursor });

    expect(first.meetings).toEqual([]);
    expect(second.meetings).toHaveLength(1);
    expect(second.meetings[0]).toMatchObject({
      id: "granola:primary:note-completes-later",
      capture: { state: "complete" },
    });
    expect(client.listCalls).toEqual([
      { page_size: 2 },
      { updated_after: "2026-07-15T16:59:59.000Z", page_size: 2 },
    ]);
  });

  it("stores one summary form: Markdown wins and the plain-text copy is not duplicated", async () => {
    const bothFormsDetail: GranolaNoteDetail = {
      id: "note-both-forms",
      object: "note",
      title: "Both summary forms",
      created_at: "2026-07-15T16:00:00.000Z",
      updated_at: "2026-07-15T17:00:00.000Z",
      summary_markdown: "## Decision\nShip the canonical bridge.",
      summary_text: "Decision\nShip the canonical bridge.",
      transcript: [{ text: "Transcript available." }],
    };
    const response: GranolaListResponse = {
      notes: [
        { id: bothFormsDetail.id, updated_at: bothFormsDetail.updated_at },
      ],
      hasMore: false,
      cursor: null,
    };
    const batch = await new GranolaMeetingSourceAdapter(config, {
      client: new FakeClient(
        [response],
        new Map([[bothFormsDetail.id, bothFormsDetail]]),
      ),
      now: () => "2026-07-16T00:00:00.000Z",
    }).pull({ limit: 1 });

    expect(batch.meetings[0]!.content[0]).toEqual({
      id: "note-both-forms:summary",
      kind: "summary",
      text: "## Decision\nShip the canonical bridge.",
      origin: "source_ai",
      metadata: { format: "markdown" },
    });
  });

  it("falls back to the plain-text summary when Granola sends no Markdown", async () => {
    const plainOnlyDetail: GranolaNoteDetail = {
      id: "note-plain-only",
      object: "note",
      title: "Plain summary only",
      created_at: "2026-07-15T16:00:00.000Z",
      updated_at: "2026-07-15T17:00:00.000Z",
      summary_text: "Decision: ship the canonical bridge.",
      transcript: [{ text: "Transcript available." }],
    };
    const response: GranolaListResponse = {
      notes: [
        { id: plainOnlyDetail.id, updated_at: plainOnlyDetail.updated_at },
      ],
      hasMore: false,
      cursor: null,
    };
    const batch = await new GranolaMeetingSourceAdapter(config, {
      client: new FakeClient(
        [response],
        new Map([[plainOnlyDetail.id, plainOnlyDetail]]),
      ),
      now: () => "2026-07-16T00:00:00.000Z",
    }).pull({ limit: 1 });

    expect(batch.meetings[0]!.content[0]).toEqual({
      id: "note-plain-only:summary",
      kind: "summary",
      text: "Decision: ship the canonical bridge.",
      origin: "source_ai",
      metadata: { format: "text" },
    });
  });

  it("normalizes the live Granola calendar shape and links its people to transcript turns", async () => {
    const client = new FakeClient(
      [
        {
          notes: [
            {
              id: liveCalendarShapeDetail.id,
              updated_at: liveCalendarShapeDetail.updated_at,
            },
          ],
          hasMore: false,
          cursor: null,
        },
      ],
      new Map([[liveCalendarShapeDetail.id, liveCalendarShapeDetail]]),
    );

    const result = await new GranolaMeetingSourceAdapter(config, {
      client,
      now: () => "2026-07-16T00:00:00.000Z",
    }).pull({ limit: 1 });

    const meeting = result.meetings[0]!;
    expect(meeting.time).toEqual({
      scheduled_start_at: "2026-07-15T16:30:00.000Z",
      scheduled_end_at: "2026-07-15T17:15:00.000Z",
    });
    expect(meeting.context).toEqual({
      owner_participant_id: "email:founder@example.com",
      calendar: {
        event_id: "calendar-event-123",
        organizer_participant_id: "email:founder@example.com",
      },
    });
    expect(meeting.participants).toHaveLength(2);
    expect(meeting.participants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "email:founder@example.com",
          identities: [{ kind: "email", value: "founder@example.com" }],
          roles: expect.arrayContaining(["invitee", "organizer", "speaker"]),
        }),
        expect.objectContaining({
          id: "email:teammate@example.com",
          identities: [{ kind: "email", value: "teammate@example.com" }],
          roles: expect.arrayContaining(["invitee", "speaker"]),
        }),
      ]),
    );
    expect(
      meeting.content.filter((block) => block.kind === "transcript"),
    ).toEqual([
      expect.objectContaining({
        id: "note-live-calendar-shape:transcript:0",
        speaker_participant_id: "email:founder@example.com",
      }),
      expect.objectContaining({
        id: "note-live-calendar-shape:transcript:1",
        speaker_participant_id: "email:teammate@example.com",
      }),
    ]);
  });

  it("normalizes an ad-hoc note owner only when its calendar event is absent", async () => {
    const adHocDetail: GranolaNoteDetail = {
      ...detail,
      id: "note-ad-hoc-owner",
      calendar_event: null,
      owner: { email: "OWNER@example.com", name: "Owner" },
    };
    const malformedCalendarDetail: GranolaNoteDetail = {
      ...adHocDetail,
      id: "note-malformed-calendar-owner",
      calendar_event: { organizer: { name: "Owner" } },
    };
    const client = new FakeClient(
      [
        {
          notes: [
            { id: adHocDetail.id, updated_at: adHocDetail.updated_at },
            {
              id: malformedCalendarDetail.id,
              updated_at: malformedCalendarDetail.updated_at,
            },
          ],
          hasMore: false,
          cursor: null,
        },
      ],
      new Map([
        [adHocDetail.id, adHocDetail],
        [malformedCalendarDetail.id, malformedCalendarDetail],
      ]),
    );

    const result = await new GranolaMeetingSourceAdapter(config, {
      client,
      now: () => "2026-07-16T00:00:00.000Z",
    }).pull({ limit: 2 });

    const adHoc = result.meetings[0]!;
    expect(adHoc.context?.owner_participant_id).toBe("email:owner@example.com");
    expect(adHoc.participants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "email:owner@example.com",
          identities: [{ kind: "email", value: "owner@example.com" }],
        }),
      ]),
    );
    expect(result.meetings[1]!.context?.owner_participant_id).toBeUndefined();
    expect(result.meetings[1]!.participants).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "email:owner@example.com" })]),
    );
  });

  it("leaves audio channels unlinked and creates stable meeting-local diarization speakers", async () => {
    const response: GranolaListResponse = {
      notes: [
        {
          id: documentedSpeakerShapeDetail.id,
          updated_at: documentedSpeakerShapeDetail.updated_at,
        },
      ],
      hasMore: false,
      cursor: null,
    };
    const details = new Map([
      [documentedSpeakerShapeDetail.id, documentedSpeakerShapeDetail],
    ]);
    const first = await new GranolaMeetingSourceAdapter(config, {
      client: new FakeClient([response], details),
      now: () => "2026-07-16T00:00:00.000Z",
    }).pull({ limit: 1 });
    const second = await new GranolaMeetingSourceAdapter(config, {
      client: new FakeClient(
        [{ ...response, notes: [...response.notes] }],
        details,
      ),
      now: () => "2026-07-16T01:00:00.000Z",
    }).pull({ limit: 1 });

    const meeting = first.meetings[0]!;
    const transcript = meeting.content.filter(
      (block) => block.kind === "transcript",
    );
    const speakerReferences = transcript.map(
      (block) => block.speaker_participant_id,
    );
    expect(speakerReferences).toHaveLength(6);
    expect(speakerReferences.slice(0, 3)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(speakerReferences[3]).toBe(speakerReferences[5]);
    expect(speakerReferences[3]).toBeDefined();
    expect(speakerReferences[4]).toBeDefined();
    expect(speakerReferences[3]).not.toBe(speakerReferences[4]);
    expect(
      second.meetings[0]!.content
        .filter((block) => block.kind === "transcript")
        .map((block) => block.speaker_participant_id),
    ).toEqual(speakerReferences);

    expect(meeting.participants).toHaveLength(3);
    expect(
      meeting.participants.some(
        (participant) => participant.id === "email:owner@example.com",
      ),
    ).toBe(true);
    expect(meeting.context?.owner_participant_id).toBe(
      "email:owner@example.com",
    );
    expect(meeting.extensions).toMatchObject({
      granola: {
        owner: { name: "Note Owner", email: "owner@example.com" },
      },
    });
    for (const reference of speakerReferences.slice(3)) {
      const participant = meeting.participants.find(
        (candidate) => candidate.id === reference,
      );
      expect(participant?.roles).toContain("speaker");
      expect(
        participant?.identities?.some((identity) => identity.kind === "email"),
      ).not.toBe(true);
    }

    expect(transcript[0]?.metadata).toMatchObject({
      source_index: 0,
      granola: {
        speaker: { source: "microphone" },
        speaker_resolution: "audio_channel",
      },
    });
    expect(transcript[1]?.metadata).toMatchObject({
      source_index: 1,
      granola: {
        speaker: { source: "speaker" },
        speaker_resolution: "audio_channel",
      },
    });
    expect(transcript[3]?.metadata).toMatchObject({
      source_index: 3,
      granola: {
        speaker: { source: "microphone", diarization_label: "Speaker A" },
        speaker_resolution: "diarization_bucket",
      },
    });
  });

  it("refuses an oversized provider page before fetching any note detail", async () => {
    const client = new FakeClient([
      {
        notes: [{ id: "note-1" }, { id: "note-2" }],
        hasMore: false,
        cursor: null,
      },
    ]);
    const adapter = new GranolaMeetingSourceAdapter(config, {
      client,
      now: () => "2026-07-16T00:00:00.000Z",
    });

    await expect(adapter.pull({ limit: 1 })).rejects.toMatchObject({
      code: "temporarily_unavailable",
      retryable: true,
    });
    expect(client.listCalls).toEqual([{ page_size: 1 }]);
    expect(client.detailCalls).toEqual([]);
  });

  it("keeps the page token and high-water mark in an opaque stable cursor", async () => {
    const secondDetail: GranolaNoteDetail = {
      ...detail,
      id: "note-2",
      updated_at: "2026-07-15T18:00:00.000Z",
    };
    const client = new FakeClient(
      [
        {
          notes: [{ id: detail.id, updated_at: detail.updated_at }],
          hasMore: true,
          cursor: "private-page-token",
        },
        {
          notes: [{ id: secondDetail.id, updated_at: secondDetail.updated_at }],
          hasMore: false,
          cursor: null,
        },
        { notes: [], hasMore: false, cursor: null },
      ],
      new Map([
        [detail.id, detail],
        [secondDetail.id, secondDetail],
      ]),
    );
    const adapter = new GranolaMeetingSourceAdapter(config, {
      client,
      now: () => "2026-07-16T00:00:00.000Z",
    });

    const first = await adapter.pull({});
    const second = await adapter.pull({ cursor: first.next_cursor });
    await adapter.pull({ cursor: second.next_cursor });

    expect(first.next_cursor).toMatch(/^granola:v1:/);
    expect(first.next_cursor).not.toContain("private-page-token");
    expect(client.listCalls).toEqual([
      { page_size: 2 },
      { cursor: "private-page-token", page_size: 2 },
      { updated_after: "2026-07-15T17:59:59.000Z", page_size: 2 },
    ]);
  });

  it("keeps the update filter when continuing a live page", async () => {
    const client = new FakeClient([
      { notes: [], hasMore: false, cursor: null },
    ]);
    const adapter = new GranolaMeetingSourceAdapter(config, {
      client,
      now: () => "2026-07-16T00:00:00.000Z",
    });
    const cursor = `granola:v1:${Buffer.from(
      JSON.stringify({
        schema_version: 1,
        watermark: "2026-07-15T18:00:00.000Z",
        page_cursor: "private-live-page-token",
        page_high_watermark: "2026-07-15T18:30:00.000Z",
      }),
    ).toString("base64url")}`;

    await adapter.pull({ cursor });

    expect(client.listCalls).toEqual([
      {
        cursor: "private-live-page-token",
        updated_after: "2026-07-15T17:59:59.000Z",
        page_size: 2,
      },
    ]);
  });

  it("creates and classifies a post-cutoff cursor without exposing page state", async () => {
    const cutoffAt = "2026-07-15T18:00:00.000Z";
    const cursor = createGranolaPostCutoffCursor(cutoffAt);
    const initialHistoryCursor = `granola:v1:${Buffer.from(
      JSON.stringify({
        schema_version: 1,
        watermark: null,
        page_cursor: "private-initial-history-token",
        page_high_watermark: "2026-07-15T17:00:00.000Z",
      }),
    ).toString("base64url")}`;
    const client = new FakeClient([
      { notes: [], hasMore: false, cursor: null },
    ]);
    const adapter = new GranolaMeetingSourceAdapter(config, { client });

    expect(granolaCursorPhase(undefined)).toBe("uninitialized");
    expect(granolaCursorPhase(initialHistoryCursor)).toBe("initial-history");
    expect(granolaCursorPhase(cursor)).toBe("live");
    expect(cursor).not.toContain("page_cursor");
    await adapter.pull({ cursor });
    expect(client.listCalls).toEqual([
      { updated_after: cutoffAt, page_size: 2 },
    ]);
    expect(() => createGranolaPostCutoffCursor("2026-07-15T18:00:00Z")).toThrow(
      "canonical ISO timestamp",
    );
  });

  it("accepts the legacy ISO high-water mark and emits a v1 cursor", async () => {
    const client = new FakeClient([
      { notes: [], hasMore: false, cursor: null },
    ]);
    const adapter = new GranolaMeetingSourceAdapter(config, {
      client,
      now: () => "2026-07-16T00:00:00.000Z",
    });
    const result = await adapter.pull({ cursor: "2026-07-15T17:00:00.000Z" });
    expect(client.listCalls).toEqual([
      { updated_after: "2026-07-15T16:59:59.000Z", page_size: 2 },
    ]);
    expect(result.next_cursor).toMatch(/^granola:v1:/);
  });
});

describe("Granola owner boundary", () => {
  it("fetches detail only for an exact canonical owner match", async () => {
    const ownedDetail: GranolaNoteDetail = {
      ...detail,
      id: "note-audrey",
      owner: undefined,
    };
    const { client, adapter } = ownerBoundaryAdapter(
      [
        {
          notes: [
            {
              id: ownedDetail.id,
              owner: { name: "Audrey Ng", email: " Audrey@ECHOBrain.org " },
              updated_at: ownedDetail.updated_at,
            },
          ],
          hasMore: false,
          cursor: null,
        },
      ],
      new Map([[ownedDetail.id, ownedDetail]]),
    );

    const result = await adapter.pull({});

    expect(client.detailCalls).toEqual([ownedDetail.id]);
    expect(result.meetings).toHaveLength(1);
    expect(result.meetings[0]?.provenance.external_id).toBe(ownedDetail.id);
    expect(result.meetings[0]?.extensions).toMatchObject({
      granola: {
        owner: { name: "Audrey Ng", email: " Audrey@ECHOBrain.org " },
      },
    });
  });

  it("skips other, missing, malformed, or non-canonical list owners before detail", async () => {
    const { client, adapter } = ownerBoundaryAdapter([
      {
        notes: [
          {
            id: detail.id,
            owner: { name: "Zhen", email: "zhen@echobrain.org" },
            updated_at: detail.updated_at,
          },
          { id: "note-missing-owner", updated_at: detail.updated_at },
          {
            id: "note-missing-email",
            owner: { name: "Audrey Ng" },
            updated_at: detail.updated_at,
          },
          {
            id: "note-whitespace-owner",
            owner: { email: "audrey @echobrain.org" },
            updated_at: detail.updated_at,
          },
          {
            id: "note-malformed-owner",
            owner: { email: "audrey@@echobrain.org" },
            updated_at: detail.updated_at,
          },
        ],
        hasMore: false,
        cursor: null,
      },
    ]);

    const result = await adapter.pull({});

    expect(result.meetings).toEqual([]);
    expect(client.detailCalls).toEqual([]);
  });

  it("discards detail responses with contradictory or malformed owners", async () => {
    const contradictoryDetail: GranolaNoteDetail = {
      ...detail,
      id: "note-owner-changed",
      owner: { name: "Zhen", email: "zhen@echobrain.org" },
    };
    const malformedDetail: GranolaNoteDetail = {
      ...detail,
      id: "note-owner-malformed",
      owner: { name: "Audrey Ng", email: "audrey@@echobrain.org" },
    };
    const { client, adapter } = ownerBoundaryAdapter(
      [
        {
          notes: [
            {
              id: contradictoryDetail.id,
              owner: { name: "Audrey Ng", email: "audrey@echobrain.org" },
              updated_at: contradictoryDetail.updated_at,
            },
            {
              id: malformedDetail.id,
              owner: { name: "Audrey Ng", email: "audrey@echobrain.org" },
              updated_at: malformedDetail.updated_at,
            },
          ],
          hasMore: false,
          cursor: null,
        },
      ],
      new Map([
        [contradictoryDetail.id, contradictoryDetail],
        [malformedDetail.id, malformedDetail],
      ]),
    );

    const result = await adapter.pull({});

    expect(client.detailCalls).toEqual([
      contradictoryDetail.id,
      malformedDetail.id,
    ]);
    expect(result.meetings).toEqual([]);
  });

  it("advances provider pagination and watermark across skipped owners", async () => {
    const { client, adapter } = ownerBoundaryAdapter([
      {
        notes: [
          {
            id: "note-other-page-one",
            owner: { email: "zhen@echobrain.org" },
            updated_at: "2026-07-15T17:00:00.000Z",
          },
        ],
        hasMore: true,
        cursor: "private-page-token",
      },
      {
        notes: [
          {
            id: "note-other-page-two",
            owner: { email: "zhen@echobrain.org" },
            updated_at: "2026-07-15T18:00:00.000Z",
          },
        ],
        hasMore: false,
        cursor: null,
      },
      { notes: [], hasMore: false, cursor: null },
    ]);

    const first = await adapter.pull({});
    const second = await adapter.pull({ cursor: first.next_cursor });
    await adapter.pull({ cursor: second.next_cursor });

    expect(first.meetings).toEqual([]);
    expect(second.meetings).toEqual([]);
    expect(client.detailCalls).toEqual([]);
    expect(client.listCalls).toEqual([
      { page_size: 2 },
      { cursor: "private-page-token", page_size: 2 },
      { updated_after: "2026-07-15T17:59:59.000Z", page_size: 2 },
    ]);
  });

  it("validates owner_email as a canonical lowercase email", () => {
    const adapter = new GranolaMeetingSourceAdapter(ownerBoundaryConfig, {
      client: emptyClient(),
    });
    expect(adapter.validateConfig(ownerBoundaryConfig)).toEqual({
      ok: true,
      errors: [],
    });

    for (const ownerEmail of [
      "Audrey@echobrain.org",
      " audrey@echobrain.org",
      "audrey@@echobrain.org",
      "audrey @echobrain.org",
      42,
    ]) {
      const candidate: AdapterConfig = {
        ...ownerBoundaryConfig,
        settings: {
          ...ownerBoundaryConfig.settings,
          owner_email: ownerEmail,
        },
      };
      expect(adapter.validateConfig(candidate)).toEqual({
        ok: false,
        errors: [
          "settings.owner_email must be a canonical lowercase email address",
        ],
      });
    }
  });
});

describe("Granola adapter failures", () => {
  it("rejects malformed cursors and limits using the common error taxonomy", async () => {
    const adapter = new GranolaMeetingSourceAdapter(config, {
      client: emptyClient(),
    });
    await expect(
      adapter.pull({ cursor: "not-a-cursor" }),
    ).rejects.toMatchObject({
      code: "invalid_config",
      retryable: false,
    });
    await expect(adapter.pull({ limit: 0 })).rejects.toMatchObject({
      code: "invalid_config",
      retryable: false,
    });
  });

  it("maps authentication failures for health and pull without leaking credentials", async () => {
    const client: GranolaApiClient = {
      listNotes: async () => {
        throw new GranolaApiError(
          "remote rejected secret-value",
          "auth_failed",
          401,
        );
      },
      getNote: async () => detail,
    };
    const adapter = new GranolaMeetingSourceAdapter(config, {
      client,
      now: () => "2026-07-16T00:00:00.000Z",
    });
    const health = await adapter.healthCheck();
    expect(health).toMatchObject({ status: "unauthorized" });
    expect(JSON.stringify(health)).not.toContain("secret-value");
    await expect(adapter.pull({})).rejects.toEqual(
      expect.objectContaining<Partial<AdapterError>>({
        code: "unauthorized",
        retryable: false,
      }),
    );
  });
});

describe("Granola HTTP response parsing", () => {
  it("preserves official speaker shapes and unmapped provider fields", async () => {
    let requestedUrl = "";
    const client = new HttpGranolaApiClient("grn_test_key", {
      fetchImpl: async (input) => {
        requestedUrl = String(input);
        return new Response(
          JSON.stringify({
            id: "note-http-shape",
            object: "note",
            title: "HTTP shape",
            created_at: "2026-07-15T18:00:00.000Z",
            updated_at: "2026-07-15T19:00:00.000Z",
            transcript: [
              {
                text: "Captured turn",
                start_time: "2026-07-15T18:00:00.000Z",
                end_time: "2026-07-15T18:00:01.000Z",
                speaker: {
                  source: "microphone",
                  diarization_label: "Speaker A",
                },
                provider_confidence: 0.91,
              },
            ],
            future_context: { source_kind: "provider-specific" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const note = await client.getNote("note-http-shape");

    expect(requestedUrl).toContain("/notes/note-http-shape?include=transcript");
    expect(note.transcript?.[0]).toMatchObject({
      speaker: { source: "microphone", diarization_label: "Speaker A" },
      provider_confidence: 0.91,
    });
    expect(note.provider_fields).toEqual({
      future_context: { source_kind: "provider-specific" },
    });
  });

  it("keeps an explicit null transcript distinct from an omitted transcript", async () => {
    const responses = [
      { id: "note-null", transcript: null },
      { id: "note-omitted" },
    ];
    const client = new HttpGranolaApiClient("grn_test_key", {
      fetchImpl: async () =>
        new Response(JSON.stringify(responses.shift()), { status: 200 }),
    });

    const nullTranscript = await client.getNote("note-null");
    const omittedTranscript = await client.getNote("note-omitted");

    expect(nullTranscript).toHaveProperty("transcript", null);
    expect(omittedTranscript).not.toHaveProperty("transcript");
  });
});
