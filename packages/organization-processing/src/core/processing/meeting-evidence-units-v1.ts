import type { MeetingContentBlock, MeetingDocument, MeetingParticipant } from "../contracts/meeting.js";

/**
 * Vendor-neutral preparation of a meeting for extraction: a header plus short
 * numbered evidence units the model cites by ID. Reads only the shared
 * MeetingDocument contract and never branches on the source adapter.
 */

export interface MeetingEvidenceUnitV1 {
  /** "T12", "T12.1", "N3", "S4" — prefix by kind, numbered in reading order per prefix. */
  readonly id: string;
  readonly kind: 'transcript' | 'note' | 'summary';
  readonly block_id: string;
  /** UTF-16 offsets into the block's text. */
  readonly start: number;
  readonly end: number;
  /** Exactly block.text.slice(start, end); non-empty; no leading or trailing whitespace. */
  readonly text: string;
  /** One line shown to the model: whitespace collapsed to single spaces; in merged transcript turns the repeated same-speaker labels are removed. */
  readonly display: string;
  /** Participant display name for speaker-attributed blocks, else the parsed "Label:" of the turn, else null. */
  readonly speaker: string | null;
  /** Nearest preceding markdown heading text inside a note/summary block, else null. */
  readonly section: string | null;
  /** True when `display` consists only of questions. */
  readonly question: boolean;
}
export interface MeetingEvidenceHeaderV1 {
  readonly title: string | null;
  /** From time.actual_start_at ?? time.scheduled_start_at in time.timezone (UTC when absent); null when no timestamp. */
  readonly date: { readonly local_date: string; readonly weekday: string; readonly time_zone: string } | null;
  /** Participant display names (fall back to id), de-duplicated, document order, role 'bot' excluded. */
  readonly participants: readonly string[];
}
export interface MeetingEvidenceV1 {
  readonly header: MeetingEvidenceHeaderV1;
  /** Document order (block order, then offset order). */
  readonly units: readonly MeetingEvidenceUnitV1[];
}

type UnitKind = MeetingEvidenceUnitV1['kind'];
interface Span { start: number; end: number }
/** One numbered entry before long-text splitting; `display` is set only for merged turns. */
interface Entry extends Span { speaker: string | null; section: string | null; display?: string }

const PREFIX: Readonly<Record<UnitKind, string>> = { transcript: 'T', note: 'N', summary: 'S' };
const TRANSCRIPT_KINDS = new Set<MeetingContentBlock['kind']>(['transcript', 'caption', 'chat_message']);
const SUMMARY_KINDS = new Set<MeetingContentBlock['kind']>(['summary', 'chapter', 'provider_action_item', 'provider_decision']);
const MERGE_MAX = 400;
const SPLIT_OVER = 600;
const PART_TARGET = 400;
/** `^([^:\n]{1,40}):[ \t]+\S`, with the body's first character in a lookahead so the match ends where the body starts. */
const SPEAKER_LABEL = /^([^:\n]{1,40}):[ \t]+(?=\S)/u;
const HEADING = /^\s{0,3}#{1,6}\s+(\S.*)$/u;
const LIST_MARKER = /^(?:[-*+•]|\d{1,3}[.)])(?:\s+|$)/u;
/** ASCII terminators need following whitespace or the end; full-width ones end a sentence on their own. */
const SENTENCE_END = /[.!?]+(?=\s|$)|[。！？]+/gu;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function buildMeetingEvidenceV1(meeting: MeetingDocument): MeetingEvidenceV1 {
  const names = new Map(meeting.participants.map((participant) => [participant.id, participantName(participant)]));
  const counters: Record<UnitKind, number> = { transcript: 0, note: 0, summary: 0 };
  const units: MeetingEvidenceUnitV1[] = [];
  for (const block of meeting.content) {
    const kind = unitKind(block);
    const speakerId = block.speaker_participant_id;
    const speaker = speakerId === undefined || speakerId === '' ? null : names.get(speakerId) ?? speakerId;
    const entries = kind === 'transcript' ? transcriptEntries(block.text, speaker) : lineEntries(block.text, speaker);
    for (const entry of entries) {
      counters[kind] += 1;
      const id = PREFIX[kind] + counters[kind];
      const parts = entry.display === undefined ? sentenceParts(block.text, entry) : [entry];
      parts.forEach((part, index) => {
        const display = entry.display ?? collapse(block.text.slice(part.start, part.end));
        units.push({
          id: parts.length === 1 ? id : `${id}.${index + 1}`,
          kind,
          block_id: block.id,
          start: part.start,
          end: part.end,
          text: block.text.slice(part.start, part.end),
          display,
          speaker: entry.speaker,
          section: entry.section,
          question: isQuestionsOnly(display),
        });
      });
    }
  }
  return { header: header(meeting), units };
}

/** Local YYYY-MM-DD of an ISO timestamp in an IANA zone (UTC fallback on a bad zone); null on a bad timestamp. */
export function localDateV1(timestamp: string, timeZone: string | undefined): string | null {
  if (timestamp.trim() === '') return null;
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone !== undefined && timeZone.trim() !== '' ? timeZone : 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(parsed);
    const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
    const year = value('year');
    const month = value('month');
    const day = value('day');
    return year === undefined || month === undefined || day === undefined
      ? parsed.toISOString().slice(0, 10)
      : `${year}-${month}-${day}`;
  } catch {
    return parsed.toISOString().slice(0, 10);
  }
}

function header(meeting: MeetingDocument): MeetingEvidenceHeaderV1 {
  const title = meeting.title?.trim() ?? '';
  const participants = [...new Set(meeting.participants
    .filter((participant) => participant.roles?.includes('bot') !== true)
    .map(participantName))];
  return { title: title === '' ? null : title, date: meetingDate(meeting), participants };
}

function meetingDate(meeting: MeetingDocument): MeetingEvidenceHeaderV1['date'] {
  const timestamp = meeting.time?.actual_start_at ?? meeting.time?.scheduled_start_at;
  if (timestamp === undefined) return null;
  const timeZone = knownTimeZone(meeting.time?.timezone);
  const localDate = localDateV1(timestamp, timeZone);
  if (localDate === null) return null;
  const weekday = WEEKDAYS[new Date(`${localDate}T00:00:00Z`).getUTCDay()] ?? 'unknown';
  return { local_date: localDate, weekday, time_zone: timeZone };
}

function knownTimeZone(timeZone: string | undefined): string {
  if (timeZone === undefined || timeZone.trim() === '') return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

function participantName(participant: MeetingParticipant): string {
  const name = participant.display_name?.trim() ?? '';
  return name === '' ? participant.id : name;
}

function unitKind(block: MeetingContentBlock): UnitKind {
  if (block.origin === 'source_ai' || SUMMARY_KINDS.has(block.kind)) return 'summary';
  return TRANSCRIPT_KINDS.has(block.kind) ? 'transcript' : 'note';
}

function transcriptEntries(text: string, attributed: string | null): Entry[] {
  if (attributed !== null) {
    const whole = trimSpan(text, 0, text.length);
    return whole === null ? [] : [{ ...whole, speaker: attributed, section: null }];
  }
  const turns: Entry[] = [];
  for (const line of lines(text)) {
    const label = SPEAKER_LABEL.exec(text.slice(line.start, line.end));
    const speaker = label?.[1]?.trim() ?? '';
    const current = turns.at(-1);
    if (label !== null && /\p{L}/u.test(speaker) && !speaker.includes('/')) {
      turns.push({ start: line.start + label[0].length, end: line.end, speaker, section: null });
    } else if (current === undefined) {
      turns.push({ start: line.start, end: line.end, speaker: null, section: null });
    } else {
      current.end = line.end;
    }
  }
  const merged: { entry: Entry; display: string; count: number }[] = [];
  for (const turn of turns) {
    const display = collapse(text.slice(turn.start, turn.end));
    const previous = merged.at(-1);
    if (previous !== undefined && turn.speaker !== null && previous.entry.speaker === turn.speaker
      && previous.display.length + 1 + display.length <= MERGE_MAX) {
      previous.entry.end = turn.end;
      previous.display += ` ${display}`;
      previous.count += 1;
    } else {
      merged.push({ entry: turn, display, count: 1 });
    }
  }
  // A merged turn shows its bodies without the repeated labels and is never split.
  return merged.map(({ entry, display, count }) => (count === 1 ? entry : { ...entry, display }));
}

function lineEntries(text: string, speaker: string | null): Entry[] {
  const entries: Entry[] = [];
  let section: string | null = null;
  for (const line of lines(text)) {
    const heading = HEADING.exec(text.slice(line.lineStart, line.end));
    if (heading !== null) {
      const title = (heading[1] ?? '').replace(/\*\*|__/gu, '').trim();
      section = title === '' ? null : title;
      continue;
    }
    const marker = LIST_MARKER.exec(text.slice(line.start, line.end));
    const start = line.start + (marker?.[0].length ?? 0);
    if (start < line.end) entries.push({ start, end: line.end, speaker, section });
  }
  return entries;
}

/** Non-empty lines as trimmed spans, keeping the raw line start for heading indentation. */
function lines(text: string): (Span & { lineStart: number })[] {
  const result: (Span & { lineStart: number })[] = [];
  for (let lineStart = 0; lineStart <= text.length;) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const span = trimSpan(text, lineStart, lineEnd);
    if (span !== null) result.push({ ...span, lineStart });
    lineStart = lineEnd + 1;
  }
  return result;
}

/** Once a span exceeds SPLIT_OVER, greedily packs whole sentences into parts of at most PART_TARGET characters. */
function sentenceParts(text: string, span: Span): Span[] {
  if (span.end - span.start <= SPLIT_OVER) return [{ start: span.start, end: span.end }];
  const sentences: Span[] = [];
  let from = span.start;
  for (const match of text.slice(span.start, span.end).matchAll(SENTENCE_END)) {
    const to = span.start + match.index + match[0].length;
    const sentence = trimSpan(text, from, to);
    if (sentence !== null) sentences.push(sentence);
    from = to;
  }
  const rest = trimSpan(text, from, span.end);
  if (rest !== null) sentences.push(rest);
  const parts: Span[] = [];
  for (const sentence of sentences) {
    const part = parts.at(-1);
    if (part !== undefined && sentence.end - part.start <= PART_TARGET) part.end = sentence.end;
    else parts.push({ ...sentence });
  }
  return parts;
}

function trimSpan(text: string, start: number, end: number): Span | null {
  let from = start;
  let to = end;
  while (from < to && /\s/u.test(text.charAt(from))) from += 1;
  while (to > from && /\s/u.test(text.charAt(to - 1))) to -= 1;
  return from < to ? { start: from, end: to } : null;
}

function collapse(text: string): string {
  return text.replace(/\s+/gu, ' ');
}

/**
 * Same result as matching `^(?:[^.?!。？！]*[?？]\s*)+$` (no other sentence
 * terminator anywhere, ends with a question mark) without that pattern's
 * exponential backtracking on long text that does not match.
 */
function isQuestionsOnly(display: string): boolean {
  return !/[.!。！]/u.test(display) && /[?？]\s*$/u.test(display);
}
