import { describe, expect, it } from "vitest";
import { meetingSourceEnvelopeV1 } from "@echo-brain/organization-processing/core";
import { normalizeGranolaMeetingV1, type GranolaMeetingContentInputV1 } from "../src/granola-meeting-normalizer-v1.js";

const identity = { kind: "meeting-source" as const, adapter_id: "granola", instance_id: "primary", version: "2.2.0" };
function normalize(note: GranolaMeetingContentInputV1, observedAt = "2026-07-16T00:00:00.000Z") {
  return normalizeGranolaMeetingV1(note, identity, observedAt);
}

const detail: GranolaMeetingContentInputV1 = {
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

const liveCalendarShapeDetail: GranolaMeetingContentInputV1 = {
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
  transcript: ([
    ["Local audio, first turn.", { source: "microphone" }],
    ["Remote audio.", { source: "speaker" }],
    ["Local audio, second turn.", { source: "microphone" }],
    ["Diarized speaker A, first turn.", { source: "microphone", diarization_label: "Speaker A" }],
    ["Diarized speaker B.", { source: "microphone", diarization_label: "Speaker B" }],
    ["Diarized speaker A, second turn.", { source: "microphone", diarization_label: "Speaker A" }],
  ] as const).map(([text, speaker], index) => ({ text, start_time: `2026-07-15T18:00:0${index}.000Z`, speaker })),
} as unknown as GranolaMeetingContentInputV1;

describe("Retained Granola content normalization", () => {
  it("maps notes, participants, transcript turns, revision, and provenance", () => {
    const meeting = normalize(detail);
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

    const withoutFolder = normalize({ ...detail, folder_membership: [] });
    expect(withoutFolder.provenance.canonical_revision).not.toBe(
      meeting.provenance.canonical_revision,
    );
  });
  it.each([
    {
      name: "Markdown wins and the plain-text copy is not duplicated",
      summary: { summary_markdown: "## Decision\nShip the canonical bridge.", summary_text: "Decision\nShip the canonical bridge." },
      text: "## Decision\nShip the canonical bridge.",
      format: "markdown",
    },
    {
      name: "falls back to the plain-text summary when Granola sends no Markdown",
      summary: { summary_text: "Decision: ship the canonical bridge." },
      text: "Decision: ship the canonical bridge.",
      format: "text",
    },
  ])("stores one summary form: $name", ({ summary, text, format }) => {
    const meeting = normalize({
      id: "note-summary-form",
      object: "note",
      title: "Summary form",
      created_at: "2026-07-15T16:00:00.000Z",
      updated_at: "2026-07-15T17:00:00.000Z",
      ...summary,
      transcript: [{ text: "Transcript available." }],
    });

    expect(meeting.content[0]).toEqual({
      id: "note-summary-form:summary",
      kind: "summary",
      text,
      origin: "source_ai",
      metadata: { format },
    });
  });
  it("normalizes the incremental Granola calendar shape and links its people to transcript turns", () => {
    const meeting = normalize(liveCalendarShapeDetail);
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
  it("normalizes an ad-hoc note owner only when its calendar event is absent", () => {
    const adHocDetail: GranolaMeetingContentInputV1 = {
      ...detail,
      id: "note-ad-hoc-owner",
      calendar_event: null,
      owner: { email: "OWNER@example.com", name: "Owner" },
    };
    const malformedCalendarDetail: GranolaMeetingContentInputV1 = {
      ...adHocDetail,
      id: "note-malformed-calendar-owner",
      calendar_event: { organizer: { name: "Owner" } },
    };
    const adHoc = normalize(adHocDetail);
    const malformed = normalize(malformedCalendarDetail);
    expect(adHoc.context?.owner_participant_id).toBe("email:owner@example.com");
    expect(adHoc.participants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "email:owner@example.com",
          identities: [{ kind: "email", value: "owner@example.com" }],
        }),
      ]),
    );
    expect(malformed.context?.owner_participant_id).toBeUndefined();
    expect(malformed.participants).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "email:owner@example.com" })]),
    );
  });
  it("leaves audio channels unlinked and creates stable meeting-local diarization speakers", () => {
    const meeting = normalize(documentedSpeakerShapeDetail);
    const second = normalize(documentedSpeakerShapeDetail, "2026-07-16T01:00:00.000Z");
    const transcript = meeting.content.filter(
      (block) => block.kind === "transcript",
    );
    const speakerReferences = transcript.map(
      (block) => block.speaker_participant_id,
    );
    expect(speakerReferences).toEqual([
      undefined,
      undefined,
      undefined,
      expect.any(String),
      expect.any(String),
      speakerReferences[3],
    ]);
    expect(speakerReferences[3]).not.toBe(speakerReferences[4]);
    expect(
      second.content
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
  it("keeps revision identity and bridge digests stable across observation and JSON key order", () => {
    const reordered: GranolaMeetingContentInputV1 = {
      ...detail,
      owner: { email: "owner@example.com", name: "Owner" },
      provider_fields: { b: { y: 2, x: 1 }, a: true },
    };
    const original = { ...detail, provider_fields: { a: true, b: { x: 1, y: 2 } } };
    const first = normalize(original, "2026-07-16T00:00:00.000Z");
    const later = normalize(reordered, "2026-07-17T00:00:00.000Z");
    expect(later.id).toBe(first.id);
    expect(later.provenance.canonical_revision).toBe(first.provenance.canonical_revision);
    const firstEnvelope = meetingSourceEnvelopeV1(first);
    const laterEnvelope = meetingSourceEnvelopeV1(later);
    expect(laterEnvelope.revision.content_sha256).toBe(firstEnvelope.revision.content_sha256);
    expect(laterEnvelope.revision.captured_at).not.toBe(firstEnvelope.revision.captured_at);

    for (const changed of [
      { ...original, summary_markdown: "An edited summary." },
      { ...original, transcript: [{ text: "An edited transcript.", speaker: { source: "microphone" } }] },
      { ...original, provider_fields: { a: true, b: { x: 1, y: 3 } } },
    ]) {
      const revision = normalize(changed, "2026-07-17T00:00:00.000Z");
      expect(revision.id).toBe(first.id);
      expect(revision.provenance.canonical_revision).not.toBe(first.provenance.canonical_revision);
      expect(meetingSourceEnvelopeV1(revision).revision.content_sha256).not.toBe(firstEnvelope.revision.content_sha256);
    }
  });
});
