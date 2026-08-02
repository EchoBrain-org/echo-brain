import { createHash } from "node:crypto";
import type {
  AdapterConfig,
  AdapterConfigValidation,
  AdapterHealth,
  AdapterOperationContext,
  JsonObject,
  JsonValue,
  MeetingBatch,
  MeetingContentBlock,
  MeetingContext,
  MeetingDocument,
  MeetingParticipant,
  MeetingPullRequest,
  MeetingSourceAdapter,
} from "../../../core/index.js";
import { AdapterError } from "../../../core/index.js";
import {
  DEFAULT_GRANOLA_PAGE_SIZE,
  DEFAULT_GRANOLA_REQUEST_TIMEOUT_MS,
  GRANOLA_API_KEY_RE,
  GranolaApiError,
  HttpGranolaApiClient,
  type GranolaApiClient,
  type GranolaListNote,
  type GranolaNoteDetail,
  type GranolaTranscriptItem,
} from "./granola-api-client.js";

export const GRANOLA_MEETING_SOURCE_ADAPTER_ID = "granola";
export const GRANOLA_MEETING_SOURCE_ADAPTER_VERSION = "2.2.0";
export const DEFAULT_GRANOLA_CURSOR_OVERLAP_MS = 1_000;

const GRANOLA_CURSOR_PREFIX = "granola:v1:";
const MAX_REQUEST_TIMEOUT_MS = 120_000;
const MAX_CURSOR_OVERLAP_MS = 3_600_000;

export type GranolaCredentialResolver = (
  reference: string,
) => string | undefined | Promise<string | undefined>;

export interface GranolaMeetingSourceAdapterOptions {
  client?: GranolaApiClient;
  credentialResolver?: GranolaCredentialResolver;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
}

interface GranolaMeetingSourceSettings {
  baseUrl?: string;
  requestTimeoutMs: number;
  pageSize: number;
  cursorOverlapMs: number;
  ownerEmail?: string;
}

interface GranolaCursorState {
  schema_version: 1;
  watermark: string | null;
  page_cursor: string | null;
  page_high_watermark: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveInteger(value: unknown, maximum: number): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) > 0 &&
    (value as number) <= maximum
  );
}

function nonNegativeInteger(value: unknown, maximum: number): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= maximum
  );
}

function normalizedEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 254 || /\s/.test(normalized))
    return null;
  const [local, domain, extra] = normalized.split("@");
  return local !== undefined &&
    local.length > 0 &&
    domain !== undefined &&
    domain.length > 0 &&
    extra === undefined
    ? normalized
    : null;
}

function isCanonicalLowercaseEmail(value: unknown): value is string {
  return typeof value === "string" && normalizedEmail(value) === value;
}

function listOwnerEmail(owner: unknown): string | null {
  if (!isPlainObject(owner)) return null;
  return normalizedEmail(owner["email"]);
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

function maxIso(...values: Array<string | null | undefined>): string | null {
  let maximum: string | null = null;
  for (const value of values) {
    const normalized = normalizedIso(value);
    if (normalized !== null && (maximum === null || normalized > maximum))
      maximum = normalized;
  }
  return maximum;
}

function subtractMillis(timestamp: string, millis: number): string {
  return new Date(new Date(timestamp).getTime() - millis).toISOString();
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

function sourceRevision(note: GranolaNoteDetail): string {
  const normalized = sanitizeJson({
    mapping_version: GRANOLA_MEETING_SOURCE_ADAPTER_VERSION,
    id: note.id,
    object: note.object,
    title: note.title,
    owner: note.owner,
    created_at: note.created_at,
    updated_at: note.updated_at,
    summary_markdown: note.summary_markdown,
    summary_text: note.summary_text,
    transcript: note.transcript,
    attendees: note.attendees,
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

function encodeCursor(state: GranolaCursorState): string {
  return `${GRANOLA_CURSOR_PREFIX}${Buffer.from(JSON.stringify(state)).toString("base64url")}`;
}

function validCursorTimestamp(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && normalizedIso(value) === value)
  );
}

function decodeCursor(cursor: string | undefined): GranolaCursorState {
  if (cursor === undefined) {
    return {
      schema_version: 1,
      watermark: null,
      page_cursor: null,
      page_high_watermark: null,
    };
  }

  // The old Granola checkpoint stored the high-water mark as an ISO string.
  // Accept it as a one-way migration path; all emitted cursors use v1 below.
  const legacyWatermark = normalizedIso(cursor);
  if (legacyWatermark === cursor) {
    return {
      schema_version: 1,
      watermark: legacyWatermark,
      page_cursor: null,
      page_high_watermark: null,
    };
  }

  if (!cursor.startsWith(GRANOLA_CURSOR_PREFIX)) {
    throw new AdapterError(
      "invalid_config",
      "meeting-source cursor is invalid",
      false,
    );
  }
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(
        cursor.slice(GRANOLA_CURSOR_PREFIX.length),
        "base64url",
      ).toString("utf8"),
    );
    if (
      !isPlainObject(parsed) ||
      parsed["schema_version"] !== 1 ||
      !validCursorTimestamp(parsed["watermark"]) ||
      !validCursorTimestamp(parsed["page_high_watermark"]) ||
      (parsed["page_cursor"] !== null &&
        !isNonEmptyString(parsed["page_cursor"]))
    ) {
      throw new Error("invalid cursor shape");
    }
    return {
      schema_version: 1,
      watermark: parsed["watermark"],
      page_cursor: parsed["page_cursor"],
      page_high_watermark: parsed["page_high_watermark"],
    };
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw new AdapterError(
      "invalid_config",
      "meeting-source cursor is invalid",
      false,
    );
  }
}

function adapterError(error: unknown): AdapterError {
  if (error instanceof AdapterError) return error;
  if (error instanceof GranolaApiError) {
    switch (error.reason) {
      case "auth_failed":
        return new AdapterError(
          "unauthorized",
          "Granola authentication failed",
          false,
        );
      case "rate_limited":
        return new AdapterError(
          "rate_limited",
          "Granola rate limit exceeded",
          true,
        );
      case "timeout":
        return new AdapterError("timeout", "Granola request timed out", true);
      case "pagination_failed":
      case "api_failed":
        return new AdapterError(
          "temporarily_unavailable",
          "Granola API is temporarily unavailable",
          true,
        );
    }
  }
  return new AdapterError(
    "temporarily_unavailable",
    "Granola meeting source is temporarily unavailable",
    true,
  );
}

function defaultCredentialResolver(
  env: NodeJS.ProcessEnv,
): GranolaCredentialResolver {
  return (reference) => {
    const variable = reference.startsWith("env:")
      ? reference.slice("env:".length)
      : reference;
    return isNonEmptyString(variable) ? env[variable] : undefined;
  };
}

function settingsFrom(config: AdapterConfig): GranolaMeetingSourceSettings {
  const settings = config.settings;
  return {
    baseUrl:
      typeof settings["base_url"] === "string"
        ? settings["base_url"]
        : undefined,
    requestTimeoutMs:
      typeof settings["request_timeout_ms"] === "number"
        ? settings["request_timeout_ms"]
        : DEFAULT_GRANOLA_REQUEST_TIMEOUT_MS,
    pageSize:
      typeof settings["page_size"] === "number"
        ? settings["page_size"]
        : DEFAULT_GRANOLA_PAGE_SIZE,
    cursorOverlapMs:
      typeof settings["cursor_overlap_ms"] === "number"
        ? settings["cursor_overlap_ms"]
        : DEFAULT_GRANOLA_CURSOR_OVERLAP_MS,
    ownerEmail:
      typeof settings["owner_email"] === "string"
        ? settings["owner_email"]
        : undefined,
  };
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

function meetingTime(note: GranolaNoteDetail): MeetingDocument["time"] {
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
  return Object.keys(time).length === 0 ? undefined : time;
}

function participantFrom(value: unknown): MeetingParticipant | null {
  if (isNonEmptyString(value)) {
    const email = value.includes("@") ? value.trim().toLowerCase() : null;
    const displayName = value.trim();
    return {
      id:
        email === null
          ? `name:sha256:${createHash("sha256").update(displayName.toLowerCase()).digest("hex")}`
          : `email:${email}`,
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
          : `name:sha256:${createHash("sha256")
              .update(displayName!.toLowerCase())
              .digest("hex")}`,
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
  role: NonNullable<MeetingParticipant["roles"]>[number],
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
    roles: [
      ...new Set([...(existing.roles ?? []), ...(incoming.roles ?? []), role]),
    ],
  };
}

function noteParticipants(note: GranolaNoteDetail): MeetingParticipant[] {
  const candidates: Array<{
    participant: MeetingParticipant;
    role: NonNullable<MeetingParticipant["roles"]>[number];
  }> = [];

  const addCandidate = (
    value: unknown,
    role: NonNullable<MeetingParticipant["roles"]>[number],
  ): void => {
    const participant = participantFrom(value);
    if (participant !== null) candidates.push({ participant, role });
  };

  if (Array.isArray(note.attendees)) {
    for (const attendee of note.attendees) addCandidate(attendee, "attendee");
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
    participants.push({ ...participant, roles: [candidate.role] });
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
  note: GranolaNoteDetail,
  participants: readonly MeetingParticipant[],
): MeetingContentBlock[] {
  const blocks: MeetingContentBlock[] = [];
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

function sourceExtensions(note: GranolaNoteDetail): JsonObject | undefined {
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
  note: GranolaNoteDetail,
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
    ...(Object.keys(calendar).length === 0 ? {} : { calendar }),
    ...(Object.keys(location).length === 0 ? {} : { location }),
  };
  return Object.keys(context).length === 0 ? undefined : context;
}

function captureState(
  note: GranolaNoteDetail,
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
      { kind: "notes", state: "not_provided" },
      { kind: "chat", state: "not_provided" },
      { kind: "recording", state: "not_provided" },
      { kind: "attachments", state: "not_provided" },
      { kind: "artifacts", state: "empty" },
    ],
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}

function mergeNote(
  listNote: GranolaListNote,
  detail: GranolaNoteDetail,
): GranolaNoteDetail {
  if (detail.id !== listNote.id) {
    throw new AdapterError(
      "temporarily_unavailable",
      "Granola returned a mismatched meeting identifier",
      true,
    );
  }
  const providerFields = {
    ...(listNote.provider_fields ?? {}),
    ...(detail.provider_fields ?? {}),
  };
  return {
    ...listNote,
    ...detail,
    id: listNote.id,
    title: detail.title ?? listNote.title,
    owner: detail.owner ?? listNote.owner,
    created_at: detail.created_at ?? listNote.created_at,
    updated_at: detail.updated_at ?? listNote.updated_at,
    ...(Object.keys(providerFields).length === 0
      ? {}
      : { provider_fields: providerFields }),
  };
}

export class GranolaMeetingSourceAdapter implements MeetingSourceAdapter {
  readonly identity: MeetingSourceAdapter["identity"];
  private readonly settings: GranolaMeetingSourceSettings;
  private readonly now: () => string;
  private readonly credentialResolver: GranolaCredentialResolver;
  private client: GranolaApiClient | undefined;

  constructor(
    private readonly config: AdapterConfig,
    options: GranolaMeetingSourceAdapterOptions = {},
  ) {
    this.identity = Object.freeze({
      kind: "meeting-source" as const,
      adapter_id: GRANOLA_MEETING_SOURCE_ADAPTER_ID,
      instance_id: config.instance_id,
      version: GRANOLA_MEETING_SOURCE_ADAPTER_VERSION,
    });
    this.settings = settingsFrom(config);
    this.now = options.now ?? (() => new Date().toISOString());
    this.credentialResolver =
      options.credentialResolver ??
      defaultCredentialResolver(options.env ?? process.env);
    this.client = options.client;
  }

  validateConfig(config: AdapterConfig): AdapterConfigValidation {
    const errors: string[] = [];
    if (config.adapter_id !== GRANOLA_MEETING_SOURCE_ADAPTER_ID) {
      errors.push(`adapter_id must be '${GRANOLA_MEETING_SOURCE_ADAPTER_ID}'`);
    }
    if (!/^[a-z][a-z0-9-]*$/.test(config.instance_id)) {
      errors.push(
        "instance_id must use lowercase letters, numbers, and hyphens",
      );
    } else if (config.instance_id !== this.identity.instance_id) {
      errors.push("instance_id does not match the registered adapter instance");
    }
    if (this.client === undefined && !isNonEmptyString(config.credential_ref)) {
      errors.push("credential_ref is required");
    }
    const allowedSettings = new Set([
      "base_url",
      "request_timeout_ms",
      "page_size",
      "cursor_overlap_ms",
      "owner_email",
    ]);
    for (const key of Object.keys(config.settings)) {
      if (!allowedSettings.has(key))
        errors.push(`settings.${key} is not supported`);
    }
    const baseUrl = config.settings["base_url"];
    if (baseUrl !== undefined) {
      try {
        const url = new URL(String(baseUrl));
        if (url.protocol !== "https:" || !isNonEmptyString(baseUrl)) {
          errors.push("settings.base_url must be an HTTPS URL");
        }
      } catch {
        errors.push("settings.base_url must be an HTTPS URL");
      }
    }
    const requestTimeout = config.settings["request_timeout_ms"];
    if (
      requestTimeout !== undefined &&
      !positiveInteger(requestTimeout, MAX_REQUEST_TIMEOUT_MS)
    ) {
      errors.push(
        `settings.request_timeout_ms must be an integer from 1 to ${MAX_REQUEST_TIMEOUT_MS}`,
      );
    }
    const pageSize = config.settings["page_size"];
    if (
      pageSize !== undefined &&
      !positiveInteger(pageSize, DEFAULT_GRANOLA_PAGE_SIZE)
    ) {
      errors.push(
        `settings.page_size must be an integer from 1 to ${DEFAULT_GRANOLA_PAGE_SIZE}`,
      );
    }
    const overlap = config.settings["cursor_overlap_ms"];
    if (
      overlap !== undefined &&
      !nonNegativeInteger(overlap, MAX_CURSOR_OVERLAP_MS)
    ) {
      errors.push(
        `settings.cursor_overlap_ms must be an integer from 0 to ${MAX_CURSOR_OVERLAP_MS}`,
      );
    }
    const ownerEmail = config.settings["owner_email"];
    if (
      ownerEmail !== undefined &&
      !isCanonicalLowercaseEmail(ownerEmail)
    ) {
      errors.push(
        "settings.owner_email must be a canonical lowercase email address",
      );
    }
    return { ok: errors.length === 0, errors };
  }

  async healthCheck(
    operation?: AdapterOperationContext,
  ): Promise<AdapterHealth> {
    const checkedAt = normalizedIso(this.now());
    if (checkedAt === null) {
      return {
        status: "unavailable",
        checked_at: new Date().toISOString(),
        message: "Granola adapter clock returned an invalid timestamp",
      };
    }
    const validation = this.validateConfig(this.config);
    if (!validation.ok) {
      return {
        status: "unavailable",
        checked_at: checkedAt,
        message: "Granola adapter configuration is invalid",
        details: { error_count: validation.errors.length },
      };
    }
    try {
      this.assertNotCancelled(operation?.signal);
      const client = await this.apiClient();
      this.assertNotCancelled(operation?.signal);
      await client.listNotes({ page_size: 1 }, { signal: operation?.signal });
      return { status: "healthy", checked_at: checkedAt };
    } catch (error) {
      const mapped = adapterError(error);
      return {
        status: mapped.code === "unauthorized" ? "unauthorized" : "degraded",
        checked_at: checkedAt,
        message: mapped.message,
        details: { retryable: mapped.retryable },
      };
    }
  }

  async pull(
    request: MeetingPullRequest,
    operation?: AdapterOperationContext,
  ): Promise<MeetingBatch> {
    const validation = this.validateConfig(this.config);
    if (!validation.ok) {
      throw new AdapterError(
        "invalid_config",
        "Granola adapter configuration is invalid",
        false,
      );
    }
    if (
      request.limit !== undefined &&
      (!Number.isInteger(request.limit) || request.limit <= 0)
    ) {
      throw new AdapterError(
        "invalid_config",
        "meeting pull limit must be a positive integer",
        false,
      );
    }

    const cursor = decodeCursor(request.cursor);
    const observedAt = this.observedAt();
    const updatedAfter =
      cursor.watermark === null
        ? undefined
        : subtractMillis(cursor.watermark, this.settings.cursorOverlapMs);
    const pageSize = Math.min(
      request.limit ?? this.settings.pageSize,
      this.settings.pageSize,
    );

    try {
      this.assertNotCancelled(operation?.signal);
      const client = await this.apiClient();
      this.assertNotCancelled(operation?.signal);
      const response = await client.listNotes(
        {
          ...(updatedAfter === undefined
            ? {}
            : { updated_after: updatedAfter }),
          ...(cursor.page_cursor === null
            ? {}
            : { cursor: cursor.page_cursor }),
          page_size: pageSize,
        },
        { signal: operation?.signal },
      );
      if (response.hasMore && !isNonEmptyString(response.cursor)) {
        throw new GranolaApiError(
          "Granola pagination indicated more results without a cursor",
          "pagination_failed",
        );
      }

      const meetings: MeetingDocument[] = [];
      let pageHighWatermark = cursor.page_high_watermark;
      for (const listNote of response.notes) {
        this.assertNotCancelled(operation?.signal);
        pageHighWatermark = maxIso(
          pageHighWatermark,
          listNote.updated_at,
          listNote.created_at,
        );
        if (
          this.settings.ownerEmail !== undefined &&
          listOwnerEmail(listNote.owner) !== this.settings.ownerEmail
        ) {
          continue;
        }
        const noteDetail = await client.getNote(listNote.id, {
          signal: operation?.signal,
        });
        if (
          this.settings.ownerEmail !== undefined &&
          noteDetail.owner !== undefined &&
          noteDetail.owner !== null &&
          listOwnerEmail(noteDetail.owner) !== this.settings.ownerEmail
        ) {
          continue;
        }
        const detail = mergeNote(listNote, noteDetail);
        pageHighWatermark = maxIso(
          pageHighWatermark,
          detail.updated_at,
          detail.created_at,
        );
        meetings.push(this.toMeeting(detail, observedAt));
      }

      const nextCursor: GranolaCursorState = response.hasMore
        ? {
            schema_version: 1,
            watermark: cursor.watermark,
            page_cursor: response.cursor,
            page_high_watermark: pageHighWatermark,
          }
        : {
            schema_version: 1,
            watermark:
              maxIso(cursor.watermark, pageHighWatermark) ?? observedAt,
            page_cursor: null,
            page_high_watermark: null,
          };
      return { meetings, next_cursor: encodeCursor(nextCursor) };
    } catch (error) {
      throw adapterError(error);
    }
  }

  private assertNotCancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) {
      throw new AdapterError(
        "timeout",
        "Granola meeting pull was cancelled",
        true,
      );
    }
  }

  private observedAt(): string {
    const value = normalizedIso(this.now());
    if (value === null) {
      throw new AdapterError(
        "temporarily_unavailable",
        "clock returned an invalid timestamp",
        true,
      );
    }
    return value;
  }

  private async apiClient(): Promise<GranolaApiClient> {
    if (this.client !== undefined) return this.client;
    const reference = this.config.credential_ref;
    if (!isNonEmptyString(reference)) {
      throw new AdapterError(
        "unauthorized",
        "Granola credentials are unavailable",
        false,
      );
    }
    const apiKey = await this.credentialResolver(reference);
    if (!isNonEmptyString(apiKey) || !GRANOLA_API_KEY_RE.test(apiKey)) {
      throw new AdapterError(
        "unauthorized",
        "Granola credentials are unavailable",
        false,
      );
    }
    this.client = new HttpGranolaApiClient(apiKey, {
      baseUrl: this.settings.baseUrl,
      requestTimeoutMs: this.settings.requestTimeoutMs,
    });
    return this.client;
  }

  private toMeeting(
    note: GranolaNoteDetail,
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
      id: `${GRANOLA_MEETING_SOURCE_ADAPTER_ID}:${this.identity.instance_id}:${note.id}`,
      ...(isNonEmptyString(note.title) ? { title: note.title.trim() } : {}),
      ...(time === undefined ? {} : { time }),
      participants,
      content,
      artifacts: [],
      capture: captureState(note, participants, content),
      provenance: {
        source: this.identity,
        external_id: note.id,
        canonical_revision: sourceRevision(note),
        observed_at: observedAt,
        normalizer_version: GRANOLA_MEETING_SOURCE_ADAPTER_VERSION,
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
}

export function createGranolaMeetingSourceAdapter(
  config: AdapterConfig,
  options: GranolaMeetingSourceAdapterOptions = {},
): GranolaMeetingSourceAdapter {
  return new GranolaMeetingSourceAdapter(config, options);
}
