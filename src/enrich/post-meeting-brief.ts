import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveCurrentGranolaNoteAtoms,
  resolveCurrentGranolaNotes,
  type CurrentGranolaNoteAtoms,
} from '../capture/surfaces/granola-poller.js';
import type { CaptureEvent, Storage } from '../storage/interface.js';
import {
  filterToCurrentSignalRuns,
  GRANOLA_SIGNAL_INDEX_SOURCE,
  GRANOLA_SIGNAL_SOURCE,
  resolveCurrentGranolaSignalRuns,
} from './granola-signals.js';

export class PostMeetingBriefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PostMeetingBriefError';
  }
}

export interface PostMeetingBrief {
  schema_version: 1;
  kind: 'post_meeting_brief';
  meeting: {
    title: string;
    date: string;
    attendees: string[];
    source: { provider: 'granola'; note_id: string; url: string | null };
  };
  decided: Array<{ text: string }>;
  actions: Array<{ text: string; owner: string | null; due: string | null }>;
  context: string[];
  carryover: [];
  provenance: { extraction_run: string; generated_at: string };
}

export interface ResolveBriefTargetOptions {
  noteId?: string;
  now?: Date;
  freshnessMs?: number;
}

export interface CompileBriefOptions {
  noteId: string;
  generatedAt?: string;
}

export interface BriefArtifacts {
  jsonPath: string;
  markdownPath: string;
  markdown: string;
}

const DEFAULT_BRIEF_FRESHNESS_MS = 30 * 60 * 1000;
const CHAT_WIDE_MENTION_RE = /@(channel|here|all|everyone)\b/g;
const FENCE_LINE_RE = /^\s*```[A-Za-z0-9_-]*\s*$/;

function metadataString(event: CaptureEvent | undefined, key: string): string | null {
  const value = event?.metadata?.[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function metadataArrayNames(event: CaptureEvent | undefined, key: string): string[] {
  const value = event?.metadata?.[key];
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim() !== '') {
      names.push(item.trim());
    } else if (typeof item === 'object' && item !== null) {
      const record = item as Record<string, unknown>;
      const name = record['name'];
      const email = record['email'];
      if (typeof name === 'string' && name.trim() !== '') names.push(name.trim());
      else if (typeof email === 'string' && email.trim() !== '') names.push(email.trim());
    }
  }
  return names;
}

function noteUpdatedAt(atoms: CurrentGranolaNoteAtoms): string | null {
  const candidates = [atoms.summary, atoms.transcript]
    .map((event) => metadataString(event, 'updated_at'))
    .filter((value): value is string => value !== null)
    .sort();
  return candidates.at(-1) ?? null;
}

function noteStart(atoms: CurrentGranolaNoteAtoms): string {
  return (
    metadataString(atoms.summary, 'created_at') ??
    metadataString(atoms.transcript, 'created_at') ??
    noteUpdatedAt(atoms) ??
    atoms.summary?.timestamp ??
    atoms.transcript?.timestamp ??
    ''
  );
}

function noteTitle(atoms: CurrentGranolaNoteAtoms): string {
  return (
    metadataString(atoms.summary, 'title') ??
    metadataString(atoms.transcript, 'title') ??
    'Untitled Granola note'
  );
}

export async function resolvePostMeetingBriefTarget(
  storage: Storage,
  opts: ResolveBriefTargetOptions = {},
): Promise<CurrentGranolaNoteAtoms> {
  if (opts.noteId !== undefined) {
    const atoms = await resolveCurrentGranolaNoteAtoms(storage, opts.noteId);
    if (atoms.summary === undefined && atoms.transcript === undefined) {
      throw new PostMeetingBriefError(`target note not found: ${opts.noteId}`);
    }
    return atoms;
  }

  const nowMs = (opts.now ?? new Date()).getTime();
  const freshnessMs = opts.freshnessMs ?? DEFAULT_BRIEF_FRESHNESS_MS;
  const candidates = [...(await resolveCurrentGranolaNotes(storage)).values()]
    .filter((atoms) => atoms.summary !== undefined)
    .map((atoms) => ({ atoms, updatedAt: noteUpdatedAt(atoms) }))
    .filter(
      (entry): entry is { atoms: CurrentGranolaNoteAtoms; updatedAt: string } =>
        entry.updatedAt !== null,
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const newest = candidates[0];
  if (newest === undefined) {
    throw new PostMeetingBriefError('no Granola notes available for brief generation');
  }
  const ageMs = nowMs - new Date(newest.updatedAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > freshnessMs) {
    throw new PostMeetingBriefError(
      `newest Granola note is outside freshness window: ${newest.updatedAt}`,
    );
  }
  return newest.atoms;
}

function signalText(event: CaptureEvent): string {
  return event.content.trim();
}

function signalType(event: CaptureEvent): string | null {
  const value = event.metadata?.['signal_type'];
  return typeof value === 'string' ? value : null;
}

export async function compilePostMeetingBrief(
  storage: Storage,
  opts: CompileBriefOptions,
): Promise<PostMeetingBrief> {
  const atoms = await resolveCurrentGranolaNoteAtoms(storage, opts.noteId);
  if (atoms.summary === undefined && atoms.transcript === undefined) {
    throw new PostMeetingBriefError(`target note not found: ${opts.noteId}`);
  }

  const manifestEvents = await storage.query({ source: GRANOLA_SIGNAL_INDEX_SOURCE, order: 'asc' });
  const currentRun = resolveCurrentGranolaSignalRuns(manifestEvents).get(opts.noteId);
  if (currentRun === undefined) {
    throw new PostMeetingBriefError(
      `no current successful extraction run for note: ${opts.noteId}`,
    );
  }

  const signalEvents = (
    await storage.query({ source: GRANOLA_SIGNAL_SOURCE, order: 'asc' })
  ).filter((event) => event.metadata?.['note_id'] === opts.noteId);
  const currentSignals = filterToCurrentSignalRuns(signalEvents, manifestEvents);
  const decided = currentSignals
    .filter((event) => signalType(event) === 'decision')
    .map((event) => ({ text: signalText(event) }));
  const actions = currentSignals
    .filter((event) => signalType(event) === 'action')
    .map((event) => ({
      text: signalText(event),
      owner: metadataString(event, 'owner'),
      due: metadataString(event, 'due'),
    }));
  const context = currentSignals
    .filter((event) => signalType(event) === 'rationale')
    .map(signalText);

  return {
    schema_version: 1,
    kind: 'post_meeting_brief',
    meeting: {
      title: noteTitle(atoms),
      date: noteStart(atoms),
      attendees: metadataArrayNames(atoms.summary ?? atoms.transcript, 'attendees'),
      source: {
        provider: 'granola',
        note_id: opts.noteId,
        url: metadataString(atoms.summary ?? atoms.transcript, 'web_url'),
      },
    },
    decided,
    actions,
    context,
    carryover: [],
    provenance: {
      extraction_run: currentRun.extraction_run_id,
      generated_at: opts.generatedAt ?? new Date().toISOString(),
    },
  };
}

export function sanitizeBriefMarkdownText(value: string): string {
  const lines: string[] = [];
  let inFence = false;
  for (const line of value.split(/\r?\n/)) {
    if (FENCE_LINE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    lines.push(`${inFence ? '    ' : ''}${line}`);
  }
  return lines.join('\n').replace(/`/g, '’').replace(CHAT_WIDE_MENTION_RE, '@\u200B$1');
}

function formatLocalDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'invalid date';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function renderPostMeetingBriefMarkdown(brief: PostMeetingBrief): string {
  const attendees =
    brief.meeting.attendees.length === 0 ? 'unknown' : brief.meeting.attendees.join(', ');
  const lines = [
    `Meeting: ${sanitizeBriefMarkdownText(brief.meeting.title)} | Starts: ${formatLocalDateTime(
      brief.meeting.date,
    )} | Attendees: ${sanitizeBriefMarkdownText(attendees)}`,
    '',
    '## Decided',
  ];
  if (brief.decided.length === 0) {
    lines.push(brief.actions.length === 0 ? '- No decisions recorded' : '- None recorded');
  } else {
    lines.push(...brief.decided.map((item) => `- ${sanitizeBriefMarkdownText(item.text)}`));
  }
  lines.push('', '## Actions');
  if (brief.actions.length === 0) {
    lines.push('- None recorded');
  } else {
    lines.push(
      ...brief.actions.map((item) => {
        const owner = sanitizeBriefMarkdownText(item.owner ?? 'unassigned');
        const due = item.due === null ? '' : ` (due ${sanitizeBriefMarkdownText(item.due)})`;
        return `- ${owner}: ${sanitizeBriefMarkdownText(item.text)}${due}`;
      }),
    );
  }
  if (brief.context.length > 0) {
    lines.push(
      '',
      '## Context',
      ...brief.context.map((item) => `- ${sanitizeBriefMarkdownText(item)}`),
    );
  }
  lines.push(
    '',
    `Source: ${brief.meeting.source.url ?? brief.meeting.source.note_id}`,
    '',
    '**REVIEW BEFORE SENDING**',
  );
  return `${lines.join('\n')}\n`;
}

export function writePostMeetingBriefArtifacts(
  brief: PostMeetingBrief,
  outDir: string,
): BriefArtifacts {
  mkdirSync(outDir, { recursive: true });
  const base = `brief-${brief.meeting.source.note_id}`;
  const jsonPath = join(outDir, `${base}.json`);
  const markdownPath = join(outDir, `${base}.md`);
  const markdown = renderPostMeetingBriefMarkdown(brief);
  writeFileSync(jsonPath, `${JSON.stringify(brief, null, 2)}\n`);
  writeFileSync(markdownPath, markdown);
  return { jsonPath, markdownPath, markdown };
}

export function normalizeBriefParityText(value: string): string {
  return value
    .replace(/\u200B/g, '')
    .replace(/[’`]/g, "'")
    .split(/\r?\n/)
    .map((line) => line.replace(/^ {4}/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function briefParitySet(values: readonly string[]): Set<string> {
  return new Set(values.map(normalizeBriefParityText).filter((value) => value !== ''));
}
