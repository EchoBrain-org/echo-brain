import { createHash } from "node:crypto";
import type {
  JsonObject, JsonValue, MeetingContentBlock,
  MeetingDocument, MeetingParticipant,
} from "@echo-brain/organization-processing/core";

/** Content mapping version, part of every revision. 2.4.0: folder membership is not, so moving a note between folders is no edit. */
export const GRANOLA_MEETING_NORMALIZER_VERSION_V1 = "2.4.0";

/**
 * Transport-independent input for the retained content transforms. This is not
 * the Granola MCP wire contract; connectors must validate and map their own
 * responses before normalizing. No credentials, discovery, or owner admission
 * are performed here.
 */
export interface GranolaMeetingContentInputV1 {
  id: string;
  title?: string | null;
  created_at?: string;
  /** Provider fields not yet promoted into the typed Granola contract. */
  provider_fields?: Record<string, unknown>;
  summary_markdown?: string | null;
  /** The person's own notes; kept apart from Granola's AI summary. */
  private_notes_markdown?: string | null;
  /** Actual start, ISO with offset. */
  started_at?: string | null;
  /** IANA zone of `started_at`. */
  timezone?: string | null;
  /** Transcript turns without speaker metadata: audio labels stay in the text. */
  transcript?: readonly { readonly text: string }[] | null;
  /**
   * People Granola reports for the meeting. They prove neither identity nor
   * attendance, so they become participants with no role.
   */
  reported_participants?: readonly { readonly name: string; readonly email?: string }[];
  web_url?: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizedIso(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const millis = new Date(value).getTime();
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
    title: note.title,
    created_at: note.created_at,
    summary_markdown: note.summary_markdown,
    private_notes_markdown: note.private_notes_markdown,
    started_at: note.started_at,
    timezone: note.timezone,
    transcript: note.transcript,
    reported_participants: note.reported_participants,
    provider_fields: note.provider_fields,
    web_url: note.web_url,
  });
  const digest = createHash("sha256")
    .update(stableJson(normalized ?? null))
    .digest("hex");
  return `sha256:${digest}`;
}

function meetingTime(note: GranolaMeetingContentInputV1): MeetingDocument["time"] {
  const startedAt = normalizedIso(note.started_at);
  if (startedAt === null) return undefined;
  return {
    actual_start_at: startedAt,
    ...(isNonEmptyString(note.timezone) ? { timezone: note.timezone.trim() } : {}),
  };
}

function nameParticipantId(displayName: string): string {
  return `name:sha256:${createHash("sha256").update(displayName.toLowerCase()).digest("hex")}`;
}

function participantFrom(
  value: { readonly name: string; readonly email?: string },
): MeetingParticipant | null {
  const email = isNonEmptyString(value.email)
    ? value.email.trim().toLowerCase()
    : null;
  const displayName = isNonEmptyString(value.name) ? value.name.trim() : email;
  if (displayName === null) return null;
  return {
    id: email === null ? nameParticipantId(displayName) : `email:${email}`,
    display_name: displayName,
    ...(email === null
      ? {}
      : { identities: [{ kind: "email" as const, value: email }] }),
  };
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
  };
}

function noteParticipants(note: GranolaMeetingContentInputV1): MeetingParticipant[] {
  const participants: MeetingParticipant[] = [];
  for (const person of note.reported_participants ?? []) {
    const participant = participantFrom(person);
    if (participant === null) continue;
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
      );
      continue;
    }
    participants.push(participant);
  }
  return participants;
}

function transcriptBlock(
  noteId: string,
  turn: { readonly text: string },
  index: number,
): MeetingContentBlock | null {
  if (!isNonEmptyString(turn.text)) return null;
  return {
    id: `${noteId}:transcript:${index}`,
    kind: "transcript",
    text: turn.text.trim(),
    sequence: index,
    origin: "imported",
    metadata: { source_index: index, granola: { speaker_resolution: "unresolved" } },
  };
}

function noteContent(note: GranolaMeetingContentInputV1): MeetingContentBlock[] {
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
  if (isNonEmptyString(note.summary_markdown)) {
    blocks.push({
      id: `${note.id}:summary`,
      kind: "summary",
      text: note.summary_markdown.trim(),
      origin: "source_ai",
      metadata: { format: "markdown" },
    });
  }
  for (const [index, turn] of (note.transcript ?? []).entries()) {
    const block = transcriptBlock(note.id, turn, index);
    if (block !== null) blocks.push(block);
  }
  return blocks;
}

function sourceExtensions(note: GranolaMeetingContentInputV1): JsonObject | undefined {
  const granola = sanitizeJson({ provider_fields: note.provider_fields });
  return isPlainObject(granola) && Object.keys(granola).length > 0
    ? { granola: granola as JsonObject }
    : undefined;
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
    note.summary_markdown === undefined
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
    ...(transcriptAvailable
      ? { warnings: ["Some Granola transcript turns did not include usable speaker metadata."] }
      : {}),
  };
}

/** Normalize validated content without acquiring or admitting a source. */
export function normalizeGranolaMeetingV1(
  note: GranolaMeetingContentInputV1,
  source: MeetingDocument["provenance"]["source"],
  observedAt: string,
): MeetingDocument {
  const participants = noteParticipants(note);
  const content = noteContent(note);
  const time = meetingTime(note);
  const extensions = sourceExtensions(note);
  const sourceCreatedAt = normalizedIso(note.created_at) ?? undefined;
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
      ...(isNonEmptyString(note.web_url) ? { source_url: note.web_url } : {}),
    },
    ...(extensions === undefined ? {} : { extensions }),
  };
}
