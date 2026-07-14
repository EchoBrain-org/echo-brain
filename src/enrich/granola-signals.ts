import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  GRANOLA_API_SOURCE,
  GRANOLA_DERIVED_INDEX_SOURCE,
  GRANOLA_DERIVED_SOURCE,
  isAllowedGranolaDerivedSource,
} from '../capture/granola-source-policy.js';
import { ECHO_STATE_PATHS } from '../echo-home/state-paths.js';
import { atomicWrite } from '../echo-home/adapters/atomic-write.js';
import { isNonEmptyString } from '../guards.js';
import { createLogger } from '../logging/index.js';
import { normalizeSubject } from '../util/subject.js';
import type { CaptureEvent, EventId, Storage } from '../storage/interface.js';
import { parseJson } from '../util/json.js';
import {
  resolveCurrentGranolaNotes,
  withGranolaCheckpointLock,
  writeCheckpointJsonWithLock,
} from '../capture/surfaces/granola-poller.js';
import {
  GRANOLA_SIGNALS_WORKER,
  writeWorkerHeartbeat,
  type WorkerHeartbeat,
} from './worker-heartbeat.js';

export const GRANOLA_RAW_SOURCE = GRANOLA_API_SOURCE;
export const GRANOLA_SIGNAL_SOURCE = GRANOLA_DERIVED_SOURCE;
export const GRANOLA_SIGNAL_INDEX_SOURCE = GRANOLA_DERIVED_INDEX_SOURCE;
export const GRANOLA_SIGNAL_EXTRACTOR_VERSION = 'granola-signals@1';
export const GRANOLA_SIGNAL_CHECKPOINT_SCHEMA_VERSION = 1;
export const DEFAULT_GRANOLA_SIGNAL_WORKER_INTERVAL_MS = 300_000;
export const DEFAULT_GRANOLA_SIGNAL_SETTLE_MS = 600_000;
export const DEFAULT_GRANOLA_SIGNAL_LOW_CONFIDENCE = 0.5;
export const DEFAULT_GRANOLA_SIGNAL_MAX_RETRIES = 2;
export const DEFAULT_GRANOLA_SIGNAL_MAX_NOTES_PER_TICK = 5;
export const DEFAULT_GRANOLA_SIGNAL_BRAIN_TIMEOUT_MS = 180_000;
export const DEFAULT_GRANOLA_SIGNAL_FAILURE_RETRY_AFTER_MS = 3_600_000;
export const DEFAULT_GRANOLA_SIGNAL_MAX_FAILURE_ATTEMPTS = 3;
export const GRANOLA_SIGNAL_BRAIN_TIMEOUT_CAP_MS = 600_000;

const log = createLogger('enrich.granola-signals');

export type GranolaSignalType = 'decision' | 'rationale' | 'action';
export type GranolaDecisionStatus = 'proposed' | 'decided' | 'unresolved';

export interface GranolaTranscriptSpan {
  kind: 'transcript';
  start_time: string | number;
  end_time: string | number;
  quote: string;
}

export type GranolaSignalSourceSpan = { kind: 'summary' } | GranolaTranscriptSpan;

export interface GranolaExtractedSignal {
  signal_type: GranolaSignalType;
  text: string;
  canonical_subject: string;
  source_span: GranolaSignalSourceSpan;
  confidence: number;
  owner?: string;
  rationale_for?: string;
  decision_status?: GranolaDecisionStatus;
}

export interface GranolaTranscriptItemForExtraction {
  start_time: string | number | null;
  end_time: string | number | null;
  speaker: string;
  text: string;
}

export interface GranolaSignalExtractionInput {
  note_id: string;
  meeting_title: string;
  updated_at: string;
  summary_text: string;
  summary_dedupe_key: string;
  transcript_text: string;
  transcript_dedupe_key: string;
  transcript_items: GranolaTranscriptItemForExtraction[];
}

export interface GranolaSignalExtractionContext {
  extractor_version: string;
}

export type GranolaSignalExtractor = (
  input: GranolaSignalExtractionInput,
  context: GranolaSignalExtractionContext,
) => Promise<GranolaExtractedSignal[]>;

export interface GranolaSignalAdapter {
  id: string;
  preflight: () => Promise<void>;
  extract: GranolaSignalExtractor;
}

export interface GranolaSignalCheckpointEntry {
  input_fingerprint: string;
  extractor_version: string;
  last_attempted_at: string;
  last_success_at?: string;
  last_failure_at?: string;
  last_failure_reason?: string;
  retry_after_at?: string;
  failure_attempts?: number;
}

export interface GranolaSignalCheckpoint {
  schema_version: typeof GRANOLA_SIGNAL_CHECKPOINT_SCHEMA_VERSION;
  notes: Record<string, GranolaSignalCheckpointEntry>;
}

export interface GranolaSignalRunManifest {
  note_id: string;
  extractor_version: string;
  extraction_run_id: string;
  completed_at: string;
  supersedes: string | null;
  signal_atom_ids: string[];
}

export interface GranolaSignalWorkerOptions {
  checkpointPath?: string;
  extractorVersion?: string;
  extractFn?: GranolaSignalExtractor;
  adapter?: GranolaSignalAdapter;
  now?: () => string;
  settleMs?: number;
  lowConfidenceThreshold?: number;
  maxRetries?: number;
  maxNotesPerTick?: number;
  retryDelayMs?: number;
  failureRetryAfterMs?: number;
  maxFailureAttempts?: number;
  targetNoteId?: string;
  lockTimeoutMs?: number;
  lockStaleMs?: number;
  lockRetryMs?: number;
  workerIntervalMs?: number;
  runOnStart?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Compatibility-only injected availability seam; never selects an adapter. */
  preflight?: () => Promise<void>;
  heartbeatPath?: string;
}

/**
 * Per-tick skip/settle observability (item 115 AC3). Counters are in-memory
 * only — no new persisted state. Every skipped note increments exactly ONE
 * counter (exclusive first-match precedence) and emits exactly one structured
 * warn log carrying a machine-readable reason id (+ note_id where known).
 */
export interface GranolaSignalObservability {
  skipped_notes: {
    missing_summary: number;
    missing_transcript: number;
    missing_dedupe_key: number;
  };
  malformed_events: number;
  unparsable_updated_at: number;
}

export type GranolaSignalWorkerResult =
  | {
      status: 'ok';
      notes_seen: number;
      notes_extracted: number;
      signal_atoms_written: number;
      manifests_written: number;
      observability: GranolaSignalObservability;
    }
  | { status: 'skipped'; reason: 'in_flight' | 'disabled' | 'brain_unavailable' }
  | { status: 'error'; reason: string; message: string };

export interface GranolaSignalWorkerHandle {
  enabled: boolean;
  run: () => Promise<GranolaSignalWorkerResult>;
  stop: () => Promise<void>;
}

interface RawGranolaNote {
  note_id: string;
  meeting_title: string;
  updated_at: string;
  summary_text: string;
  summary_dedupe_key: string;
  transcript_text: string;
  transcript_dedupe_key: string;
  transcript_items: GranolaTranscriptItemForExtraction[];
}

interface PreparedSignal {
  content: string;
  metadata: Record<string, unknown>;
  rationaleLinkTarget?: string;
}

class GranolaSignalCheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GranolaSignalCheckpointError';
  }
}

export class GranolaExtractorParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GranolaExtractorParseError';
  }
}

export function granolaSignalCheckpointPath(): string {
  return join(ECHO_STATE_PATHS.state, 'granola-signals-checkpoint.json');
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function emptyCheckpoint(): GranolaSignalCheckpoint {
  return { schema_version: GRANOLA_SIGNAL_CHECKPOINT_SCHEMA_VERSION, notes: {} };
}

export function loadGranolaSignalCheckpoint(
  filePath = granolaSignalCheckpointPath(),
): GranolaSignalCheckpoint {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return emptyCheckpoint();
    throw new GranolaSignalCheckpointError(`checkpoint read failed: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = parseJson(raw);
  } catch (err) {
    throw new GranolaSignalCheckpointError(`checkpoint JSON invalid: ${(err as Error).message}`);
  }
  if (
    !isPlainObject(parsed) ||
    parsed['schema_version'] !== GRANOLA_SIGNAL_CHECKPOINT_SCHEMA_VERSION ||
    !isPlainObject(parsed['notes'])
  ) {
    throw new GranolaSignalCheckpointError('checkpoint schema invalid');
  }
  const notes: Record<string, GranolaSignalCheckpointEntry> = {};
  for (const [noteId, value] of Object.entries(parsed['notes'])) {
    if (!isPlainObject(value)) {
      throw new GranolaSignalCheckpointError(`checkpoint note ${noteId} invalid`);
    }
    const inputFingerprint = value['input_fingerprint'];
    const extractorVersion = value['extractor_version'];
    const lastAttemptedAt = value['last_attempted_at'];
    if (
      !isNonEmptyString(inputFingerprint) ||
      !isNonEmptyString(extractorVersion) ||
      !isNonEmptyString(lastAttemptedAt)
    ) {
      throw new GranolaSignalCheckpointError(`checkpoint note ${noteId} missing required fields`);
    }
    const entry: GranolaSignalCheckpointEntry = {
      input_fingerprint: inputFingerprint,
      extractor_version: extractorVersion,
      last_attempted_at: lastAttemptedAt,
    };
    copyOptionalString(value, entry, 'last_success_at');
    copyOptionalString(value, entry, 'last_failure_at');
    copyOptionalString(value, entry, 'last_failure_reason');
    copyOptionalString(value, entry, 'retry_after_at');
    const failureAttempts = value['failure_attempts'];
    if (typeof failureAttempts === 'number' && Number.isInteger(failureAttempts)) {
      entry.failure_attempts = failureAttempts;
    }
    notes[noteId] = entry;
  }
  return { schema_version: GRANOLA_SIGNAL_CHECKPOINT_SCHEMA_VERSION, notes };
}

export function writeGranolaSignalCheckpoint(
  checkpoint: GranolaSignalCheckpoint,
  filePath = granolaSignalCheckpointPath(),
): void {
  mkdirSync(dirname(filePath), { recursive: true });
  atomicWrite({ filePath, content: `${JSON.stringify(checkpoint, null, 2)}\n` });
}

async function writeGranolaSignalCheckpointLocked(
  lock: { checkpointPath: string; lockDir: string; ownerToken: string },
  checkpoint: GranolaSignalCheckpoint,
): Promise<void> {
  await writeCheckpointJsonWithLock(lock, `${JSON.stringify(checkpoint, null, 2)}\n`);
}

function copyOptionalString(
  from: Record<string, unknown>,
  to: GranolaSignalCheckpointEntry,
  key: 'last_success_at' | 'last_failure_at' | 'last_failure_reason' | 'retry_after_at',
): void {
  const value = from[key];
  if (typeof value === 'string') to[key] = value;
}

function stringMetadata(event: CaptureEvent, key: string): string | null {
  const value = event.metadata?.[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function emptyObservability(): GranolaSignalObservability {
  return {
    skipped_notes: { missing_summary: 0, missing_transcript: 0, missing_dedupe_key: 0 },
    malformed_events: 0,
    unparsable_updated_at: 0,
  };
}

function buildRawGranolaNotes(
  events: readonly CaptureEvent[],
  observability: GranolaSignalObservability,
): RawGranolaNote[] {
  const grouped = new Map<
    string,
    {
      summary?: CaptureEvent;
      transcript?: CaptureEvent;
      title?: string;
      updated_at?: string;
    }
  >();
  for (const event of events) {
    const noteId = stringMetadata(event, 'note_id');
    const atomType = stringMetadata(event, 'granola_atom_type');
    // Event-level malformed drops. Exclusive first-match: a missing note_id is
    // reported as such (note_id unknown); otherwise an out-of-domain
    // granola_atom_type is reported with the note_id we do have. Preserves the
    // original `noteId === null || atomType invalid` skip, now counted + logged.
    if (noteId === null) {
      observability.malformed_events += 1;
      log.warn('raw_event_malformed', { reason: 'missing_note_id' });
      continue;
    }
    if (atomType !== 'summary' && atomType !== 'transcript') {
      observability.malformed_events += 1;
      log.warn('raw_event_malformed', { reason: 'invalid_granola_atom_type', note_id: noteId });
      continue;
    }
    const entry = grouped.get(noteId) ?? {};
    if (atomType === 'summary') entry.summary = event;
    else entry.transcript = event;
    entry.title = stringMetadata(event, 'title') ?? entry.title;
    entry.updated_at = stringMetadata(event, 'updated_at') ?? entry.updated_at ?? event.timestamp;
    grouped.set(noteId, entry);
  }

  const notes: RawGranolaNote[] = [];
  for (const [noteId, entry] of grouped) {
    // Note-level pairing/dedupe gate. Exclusive first-match precedence mirrors
    // the control flow: pairing completeness (missing_summary → missing_transcript)
    // before dedupe presence (missing_dedupe_key). A multi-defect note counts once.
    if (entry.summary === undefined) {
      observability.skipped_notes.missing_summary += 1;
      log.warn('note_skipped', { reason: 'missing_summary', note_id: noteId });
      continue;
    }
    if (entry.transcript === undefined) {
      observability.skipped_notes.missing_transcript += 1;
      log.warn('note_skipped', { reason: 'missing_transcript', note_id: noteId });
      continue;
    }
    const summaryDedupe = stringMetadata(entry.summary, 'dedupe_key');
    const transcriptDedupe = stringMetadata(entry.transcript, 'dedupe_key');
    if (summaryDedupe === null || transcriptDedupe === null) {
      observability.skipped_notes.missing_dedupe_key += 1;
      log.warn('note_skipped', { reason: 'missing_dedupe_key', note_id: noteId });
      continue;
    }
    notes.push({
      note_id: noteId,
      meeting_title: entry.title ?? 'Untitled Granola note',
      updated_at: entry.updated_at ?? entry.summary.timestamp,
      summary_text: entry.summary.content,
      summary_dedupe_key: summaryDedupe,
      transcript_text: entry.transcript.content,
      transcript_dedupe_key: transcriptDedupe,
      transcript_items: parseRenderedTranscript(entry.transcript.content),
    });
  }
  return notes.sort((a, b) => a.updated_at.localeCompare(b.updated_at));
}

export function parseRenderedTranscript(content: string): GranolaTranscriptItemForExtraction[] {
  const out: GranolaTranscriptItemForExtraction[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    const timed = /^\[([^\]-]+)(?:-([^\]]+))?\]\s*([^:]+):\s*(.*)$/.exec(line);
    if (timed !== null) {
      out.push({
        start_time: parseTranscriptTime(timed[1]!),
        end_time: parseTranscriptTime(timed[2] ?? timed[1]!),
        speaker: timed[3]!.trim(),
        text: timed[4]!.trim(),
      });
      continue;
    }
    const speaker = /^([^:]+):\s*(.*)$/.exec(line);
    out.push({
      start_time: null,
      end_time: null,
      speaker: speaker?.[1]?.trim() ?? 'Speaker',
      text: speaker?.[2]?.trim() ?? line,
    });
  }
  return out;
}

function parseTranscriptTime(value: string): string | number {
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
}

function inputFingerprint(note: RawGranolaNote): string {
  const contentHash = stableHash(`${note.summary_text}\n${note.transcript_text}`);
  return stableHash(
    `${note.note_id}\n${note.updated_at}\n${note.summary_dedupe_key}\n${note.transcript_dedupe_key}\n${contentHash}`,
  );
}

function isSettled(
  note: RawGranolaNote,
  nowIso: string,
  settleMs: number,
  observability: GranolaSignalObservability,
): boolean {
  const updated = new Date(note.updated_at).getTime();
  const now = new Date(nowIso).getTime();
  // Unparsable note updated_at counts as settled (behavior UNCHANGED) — now
  // counted + warned so the foot-gun is visible and deliberate. An unparsable
  // `now` clock also short-circuits to settled but is not a note defect, so it
  // is not counted.
  if (Number.isNaN(updated)) {
    observability.unparsable_updated_at += 1;
    log.warn('unparsable_updated_at', { note_id: note.note_id, updated_at: note.updated_at });
    return true;
  }
  if (Number.isNaN(now)) return true;
  return now - updated >= settleMs;
}

function shouldExtractNote(
  note: RawGranolaNote,
  checkpoint: GranolaSignalCheckpoint,
  currentRuns: Map<string, GranolaSignalRunManifest>,
  extractorVersion: string,
  nowIso: string,
  failureRetryAfterMs: number,
  maxFailureAttempts: number,
): boolean {
  const entry = checkpoint.notes[note.note_id];
  const fingerprint = inputFingerprint(note);
  const hasCurrentRun = currentRuns.has(note.note_id);
  if (
    entry?.input_fingerprint === fingerprint &&
    entry.extractor_version === extractorVersion &&
    entry.last_failure_at !== undefined
  ) {
    const attempts = entry.failure_attempts ?? 1;
    if (attempts >= maxFailureAttempts) return false;
    const retryAfter =
      entry.retry_after_at ??
      new Date(new Date(entry.last_failure_at).getTime() + failureRetryAfterMs).toISOString();
    return new Date(nowIso).getTime() >= new Date(retryAfter).getTime();
  }
  if (!hasCurrentRun) return true;
  return entry?.input_fingerprint !== fingerprint || entry.extractor_version !== extractorVersion;
}

function stableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function validateSignal(signal: GranolaExtractedSignal): void {
  if (
    signal.signal_type !== 'decision' &&
    signal.signal_type !== 'rationale' &&
    signal.signal_type !== 'action'
  ) {
    throw new Error(`unsupported signal_type: ${String(signal.signal_type)}`);
  }
  if (!isNonEmptyString(signal.text)) throw new Error('signal text is required');
  if (!isNonEmptyString(signal.canonical_subject)) {
    throw new Error('signal canonical_subject is required');
  }
  if (!Number.isFinite(signal.confidence) || signal.confidence < 0 || signal.confidence > 1) {
    throw new Error('signal confidence must be between 0 and 1');
  }
  if (signal.source_span.kind === 'transcript') {
    if (!isNonEmptyString(signal.source_span.quote)) {
      throw new Error('transcript source_span.quote is required');
    }
  } else if (signal.source_span.kind !== 'summary') {
    throw new Error('source_span.kind must be summary or transcript');
  }
}

function prepareSignals(
  note: RawGranolaNote,
  signals: readonly GranolaExtractedSignal[],
  opts: {
    extractorVersion: string;
    extractionRunId: string;
    lowConfidenceThreshold: number;
  },
): PreparedSignal[] {
  const prepared: PreparedSignal[] = [];
  const decisionLinks = new Map<string, string>();
  for (const signal of signals) {
    validateSignal(signal);
    const content = signal.text.trim();
    const signalType = signal.signal_type;
    const canonicalSubject = normalizeSubject(signal.canonical_subject);
    const dedupeKey = `granola:signal:${note.note_id}:${opts.extractorVersion}:${signalType}:${stableHash(content)}`;
    const parentDedupeKey =
      signal.source_span.kind === 'summary' ? note.summary_dedupe_key : note.transcript_dedupe_key;
    const metadata: Record<string, unknown> = {
      signal_type: signalType,
      note_id: note.note_id,
      meeting_title: note.meeting_title,
      canonical_subject: canonicalSubject,
      parent_dedupe_key: parentDedupeKey,
      source_span: signal.source_span,
      confidence: signal.confidence,
      extractor_version: opts.extractorVersion,
      extraction_run_id: opts.extractionRunId,
      dedupe_key: dedupeKey,
    };
    if (signal.confidence < opts.lowConfidenceThreshold) metadata['low_confidence'] = true;
    if (signal.owner !== undefined) metadata['owner'] = signal.owner;
    if (signal.decision_status !== undefined) metadata['decision_status'] = signal.decision_status;
    if (signalType === 'decision') {
      decisionLinks.set(content, dedupeKey);
      decisionLinks.set(canonicalSubject, dedupeKey);
      decisionLinks.set(dedupeKey, dedupeKey);
    }
    prepared.push({
      content,
      metadata,
      rationaleLinkTarget: signal.rationale_for,
    });
  }

  for (const signal of prepared) {
    if (signal.metadata['signal_type'] !== 'rationale') continue;
    const target =
      typeof signal.rationaleLinkTarget === 'string'
        ? (decisionLinks.get(signal.rationaleLinkTarget) ?? signal.rationaleLinkTarget)
        : decisionLinks.get(String(signal.metadata['canonical_subject']));
    if (target !== undefined) signal.metadata['rationale_for'] = target;
  }
  return prepared;
}

function parseManifest(event: CaptureEvent): GranolaSignalRunManifest | null {
  const metadata = event.metadata;
  if (metadata === undefined) return null;
  const noteId = metadata['note_id'];
  const extractorVersion = metadata['extractor_version'];
  const extractionRunId = metadata['extraction_run_id'];
  const completedAt = metadata['completed_at'];
  const supersedes = metadata['supersedes'];
  const signalAtomIds = metadata['signal_atom_ids'];
  if (
    !isNonEmptyString(noteId) ||
    !isNonEmptyString(extractorVersion) ||
    !isNonEmptyString(extractionRunId) ||
    !isNonEmptyString(completedAt) ||
    !Array.isArray(signalAtomIds) ||
    !signalAtomIds.every((id) => typeof id === 'string')
  ) {
    return null;
  }
  return {
    note_id: noteId,
    extractor_version: extractorVersion,
    extraction_run_id: extractionRunId,
    completed_at: completedAt,
    supersedes: typeof supersedes === 'string' ? supersedes : null,
    signal_atom_ids: signalAtomIds,
  };
}

export function resolveCurrentGranolaSignalRuns(
  manifestEvents: readonly CaptureEvent[],
): Map<string, GranolaSignalRunManifest> {
  const byNote = new Map<string, GranolaSignalRunManifest[]>();
  const superseded = new Set<string>();
  for (const event of manifestEvents) {
    const manifest = parseManifest(event);
    if (manifest === null) continue;
    const list = byNote.get(manifest.note_id) ?? [];
    list.push(manifest);
    byNote.set(manifest.note_id, list);
    if (manifest.supersedes !== null) superseded.add(manifest.supersedes);
  }

  const out = new Map<string, GranolaSignalRunManifest>();
  for (const [noteId, manifests] of byNote) {
    const current = manifests
      .filter((manifest) => !superseded.has(manifest.extraction_run_id))
      .sort((a, b) => {
        const completed = b.completed_at.localeCompare(a.completed_at);
        if (completed !== 0) return completed;
        return b.extraction_run_id.localeCompare(a.extraction_run_id);
      })[0];
    if (current !== undefined) out.set(noteId, current);
  }
  return out;
}

/**
 * One-call current-run filter (item 115 AC1). Composes the existing
 * {@link resolveCurrentGranolaSignalRuns}: given a window of candidate events
 * and the note's manifest atoms, returns only the events that belong to each
 * note's CURRENT manifest run — superseded-run signals, orphan signals from a
 * failed manifest append, and signals for notes with no manifest at all are
 * excluded. Order-preserving (input order is retained).
 *
 * Non-signal events (`source !== GRANOLA_SIGNAL_SOURCE`) pass through
 * unconditionally: this is the same asymmetric filter search-memories has
 * always applied — a mixed candidate window keeps its non-signal rows and only
 * restricts derived signal atoms to the current run. Resolution is
 * superseded-set construction (single pass, no chain walking), so a supersedes
 * cycle terminates and yields no current run for that note, and a supersedes
 * pointer to a nonexistent run id is inert.
 *
 * Working name in the spec: `filterToCurrentSignalRuns(signalEvents, manifestEvents)`.
 */
export function filterToCurrentSignalRuns(
  candidateEvents: readonly CaptureEvent[],
  manifestEvents: readonly CaptureEvent[],
): CaptureEvent[] {
  const currentRuns = resolveCurrentGranolaSignalRuns(manifestEvents);
  const currentSignalIds = new Set<string>();
  for (const manifest of currentRuns.values()) {
    for (const id of manifest.signal_atom_ids) currentSignalIds.add(id);
  }
  return candidateEvents.filter(
    (event) => event.source !== GRANOLA_SIGNAL_SOURCE || currentSignalIds.has(event.id),
  );
}

function updateCheckpointSuccess(
  checkpoint: GranolaSignalCheckpoint,
  note: RawGranolaNote,
  extractorVersion: string,
  at: string,
): void {
  checkpoint.notes[note.note_id] = {
    input_fingerprint: inputFingerprint(note),
    extractor_version: extractorVersion,
    last_attempted_at: at,
    last_success_at: at,
  };
}

function updateCheckpointFailure(
  checkpoint: GranolaSignalCheckpoint,
  note: RawGranolaNote,
  extractorVersion: string,
  at: string,
  reason: string,
  retryAfterMs: number,
): void {
  const previous = checkpoint.notes[note.note_id];
  const sameInput =
    previous?.input_fingerprint === inputFingerprint(note) &&
    previous.extractor_version === extractorVersion;
  const failureAttempts = sameInput ? (previous.failure_attempts ?? 1) + 1 : 1;
  checkpoint.notes[note.note_id] = {
    input_fingerprint: inputFingerprint(note),
    extractor_version: extractorVersion,
    last_attempted_at: at,
    last_failure_at: at,
    last_failure_reason: reason.slice(0, 200),
    retry_after_at: new Date(new Date(at).getTime() + retryAfterMs).toISOString(),
    failure_attempts: failureAttempts,
  };
}

export async function clearGranolaSignalFailure(
  noteId: string,
  checkpointPath = granolaSignalCheckpointPath(),
): Promise<void> {
  await withGranolaCheckpointLock(checkpointPath, {}, async (lock) => {
    const checkpoint = loadGranolaSignalCheckpoint(checkpointPath);
    const entry = checkpoint.notes[noteId];
    if (entry === undefined || entry.last_failure_at === undefined) return;
    delete checkpoint.notes[noteId];
    await writeGranolaSignalCheckpointLocked(lock, checkpoint);
  });
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function extractWithRetries(
  extractFn: GranolaSignalExtractor,
  note: RawGranolaNote,
  extractorVersion: string,
  maxRetries: number,
  retryDelayMs: number,
): Promise<GranolaExtractedSignal[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await extractFn(
        {
          note_id: note.note_id,
          meeting_title: note.meeting_title,
          updated_at: note.updated_at,
          summary_text: note.summary_text,
          summary_dedupe_key: note.summary_dedupe_key,
          transcript_text: note.transcript_text,
          transcript_dedupe_key: note.transcript_dedupe_key,
          transcript_items: note.transcript_items,
        },
        { extractor_version: extractorVersion },
      );
    } catch (err) {
      lastError = err;
      if (err instanceof GranolaExtractorParseError) throw err;
      if (attempt < maxRetries) await sleep(retryDelayMs * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function runGranolaSignalWorkerOnce(
  storage: Storage,
  extractFn: GranolaSignalExtractor,
  options: GranolaSignalWorkerOptions = {},
): Promise<GranolaSignalWorkerResult> {
  if (
    !isAllowedGranolaDerivedSource(GRANOLA_SIGNAL_SOURCE) ||
    !isAllowedGranolaDerivedSource(GRANOLA_SIGNAL_INDEX_SOURCE)
  ) {
    return {
      status: 'error',
      reason: 'source_not_allowlisted',
      message: 'derived Granola signal sources are not allowlisted',
    };
  }

  const now = options.now ?? (() => new Date().toISOString());
  const checkpointPath = options.checkpointPath ?? granolaSignalCheckpointPath();
  const extractorVersion = options.extractorVersion ?? GRANOLA_SIGNAL_EXTRACTOR_VERSION;
  const settleMs = options.settleMs ?? DEFAULT_GRANOLA_SIGNAL_SETTLE_MS;
  const lowConfidenceThreshold =
    options.lowConfidenceThreshold ?? DEFAULT_GRANOLA_SIGNAL_LOW_CONFIDENCE;
  const maxRetries = options.maxRetries ?? DEFAULT_GRANOLA_SIGNAL_MAX_RETRIES;
  const maxNotesPerTick = options.maxNotesPerTick ?? DEFAULT_GRANOLA_SIGNAL_MAX_NOTES_PER_TICK;
  const retryDelayMs = options.retryDelayMs ?? 1_000;
  const failureRetryAfterMs =
    options.failureRetryAfterMs ?? DEFAULT_GRANOLA_SIGNAL_FAILURE_RETRY_AFTER_MS;
  const maxFailureAttempts =
    options.maxFailureAttempts ?? DEFAULT_GRANOLA_SIGNAL_MAX_FAILURE_ATTEMPTS;

  try {
    return await withGranolaCheckpointLock(
      checkpointPath,
      {
        timeoutMs: options.lockTimeoutMs,
        staleMs: options.lockStaleMs,
        retryMs: options.lockRetryMs,
      },
      async (lock) => {
        let checkpoint: GranolaSignalCheckpoint;
        try {
          checkpoint = loadGranolaSignalCheckpoint(checkpointPath);
        } catch (err) {
          log.error('checkpoint_read_failed', { message: (err as Error).message });
          return { status: 'error', reason: 'checkpoint_failed', message: (err as Error).message };
        }

        const observability = emptyObservability();
        const manifestEvents = await storage.query({ source: GRANOLA_SIGNAL_INDEX_SOURCE });
        const currentRuns = resolveCurrentGranolaSignalRuns(manifestEvents);
        const allRawEvents = await storage.query({ source: GRANOLA_RAW_SOURCE });
        buildRawGranolaNotes(allRawEvents, observability);
        const currentRawAtoms = await resolveCurrentGranolaNotes(storage);
        const rawEvents = [...currentRawAtoms.values()]
          .flatMap((entry) => [entry.summary, entry.transcript])
          .filter((event): event is CaptureEvent => event !== undefined);
        const rawNotes = buildRawGranolaNotes(rawEvents, emptyObservability());
        const nowIso = now();
        const candidates = rawNotes
          .filter(
            (note) => options.targetNoteId === undefined || note.note_id === options.targetNoteId,
          )
          .filter((note) => isSettled(note, nowIso, settleMs, observability))
          .filter((note) =>
            shouldExtractNote(
              note,
              checkpoint,
              currentRuns,
              extractorVersion,
              nowIso,
              failureRetryAfterMs,
              maxFailureAttempts,
            ),
          )
          .slice(0, options.targetNoteId === undefined ? maxNotesPerTick : 1);

        let notesExtracted = 0;
        let signalAtomsWritten = 0;
        let manifestsWritten = 0;
        for (const note of candidates) {
          const extractionRunId = randomUUID();
          const completedAt = now();
          let extracted: GranolaExtractedSignal[];
          try {
            extracted = await extractWithRetries(
              extractFn,
              note,
              extractorVersion,
              maxRetries,
              retryDelayMs,
            );
          } catch (err) {
            const message = (err as Error).message;
            log.error('extraction_failed', { note_id: note.note_id, message });
            updateCheckpointFailure(
              checkpoint,
              note,
              extractorVersion,
              now(),
              message,
              failureRetryAfterMs,
            );
            await writeGranolaSignalCheckpointLocked(lock, checkpoint);
            return { status: 'error', reason: 'extraction_failed', message };
          }

          const prepared = prepareSignals(note, extracted, {
            extractorVersion,
            extractionRunId,
            lowConfidenceThreshold,
          });
          const signalAtomIds: EventId[] = [];
          try {
            for (const signal of prepared) {
              const id = await storage.append({
                source: GRANOLA_SIGNAL_SOURCE,
                timestamp: completedAt,
                content: signal.content,
                metadata: signal.metadata,
              });
              signalAtomIds.push(id);
            }
            signalAtomsWritten += signalAtomIds.length;
            const manifest: GranolaSignalRunManifest = {
              note_id: note.note_id,
              extractor_version: extractorVersion,
              extraction_run_id: extractionRunId,
              completed_at: completedAt,
              supersedes: currentRuns.get(note.note_id)?.extraction_run_id ?? null,
              signal_atom_ids: signalAtomIds,
            };
            await storage.append({
              source: GRANOLA_SIGNAL_INDEX_SOURCE,
              timestamp: completedAt,
              content: JSON.stringify(manifest),
              metadata: {
                manifest_type: 'granola_signal_run',
                ...manifest,
              },
            });
            manifestsWritten += 1;
          } catch (err) {
            const message = (err as Error).message;
            log.error('append_failed', { note_id: note.note_id, message });
            return { status: 'error', reason: 'append_failed', message };
          }

          updateCheckpointSuccess(checkpoint, note, extractorVersion, completedAt);
          try {
            await writeGranolaSignalCheckpointLocked(lock, checkpoint);
          } catch (err) {
            log.error('checkpoint_write_failed', {
              note_id: note.note_id,
              message: (err as Error).message,
            });
            return {
              status: 'error',
              reason: 'checkpoint_failed',
              message: (err as Error).message,
            };
          }
          notesExtracted += 1;
          currentRuns.set(note.note_id, {
            note_id: note.note_id,
            extractor_version: extractorVersion,
            extraction_run_id: extractionRunId,
            completed_at: completedAt,
            supersedes: currentRuns.get(note.note_id)?.extraction_run_id ?? null,
            signal_atom_ids: signalAtomIds,
          });
        }

        log.info('worker_ok', {
          notes_seen: rawNotes.length,
          notes_extracted: notesExtracted,
          signal_atoms_written: signalAtomsWritten,
          manifests_written: manifestsWritten,
          observability,
        });
        return {
          status: 'ok',
          notes_seen: rawNotes.length,
          notes_extracted: notesExtracted,
          signal_atoms_written: signalAtomsWritten,
          manifests_written: manifestsWritten,
          observability,
        };
      },
    );
  } catch (err) {
    if ((err as Error).name !== 'GranolaCheckpointError') throw err;
    log.error('checkpoint_lock_failed', { message: (err as Error).message });
    return { status: 'error', reason: 'checkpoint_failed', message: (err as Error).message };
  }
}

export function computeGranolaSignalBrainTimeoutMs(base: number, promptChars: number): number {
  const scaled = base + 1000 * Math.max(0, Math.ceil(promptChars / 1024) - 1);
  return Math.min(Math.max(scaled, base), GRANOLA_SIGNAL_BRAIN_TIMEOUT_CAP_MS);
}

export function buildExtractionPrompt(input: GranolaSignalExtractionInput): string {
  const promptInput = {
    note_id: input.note_id,
    meeting_title: input.meeting_title,
    updated_at: input.updated_at,
    summary_text: input.summary_text,
    summary_dedupe_key: input.summary_dedupe_key,
    transcript_text: input.transcript_text,
    transcript_dedupe_key: input.transcript_dedupe_key,
  };
  return [
    'Extract Granola meeting signals as JSON only.',
    'Return {"signals":[...]} with only decision, rationale, and action signal_type values.',
    'Every signal must include text, canonical_subject, source_span, and confidence.',
    'Action signals must include owner when the speaker assigns or implies one; omit owner only when unassigned.',
    // Item 118 AC2: pin the canonical_subject shape so cross-meeting subjects
    // vary less. normalizeSubject remains the authority; this only reduces
    // variance at the source.
    'canonical_subject must be a space-separated lowercase noun phrase — no snake_case, no camelCase, no underscores or hyphens.',
    'Use only the meeting content below; do not infer rationale that was not said.',
    '',
    JSON.stringify(promptInput, null, 2),
  ].join('\n');
}

function extractJsonCandidate(answer: string): string {
  let text = answer.trim();
  const fence = /^```(?:json|JSON)?\s*\n([\s\S]*?)\n```\s*$/.exec(text);
  if (fence !== null) text = fence[1]!.trim();
  const firstObject = text.indexOf('{');
  const firstArray = text.indexOf('[');
  const starts = [firstObject, firstArray].filter((index) => index >= 0).sort((a, b) => a - b);
  if (starts.length === 0) return text;
  const start = starts[0]!;
  const end = text[start] === '{' ? text.lastIndexOf('}') : text.lastIndexOf(']');
  return end >= start ? text.slice(start, end + 1).trim() : text;
}

export function parseExtractorAnswer(answer: string): GranolaExtractedSignal[] {
  let parsed: unknown;
  try {
    parsed = parseJson(extractJsonCandidate(answer));
  } catch (err) {
    throw new GranolaExtractorParseError(
      `extractor returned invalid JSON: ${(err as Error).message}`,
    );
  }
  const signals = Array.isArray(parsed)
    ? parsed
    : isPlainObject(parsed) && Array.isArray(parsed['signals'])
      ? parsed['signals']
      : null;
  if (signals === null)
    throw new GranolaExtractorParseError('extractor returned invalid JSON signal list');
  try {
    return signals.map(parseExtractedSignal);
  } catch (err) {
    throw new GranolaExtractorParseError((err as Error).message);
  }
}

function parseExtractedSignal(value: unknown): GranolaExtractedSignal {
  if (!isPlainObject(value)) throw new Error('extractor signal must be an object');
  const signal = {
    signal_type: value['signal_type'],
    text: value['text'],
    canonical_subject: value['canonical_subject'],
    source_span: value['source_span'],
    confidence: value['confidence'],
    owner: value['owner'],
    rationale_for: value['rationale_for'],
    decision_status: value['decision_status'],
  };
  const out: GranolaExtractedSignal = {
    signal_type: signal.signal_type as GranolaSignalType,
    text: String(signal.text ?? ''),
    canonical_subject: String(signal.canonical_subject ?? ''),
    source_span: isPlainObject(signal.source_span)
      ? (signal.source_span as unknown as GranolaSignalSourceSpan)
      : { kind: 'summary' },
    confidence: typeof signal.confidence === 'number' ? signal.confidence : Number.NaN,
  };
  if (typeof signal.owner === 'string') out.owner = signal.owner;
  if (typeof signal.rationale_for === 'string') out.rationale_for = signal.rationale_for;
  if (
    signal.decision_status === 'proposed' ||
    signal.decision_status === 'decided' ||
    signal.decision_status === 'unresolved'
  ) {
    out.decision_status = signal.decision_status;
  }
  validateSignal(out);
  return out;
}

/** Item 120 AC2: map a completed run to its heartbeat. An `ok` tick reports the
 *  115 observability block (flattened into the worker-agnostic numeric counters
 *  map) alongside notes_seen/notes_extracted/signal_atoms_written. A
 *  `brain_unavailable` skip (the lazy-preflight miss — exactly the f19dc419
 *  silent-brain-down class) is `degraded`, NOT healthy. A `disabled` skip
 *  (stopped) is `disabled`; an `in_flight` skip is `ok`; an `error` is
 *  `degraded` with the error message. */
function granolaSignalHeartbeat(
  result: GranolaSignalWorkerResult,
  lastTickAt: string,
): WorkerHeartbeat {
  if (result.status === 'ok') {
    const o = result.observability;
    return {
      schema_version: 1,
      worker: GRANOLA_SIGNALS_WORKER,
      last_tick_at: lastTickAt,
      status: 'ok',
      counters: {
        notes_seen: result.notes_seen,
        notes_extracted: result.notes_extracted,
        signal_atoms_written: result.signal_atoms_written,
        skipped_missing_summary: o.skipped_notes.missing_summary,
        skipped_missing_transcript: o.skipped_notes.missing_transcript,
        skipped_missing_dedupe_key: o.skipped_notes.missing_dedupe_key,
        malformed_events: o.malformed_events,
        unparsable_updated_at: o.unparsable_updated_at,
      },
    };
  }
  if (result.status === 'skipped') {
    if (result.reason === 'brain_unavailable') {
      return {
        schema_version: 1,
        worker: GRANOLA_SIGNALS_WORKER,
        last_tick_at: lastTickAt,
        status: 'degraded',
        reason: 'brain unavailable: lazy preflight missed this tick',
      };
    }
    return {
      schema_version: 1,
      worker: GRANOLA_SIGNALS_WORKER,
      last_tick_at: lastTickAt,
      status: result.reason === 'disabled' ? 'disabled' : 'ok',
      ...(result.reason === 'disabled' ? { reason: 'worker stopped' } : {}),
    };
  }
  return {
    schema_version: 1,
    worker: GRANOLA_SIGNALS_WORKER,
    last_tick_at: lastTickAt,
    status: 'degraded',
    reason: result.message,
  };
}

export async function startGranolaSignalWorker(
  storage: Storage,
  options: GranolaSignalWorkerOptions = {},
): Promise<GranolaSignalWorkerHandle> {
  let extractFn: GranolaSignalExtractor | null = options.extractFn ?? null;
  const compatibilityAdapter: GranolaSignalAdapter | undefined =
    options.preflight === undefined
      ? undefined
      : {
          id: 'injected-preflight-only',
          preflight: options.preflight,
          extract: async () => {
            throw new Error('Granola signal extractor dependency is unavailable');
          },
        };
  const adapter = options.adapter ?? compatibilityAdapter;
  if (extractFn === null && adapter === undefined) {
    const reason = 'Granola signal extractor and adapter health dependencies are required';
    log.error('disabled', { reason });
    writeWorkerHeartbeat(
      GRANOLA_SIGNALS_WORKER,
      {
        schema_version: 1,
        worker: GRANOLA_SIGNALS_WORKER,
        last_tick_at: new Date().toISOString(),
        status: 'disabled',
        reason,
      },
      options.heartbeatPath,
    );
    return {
      enabled: false,
      run: async () => ({ status: 'skipped', reason: 'disabled' }),
      stop: async () => {},
    };
  }
  const nowFn = options.now ?? (() => new Date().toISOString());

  // Brain preflight is LAZY with per-tick retry. Probing at boot raced the
  // daemon's capture boot-scan: event-loop saturation delays the child-exit
  // event past the probe timer, so an instant `--version` reads as a spurious
  // timeout and the worker used to disable itself permanently (zero signals
  // in prod since June). Config PARSE errors above remain a permanent
  // disable; only availability probing retries, once per tick.
  async function ensureExtractFn(): Promise<GranolaSignalExtractor | null> {
    if (extractFn !== null) return extractFn;
    try {
      await adapter!.preflight();
    } catch (err) {
      log.warn('adapter_preflight_failed_will_retry', {
        adapter: adapter!.id,
        reason: (err as Error).message,
      });
      return null;
    }
    extractFn = adapter!.extract;
    log.info('adapter_preflight_ok', { adapter: adapter!.id });
    return extractFn;
  }

  const workerIntervalMs = options.workerIntervalMs ?? DEFAULT_GRANOLA_SIGNAL_WORKER_INTERVAL_MS;
  const runOnStart = options.runOnStart ?? true;
  let stopped = false;
  let inFlight: Promise<GranolaSignalWorkerResult> | null = null;

  async function runInner(): Promise<GranolaSignalWorkerResult> {
    if (stopped) return { status: 'skipped', reason: 'disabled' };
    if (inFlight !== null) {
      log.warn('worker_skipped_in_flight', {});
      return { status: 'skipped', reason: 'in_flight' };
    }
    // inFlight must be assigned synchronously after the check above — an
    // await in between would let two concurrent run() calls both pass the
    // gate (the in-flight contract the concurrency test pins). The lazy
    // preflight therefore happens INSIDE the tracked promise.
    inFlight = (async (): Promise<GranolaSignalWorkerResult> => {
      const fn = await ensureExtractFn();
      if (fn === null) return { status: 'skipped', reason: 'brain_unavailable' };
      return runGranolaSignalWorkerOnce(storage, fn, options);
    })();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  // Item 120 AC2: write a heartbeat at the end of every run(). A
  // `brain_unavailable` tick maps to `degraded` here so a silent brain outage
  // (the f19dc419 class) is no longer indistinguishable from a quiet day.
  async function run(): Promise<GranolaSignalWorkerResult> {
    const result = await runInner();
    writeWorkerHeartbeat(
      GRANOLA_SIGNALS_WORKER,
      granolaSignalHeartbeat(result, nowFn()),
      options.heartbeatPath,
    );
    return result;
  }

  const interval = setInterval(() => {
    void run().catch((err: unknown) => {
      log.error('handler_error', { message: (err as Error).message });
    });
  }, workerIntervalMs);
  interval.unref();

  if (runOnStart) {
    void run().catch((err: unknown) => {
      log.error('handler_error', { message: (err as Error).message });
    });
  }

  log.info('started', {
    worker_interval_ms: workerIntervalMs,
    checkpoint_path: options.checkpointPath ?? granolaSignalCheckpointPath(),
  });

  return {
    enabled: true,
    run,
    stop: async () => {
      stopped = true;
      clearInterval(interval);
      if (inFlight !== null) await inFlight.catch(() => ({ status: 'error' }));
      log.info('stopped', {});
    },
  };
}
