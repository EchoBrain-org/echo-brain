import { createHash } from "node:crypto";
import { isCanonicalPersonEmail } from "@echo-brain/organization-authority-kernel/shared/person-email-rules";
import type {
  JsonObject, JsonValue, MeetingContentBlock, MeetingContext,
  MeetingDocument, MeetingParticipant,
} from "@echo-brain/organization-processing/core";

/** Content mapping version retained so existing semantic revisions stay stable. */
export const GRANOLA_MEETING_NORMALIZER_VERSION_V1 = "2.3.0";

/**
 * Transport-independent input for the retained content transforms. This is not
 * the Granola MCP wire contract; connectors must validate and map their own
 * responses before normalizing. No credentials, discovery, or owner admission
 * are performed here.
 */
export interface GranolaNoteMetadataV1 {
  id: string;
  object?: string;
  title?: string | null;
  owner?: unknown;
  created_at?: string;
  updated_at?: string;
  /** Provider fields not yet promoted into the typed Granola contract. */
  provider_fields?: Record<string, unknown>;
}

export interface GranolaTranscriptSpeaker {
  id?: unknown;
  name?: unknown;
  display_name?: unknown;
  email?: unknown;
  source?: unknown;
  diarization_label?: unknown;
  [key: string]: unknown;
}

export interface GranolaTranscriptItem {
  text?: string;
  start_time?: number | string | null;
  end_time?: number | string | null;
  start?: number | string | null;
  end?: number | string | null;
  speaker?: string | GranolaTranscriptSpeaker | null;
  [key: string]: unknown;
}

export interface GranolaMeetingContentInputV1 extends GranolaNoteMetadataV1 {
  summary_markdown?: string | null;
  summary_text?: string | null;
  /** The person's own notes; kept apart from Granola's AI summary. */
  private_notes_markdown?: string | null;
  /** Actual start, ISO with offset; used only when no calendar time exists. */
  started_at?: string | null;
  /** IANA zone of `started_at`. */
  timezone?: string | null;
  transcript?: GranolaTranscriptItem[] | null;
  attendees?: unknown;
  /**
   * `{ name?, email? }` people Granola reports for the meeting. They prove
   * neither identity nor attendance, so they become participants with no role.
   */
  reported_participants?: unknown;
  calendar_event?: unknown;
  folder_membership?: unknown;
  web_url?: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizedIso(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const numeric = typeof value === "number" ? value : Number(value);
  const timestamp =
    typeof value === "number" ||
    (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value))
      ? numeric > 10_000_000_000
        ? numeric
        : numeric * 1_000
      : value;
  const millis = new Date(timestamp).getTime();
  return Number.isNaN(millis) ? null : new Date(millis).toISOString();
}

function sanitizeJson(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    return value
      .map(sanitizeJson)
      .filter((item): item is JsonValue => item !== undefined);
  }
  if (!isPlainObject(value)) return undefined;
  const result: { [key: string]: JsonValue } = {};
  for (const key of Object.keys(value).sort()) {
    const item = sanitizeJson(value[key]);
    if (item !== undefined) result[key] = item;
  }
  return result;
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`)
    .join(",")}}`;
}

function sourceRevision(note: GranolaMeetingContentInputV1): string {
  const normalized = sanitizeJson({
    mapping_version: GRANOLA_MEETING_NORMALIZER_VERSION_V1,
    id: note.id,
    object: note.object,
    title: note.title,
    owner: note.owner,
    created_at: note.created_at,
    updated_at: note.updated_at,
    summary_markdown: note.summary_markdown,
    summary_text: note.summary_text,
    private_notes_markdown: note.private_notes_markdown,
    started_at: note.started_at,
    timezone: note.timezone,
    transcript: note.transcript,
    attendees: note.attendees,
    reported_participants: note.reported_participants,
    calendar_event: note.calendar_event,
    folder_membership: note.folder_membership,
    provider_fields: note.provider_fields,
    web_url: note.web_url,
  });
  const digest = createHash("sha256")
    .update(stableJson(normalized ?? null))
    .digest("hex");
  return `sha256:${digest}`;
}

function valueAtPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function firstTimestamp(
  value: unknown,
  paths: readonly (readonly string[])[],
): string | undefined {
  for (const path of paths) {
    const candidate = normalizedIso(valueAtPath(value, path));
    if (candidate !== null) return candidate;
  }
  return undefined;
}

function meetingTime(note: GranolaMeetingContentInputV1): MeetingDocument["time"] {
  const scheduledStart = firstTimestamp(note.calendar_event, [
    ["scheduled_start_time"],
    ["start"],
    ["start_time"],
    ["start_at"],
    ["starts_at"],
    ["start", "dateTime"],
    ["start", "date"],
  ]);
  const scheduledEnd = firstTimestamp(note.calendar_event, [
    ["scheduled_end_time"],
    ["end"],
    ["end_time"],
    ["end_at"],
    ["ends_at"],
    ["end", "dateTime"],
    ["end", "date"],
  ]);
  const timezone = [
    valueAtPath(note.calendar_event, ["start", "timeZone"]),
    valueAtPath(note.calendar_event, ["timezone"]),
    valueAtPath(note.calendar_event, ["time_zone"]),
  ].find(isNonEmptyString);
  const allDay =
    isNonEmptyString(valueAtPath(note.calendar_event, ["start", "date"])) &&
    !isNonEmptyString(valueAtPath(note.calendar_event, ["start", "dateTime"]));
  const time = {
    ...(scheduledStart === undefined
      ? {}
      : { scheduled_start_at: scheduledStart }),
    ...(scheduledEnd === undefined ? {} : { scheduled_end_at: scheduledEnd }),
    ...(timezone === undefined ? {} : { timezone: timezone.trim() }),
    ...(allDay ? { all_day: true } : {}),
  };
  if (Object.keys(time).length > 0) return time;
  // Without calendar times, fall back to the note's own reported start.
  const startedAt = normalizedIso(note.started_at);
  return startedAt === null
    ? undefined
    : {
        actual_start_at: startedAt,
        ...(isNonEmptyString(note.timezone) ? { timezone: note.timezone.trim() } : {}),
      };
}

function nameParticipantId(displayName: string): string {
  return `name:sha256:${createHash("sha256").update(displayName.toLowerCase()).digest("hex")}`;
}

function participantFrom(value: unknown): MeetingParticipant | null {
  if (isNonEmptyString(value)) {
    const email = value.includes("@") ? value.trim().toLowerCase() : null;
    const displayName = value.trim();
    return {
      id: email === null ? nameParticipantId(displayName) : `email:${email}`,
      display_name: displayName,
      ...(email === null
        ? {}
        : { identities: [{ kind: "email" as const, value: email }] }),
    };
  }
  if (!isPlainObject(value)) return null;
  const rawEmail = value["email"];
  const email = isNonEmptyString(rawEmail)
    ? rawEmail.trim().toLowerCase()
    : null;
  const rawName = value["display_name"] ?? value["name"];
  const displayName = isNonEmptyString(rawName) ? rawName.trim() : email;
  const rawId = value["id"];
  const sourceId = isNonEmptyString(rawId) ? rawId.trim() : null;
  if (displayName === null && sourceId === null) return null;
  const identities = [
    ...(sourceId === null
      ? []
      : [{ kind: "source" as const, value: sourceId }]),
    ...(email === null ? [] : [{ kind: "email" as const, value: email }]),
  ];
  return {
    id:
      sourceId !== null
        ? `source:${sourceId}`
        : email !== null
          ? `email:${email}`
          : nameParticipantId(displayName!),
    ...(displayName === null ? {} : { display_name: displayName }),
    ...(identities.length === 0 ? {} : { identities }),
  };
}

type GranolaSpeakerResolutionMode =
  "named_identity" | "diarization_bucket" | "audio_channel" | "unresolved";

interface GranolaSpeakerResolution {
  participant: MeetingParticipant | null;
  mode: GranolaSpeakerResolutionMode;
}

function meetingScopedParticipantId(
  noteId: string,
  kind: "diarization",
  values: readonly string[],
): string {
  const digest = createHash("sha256")
    .update(
      [noteId, kind, ...values.map((value) => value.toLowerCase())].join(
        "\u0000",
      ),
    )
    .digest("hex");
  return `granola:${kind}:sha256:${digest}`;
}

function granolaSpeaker(
  noteId: string,
  value: unknown,
): GranolaSpeakerResolution {
  const namedParticipant = participantFrom(value);
  if (namedParticipant !== null) {
    return { participant: namedParticipant, mode: "named_identity" };
  }
  if (!isPlainObject(value)) {
    return { participant: null, mode: "unresolved" };
  }

  const source = isNonEmptyString(value["source"])
    ? value["source"].trim()
    : null;
  const rawLabel = value["diarization_label"] ?? value["diarizationLabel"];
  const label = isNonEmptyString(rawLabel) ? rawLabel.trim() : null;
  if (label !== null) {
    return {
      participant: {
        id: meetingScopedParticipantId(noteId, "diarization", [
          source ?? "",
          label,
        ]),
        display_name: label,
        metadata: {
          granola: {
            speaker_resolution: "diarization_bucket",
            ...(source === null ? {} : { source }),
            diarization_label: label,
          },
        },
      },
      mode: "diarization_bucket",
    };
  }
  if (source !== null) {
    // Granola's desktop API reports input channels (microphone or remote
    // speaker audio), not person identities. Preserve the source on the
    // content block without fabricating a participant link.
    return { participant: null, mode: "audio_channel" };
  }
  return { participant: null, mode: "unresolved" };
}

function participantIdentityKeys(participant: MeetingParticipant): string[] {
  return [
    participant.id,
    ...(participant.identities ?? []).map(
      (identity) => `${identity.kind}:${identity.value}`,
    ),
  ];
}

function mergeParticipant(
  existing: MeetingParticipant,
  incoming: MeetingParticipant,
  role?: NonNullable<MeetingParticipant["roles"]>[number],
): MeetingParticipant {
  const identities = [...(existing.identities ?? [])];
  const identityKeys = new Set(
    identities.map((identity) => `${identity.kind}:${identity.value}`),
  );
  for (const identity of incoming.identities ?? []) {
    const key = `${identity.kind}:${identity.value}`;
    if (!identityKeys.has(key)) identities.push(identity);
  }
  return {
    ...existing,
    ...(existing.display_name === undefined &&
    incoming.display_name !== undefined
      ? { display_name: incoming.display_name }
      : {}),
    ...(identities.length === 0 ? {} : { identities }),
    ...(
      role === undefined && existing.roles === undefined && incoming.roles === undefined
        ? {}
        : {
            roles: [
              ...new Set([
                ...(existing.roles ?? []),
                ...(incoming.roles ?? []),
                ...(role === undefined ? [] : [role]),
              ]),
            ],
          }
    ),
  };
}

function noteParticipants(note: GranolaMeetingContentInputV1): MeetingParticipant[] {
  const candidates: Array<{
    participant: MeetingParticipant;
    role?: NonNullable<MeetingParticipant["roles"]>[number];
  }> = [];

  const addCandidate = (
    value: unknown,
    role?: NonNullable<MeetingParticipant["roles"]>[number],
  ): void => {
    const participant = participantFrom(value);
    if (participant !== null) candidates.push({ participant, role });
  };

  if (Array.isArray(note.attendees)) {
    for (const attendee of note.attendees) addCandidate(attendee, "attendee");
  }
  if (Array.isArray(note.reported_participants)) {
    for (const person of note.reported_participants) addCandidate(person);
  }
  if (isPlainObject(note.calendar_event)) {
    for (const field of ["attendees", "invitees"] as const) {
      const invitees = note.calendar_event[field];
      if (Array.isArray(invitees)) {
        for (const invitee of invitees) addCandidate(invitee, "invitee");
      }
    }
    addCandidate(
      note.calendar_event["organizer"] ?? note.calendar_event["organiser"],
      "organizer",
    );
  } else if (note.calendar_event === undefined || note.calendar_event === null) {
    // Only calendar-less notes may use the note owner. A present malformed
    // calendar organizer is weaker evidence than an explicit absence, so it
    // must not be silently replaced with the raw note owner.
    addCandidate(note.owner);
  }
  for (const item of note.transcript ?? []) {
    if (!isNonEmptyString(item.text)) continue;
    const resolution = granolaSpeaker(note.id, item.speaker);
    if (resolution.participant !== null) {
      candidates.push({ participant: resolution.participant, role: "speaker" });
    }
  }

  const participants: MeetingParticipant[] = [];
  for (const candidate of candidates) {
    const participant = candidate.participant;
    const keys = new Set(participantIdentityKeys(participant));
    const name = participant.display_name?.toLowerCase();
    const existingIndex = participants.findIndex(
      (existing) =>
        participantIdentityKeys(existing).some((key) => keys.has(key)) ||
        (name !== undefined && existing.display_name?.toLowerCase() === name),
    );
    if (existingIndex >= 0) {
      participants[existingIndex] = mergeParticipant(
        participants[existingIndex]!,
        participant,
        candidate.role,
      );
      continue;
    }
    participants.push({
      ...participant,
      ...(candidate.role === undefined ? {} : { roles: [candidate.role] }),
    });
  }
  return participants;
}

function canonicalParticipant(
  candidate: MeetingParticipant | null,
  participants: readonly MeetingParticipant[],
): MeetingParticipant | null {
  if (candidate === null) return null;
  const identities = new Set(participantIdentityKeys(candidate));
  return (
    participants.find((participant) =>
      participantIdentityKeys(participant).some((identity) =>
        identities.has(identity),
      ),
    ) ??
    participants.find(
      (participant) =>
        participant.display_name !== undefined &&
        candidate.display_name !== undefined &&
        participant.display_name.toLowerCase() ===
          candidate.display_name.toLowerCase(),
    ) ??
    candidate
  );
}

function participantWithCanonicalEmail(
  candidate: MeetingParticipant | null,
  participants: readonly MeetingParticipant[],
): MeetingParticipant | null {
  const participant = canonicalParticipant(candidate, participants);
  if (participant === null) return null;
  const canonicalEmails = (participant.identities ?? []).filter(
    (identity) =>
      identity.kind === "email" && isCanonicalPersonEmail(identity.value),
  );
  return canonicalEmails.length === 1 ? participant : null;
}

function transcriptTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || /^\d+(?:\.\d+)?$/.test(value))
    return undefined;
  return normalizedIso(value) ?? undefined;
}

function transcriptOffsetMs(value: unknown): number | undefined {
  const seconds =
    typeof value === "number" && Number.isFinite(value)
      ? value
      : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)
        ? Number(value)
        : undefined;
  if (seconds === undefined || seconds < 0) return undefined;
  const milliseconds = Math.round(seconds * 1_000);
  if (!Number.isSafeInteger(milliseconds)) return undefined;
  return milliseconds;
}

function stringAt(
  value: unknown,
  paths: readonly (readonly string[])[],
): string | undefined {
  for (const path of paths) {
    const candidate = valueAtPath(value, path);
    if (isNonEmptyString(candidate)) return candidate.trim();
  }
  return undefined;
}

function transcriptProviderFields(
  turn: GranolaTranscriptItem,
): JsonObject | undefined {
  const normalizedFields = new Set([
    "text",
    "start_time",
    "end_time",
    "start",
    "end",
    "speaker",
  ]);
  const fields: JsonObject = {};
  for (const [key, value] of Object.entries(turn).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (normalizedFields.has(key)) continue;
    const sanitized = sanitizeJson(value);
    if (sanitized !== undefined) fields[key] = sanitized;
  }
  return Object.keys(fields).length === 0 ? undefined : fields;
}

function transcriptMetadata(
  turn: GranolaTranscriptItem,
  index: number,
  resolution: GranolaSpeakerResolutionMode,
): JsonObject {
  const granola: JsonObject = { speaker_resolution: resolution };
  const rawSpeaker = sanitizeJson(turn.speaker);
  if (rawSpeaker !== undefined) granola["speaker"] = rawSpeaker;
  const providerFields = transcriptProviderFields(turn);
  if (providerFields !== undefined) granola["provider_fields"] = providerFields;
  return { source_index: index, granola };
}

function transcriptBlock(
  noteId: string,
  turn: GranolaTranscriptItem,
  index: number,
  participants: readonly MeetingParticipant[],
): MeetingContentBlock | null {
  if (!isNonEmptyString(turn.text)) return null;
  const start = turn.start_time ?? turn.start;
  const end = turn.end_time ?? turn.end;
  const startOffset = transcriptOffsetMs(start);
  const endOffset = transcriptOffsetMs(end);
  const speakerResolution = granolaSpeaker(noteId, turn.speaker);
  const speaker = canonicalParticipant(
    speakerResolution.participant,
    participants,
  );
  const startedAt = transcriptTimestamp(start);
  const endedAt = transcriptTimestamp(end);
  return {
    id: `${noteId}:transcript:${index}`,
    kind: "transcript",
    text: turn.text.trim(),
    ...(speaker === null ? {} : { speaker_participant_id: speaker.id }),
    sequence: index,
    ...(startedAt === undefined ? {} : { started_at: startedAt }),
    ...(endedAt === undefined ? {} : { ended_at: endedAt }),
    ...(startOffset === undefined ? {} : { start_offset_ms: startOffset }),
    ...(endOffset === undefined ? {} : { end_offset_ms: endOffset }),
    origin: "imported",
    metadata: transcriptMetadata(turn, index, speakerResolution.mode),
  };
}

function noteContent(
  note: GranolaMeetingContentInputV1,
  participants: readonly MeetingParticipant[],
): MeetingContentBlock[] {
  const blocks: MeetingContentBlock[] = [];
  if (isNonEmptyString(note.private_notes_markdown)) {
    blocks.push({
      id: `${note.id}:notes`,
      kind: "note",
      text: note.private_notes_markdown.trim(),
      origin: "human",
      metadata: { format: "markdown" },
    });
  }
  const markdownSummary = isNonEmptyString(note.summary_markdown)
    ? note.summary_markdown
    : null;
  const summary = markdownSummary ?? note.summary_text;
  if (isNonEmptyString(summary)) {
    blocks.push({
      id: `${note.id}:summary`,
      kind: "summary",
      text: summary.trim(),
      origin: "source_ai",
      metadata: {
        format: markdownSummary === null ? "text" : "markdown",
      },
    });
  }
  for (const [index, turn] of (note.transcript ?? []).entries()) {
    const block = transcriptBlock(note.id, turn, index, participants);
    if (block !== null) blocks.push(block);
  }
  return blocks;
}

function sourceExtensions(note: GranolaMeetingContentInputV1): JsonObject | undefined {
  const granola = sanitizeJson({
    object: note.object,
    owner: note.owner,
    attendees: note.attendees,
    calendar_event: note.calendar_event,
    folder_membership: note.folder_membership,
    provider_fields: note.provider_fields,
  });
  return isPlainObject(granola) && Object.keys(granola).length > 0
    ? { granola: granola as JsonObject }
    : undefined;
}

function meetingContext(
  note: GranolaMeetingContentInputV1,
  participants: readonly MeetingParticipant[],
): MeetingContext | undefined {
  const eventId = stringAt(note.calendar_event, [
    ["calendar_event_id"],
    ["id"],
    ["event_id"],
    ["eventId"],
  ]);
  const seriesId = stringAt(note.calendar_event, [
    ["series_id"],
    ["seriesId"],
    ["recurringEventId"],
  ]);
  const recurrenceId = stringAt(note.calendar_event, [
    ["recurrence_id"],
    ["recurrenceId"],
  ]);
  const organizerValue =
    valueAtPath(note.calendar_event, ["organizer"]) ??
    valueAtPath(note.calendar_event, ["organiser"]);
  const organizer = canonicalParticipant(
    participantFrom(organizerValue),
    participants,
  );
  const calendarAbsent =
    note.calendar_event === undefined || note.calendar_event === null;
  const owner = participantWithCanonicalEmail(
    calendarAbsent ? participantFrom(note.owner) : participantFrom(organizerValue),
    participants,
  );
  const locationName = stringAt(note.calendar_event, [
    ["location"],
    ["location", "name"],
  ]);
  const joinReference = stringAt(note.calendar_event, [
    ["hangoutLink"],
    ["conference_url"],
    ["join_url"],
  ]);
  const calendar = {
    ...(eventId === undefined ? {} : { event_id: eventId }),
    ...(seriesId === undefined ? {} : { series_id: seriesId }),
    ...(recurrenceId === undefined ? {} : { recurrence_id: recurrenceId }),
    ...(organizer === null ? {} : { organizer_participant_id: organizer.id }),
  };
  const location = {
    ...(joinReference === undefined ? {} : { kind: "virtual" as const }),
    ...(locationName === undefined ? {} : { name: locationName }),
    ...(joinReference === undefined ? {} : { join_reference: joinReference }),
  };
  const context = {
    ...(owner === null ? {} : { owner_participant_id: owner.id }),
    ...(Object.keys(calendar).length === 0 ? {} : { calendar }),
    ...(Object.keys(location).length === 0 ? {} : { location }),
  };
  return Object.keys(context).length === 0 ? undefined : context;
}

function captureState(
  note: GranolaMeetingContentInputV1,
  participants: readonly MeetingParticipant[],
  content: readonly MeetingContentBlock[],
): MeetingDocument["capture"] {
  const summaryAvailable = content.some((block) => block.kind === "summary");
  const transcriptAvailable = content.some(
    (block) => block.kind === "transcript",
  );
  const summaryState =
    note.summary_markdown === undefined && note.summary_text === undefined
      ? "not_provided"
      : summaryAvailable
        ? "available"
        : "empty";
  const transcriptState =
    note.transcript === undefined
      ? "not_provided"
      : transcriptAvailable
        ? "available"
        : "empty";
  const notesState =
    note.private_notes_markdown === undefined
      ? "not_provided"
      : content.some((block) => block.kind === "note")
        ? "available"
        : "empty";
  const speakerModes = new Set(
    (note.transcript ?? [])
      .filter((turn) => isNonEmptyString(turn.text))
      .map((turn) => granolaSpeaker(note.id, turn.speaker).mode),
  );
  const warnings = [
    ...(speakerModes.has("audio_channel")
      ? [
          "Granola supplied audio-channel speaker metadata without person-level attribution.",
        ]
      : []),
    ...(speakerModes.has("diarization_bucket")
      ? ["Granola diarization labels are anonymous and meeting-local."]
      : []),
    ...(speakerModes.has("unresolved")
      ? [
          "Some Granola transcript turns did not include usable speaker metadata.",
        ]
      : []),
  ];
  return {
    state:
      summaryState === "available" && transcriptState === "available"
        ? "complete"
        : "partial",
    components: [
      { kind: "metadata", state: "available" },
      {
        kind: "participants",
        state: participants.length === 0 ? "empty" : "available",
      },
      {
        kind: "summary",
        state: summaryState,
      },
      {
        kind: "transcript",
        state: transcriptState,
      },
      { kind: "agenda", state: "not_provided" },
      { kind: "notes", state: notesState },
      { kind: "chat", state: "not_provided" },
      { kind: "recording", state: "not_provided" },
      { kind: "attachments", state: "not_provided" },
      { kind: "artifacts", state: "empty" },
    ],
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}

/** Normalize validated content without acquiring or admitting a source. */
export function normalizeGranolaMeetingV1(
  note: GranolaMeetingContentInputV1,
  source: MeetingDocument["provenance"]["source"],
  observedAt: string,
): MeetingDocument {
  const participants = noteParticipants(note);
  const content = noteContent(note, participants);
  const time = meetingTime(note);
  const context = meetingContext(note, participants);
  const extensions = sourceExtensions(note);
  const sourceCreatedAt = normalizedIso(note.created_at) ?? undefined;
  const sourceUpdatedAt = normalizedIso(note.updated_at) ?? undefined;
  return {
    schema_version: 1,
    id: `granola:${source.instance_id}:${note.id}`,
    ...(isNonEmptyString(note.title) ? { title: note.title.trim() } : {}),
    ...(time === undefined ? {} : { time }),
    participants,
    content,
    artifacts: [],
    capture: captureState(note, participants, content),
    provenance: {
      source: source,
      external_id: note.id,
      canonical_revision: sourceRevision(note),
      observed_at: observedAt,
      normalizer_version: GRANOLA_MEETING_NORMALIZER_VERSION_V1,
      ...(sourceCreatedAt === undefined
        ? {}
        : { source_created_at: sourceCreatedAt }),
      ...(sourceUpdatedAt === undefined
        ? {}
        : { source_updated_at: sourceUpdatedAt }),
      ...(isNonEmptyString(note.web_url) ? { source_url: note.web_url } : {}),
    },
    ...(context === undefined ? {} : { context }),
    ...(extensions === undefined ? {} : { extensions }),
  };
}
