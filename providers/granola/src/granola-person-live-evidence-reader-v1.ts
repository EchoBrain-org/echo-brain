import { randomUUID } from 'node:crypto';
import { canonicalSha256, sha256Digest } from '@echo-brain/federation-protocol';
import { PERSON_EVIDENCE_RESPONSE_MAX_BYTES_V1, validatePersonPageCitationV1, type PersonPageCitationV1 } from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonLiveEvidenceReaderV1, PersonLiveEvidenceValueV1, PersonLiveEvidencePageV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { validateEvidenceDateFilterV1, matchesEvidenceDateV1, type EvidenceDateFilterV1 } from '@echo-brain/organization-authority-kernel/shared/temporal-query-v1';
import type { PersonProviderAuthenticatedFetchV1 } from '@echo-brain/provider-runtime/person-provider-json-transport-v1';
import { createGranolaMcpV1, GRANOLA_PERSON_PROVIDER_V1, GRANOLA_ID_V1, type GranolaMeetingV1 } from './granola-mcp-v1.js';

const fail: typeof GRANOLA_PERSON_PROVIDER_V1.failure = GRANOLA_PERSON_PROVIDER_V1.failure;
// At most 2,400 UTF-8 bytes, including four-byte characters; the evidence contract allows 3 KiB.
const SECTION = 600;
const INDEX_NOTICE = 'Granola transcript search uses a live index that can lag. No matching passage does not prove a topic was never discussed.';
const LEFT_OUT = 'Some Granola folders mapped to this project are not visible to your Granola account, so these results leave out their meetings.';
function notice(...parts: readonly (string | false)[]): { notice?: string } {
  const text = parts.filter(Boolean).join(' ');
  return text === '' ? {} : { notice: text };
}
type Value = PersonLiveEvidenceValueV1<PersonPageCitationV1>;
type Cursor = { selection: string; folder: number; cursor?: string };
function metadata(meeting: GranolaMeetingV1) {
  return { id: meeting.id, title: meeting.title, date: meeting.date, occurred: meeting.meeting_at ?? meeting.created_at ?? null };
}
function dates(meeting: GranolaMeetingV1) {
  const occurred = meeting.meeting_at ?? meeting.created_at;
  return occurred === undefined ? {} : { occurred: new Date(occurred).toISOString() };
}
/** The transcript index lags the live notes: a hit whose meeting is gone or whose transcript moved on is skipped. */
async function lagging<T>(read: Promise<T>): Promise<T | undefined> {
  try { return await read; } catch (error) {
    if (error instanceof AuthorityOperationError && (error.code === 'not_found' || error.code === 'stale_access_state')) return undefined;
    throw error;
  }
}
function size(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) fail('invalid_request');
  return Math.min(limit, 20);
}
/** A search honours the limit it is asked for, up to the 50 one request allows, across passages, notes and summaries. */
function searchSize(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) fail('invalid_request');
  return limit;
}
/** Slices one transcript passage contributes, so one long chunk never crowds out other meetings' passages. */
const SLICES_PER_PASSAGE = 2;
/** Granola's largest transcript-search page. */
const TRANSCRIPT_SEARCH_MAX = 20;
/**
 * The search page's released bytes stay under the shared 64 KiB result bound with room for the wrapper's ids and
 * receipts; the rest is left out with `truncated`, never failing the page.
 */
const SEARCH_RESULT_BYTES = PERSON_EVIDENCE_RESPONSE_MAX_BYTES_V1 - 8 * 1024;
const ITEM_OVERHEAD_BYTES = 256;
/**
 * Provider calls one request may make for search, list and open, and for all calls including the connection checks and
 * revalidation that fence every release: the first ends a read with what it found and BUDGET_NOTICE, the second stops a
 * runaway loop.
 */
const MAX_CONTENT_CALLS = 2_400;
const MAX_CALLS = 24_000;
const BUDGET_NOTICE = 'This research run has made as many Granola reads as one run may; Granola results past them were left out.';

/** Request-memory only. Raw notes and transcripts remain in Granola; receipts contain coordinates and digests. */
export async function createGranolaPersonLiveEvidenceReaderV1(options: {
  readonly transport: PersonProviderAuthenticatedFetchV1; readonly folder_ids?: readonly string[]; readonly signal?: AbortSignal;
}): Promise<PersonLiveEvidenceReaderV1<PersonPageCitationV1>> {
  const binding = GRANOLA_PERSON_PROVIDER_V1.copyBinding(options.transport.binding);
  const folders = options.folder_ids === undefined ? undefined : [...options.folder_ids];
  if (folders !== undefined && (folders.length < 1 || folders.length > 20 || folders.some(id => !GRANOLA_ID_V1.test(id)))) fail('invalid_request');
  let calls = 0, contentCalls = 0;
  /** Set once the content budget ran out: a search, list or open then ends with what it found and BUDGET_NOTICE. */
  let spent = false;
  const now = new Date().toISOString();
  const counted = (content: boolean) => createGranolaMcpV1({ binding, async fetch(url, init) {
    options.signal?.throwIfAborted();
    if (content && ++contentCalls > MAX_CONTENT_CALLS) spent = true;
    if (++calls > MAX_CALLS || (content && spent)) fail('unavailable');
    return options.transport.fetch(url, init);
  } });
  /** Search, list and open reads. */
  const api = counted(true);
  /** Connection checks and revalidation, which fence every release and so still run once the content budget is spent. */
  const fences = counted(false);
  /** A read that ran out of the content budget: nothing more from it, said so. */
  async function budgeted(signal: AbortSignal | undefined, operation: () => Promise<PersonLiveEvidencePageV1<PersonPageCitationV1>>): Promise<PersonLiveEvidencePageV1<PersonPageCitationV1>> {
    try { return await operation(); } catch (error) {
      signal?.throwIfAborted();
      if (spent) return { items: [], truncated: true, notice: BUDGET_NOTICE };
      throw error;
    }
  }
  const issued = new Map<string, Value>(), handles = new Map<string, Value>(), cursors = new Map<string, Cursor>();
  // Project members can see different Granola folders: the reader works over the mapped folders this asker sees.
  let shown = folders;
  async function verify(signal?: AbortSignal, initial = false) {
    const account = await fences.account(signal);
    if (account.workspace_id !== binding.external_scope_id || account.email !== binding.external_subject_id) fail('stale_access_state');
    if (folders !== undefined) {
      const accessible = new Set((await fences.folders(signal)).map(folder => folder.id)), before = shown!;
      shown = folders.filter(id => accessible.has(id));
      // Results read from a folder that has since gone out of sight are not released.
      if (!initial && before.some(id => !accessible.has(id))) fail('unauthorized');
    }
  }
  await verify(options.signal, true);
  const leftOut = () => shown !== undefined && shown.length < folders!.length && LEFT_OUT;
  function remember(meeting: GranolaMeetingV1, section: string, version: string, text?: string): Value {
    const citation = validatePersonPageCitationV1({ kind: 'page', tool_id: 'granola', external_scope_id: binding.external_scope_id,
      page_id: meeting.id, section_id: section, version, permalink: meeting.url, text_sha256: sha256Digest(text ?? '') });
    const handle = randomUUID();
    const value: Value = Object.freeze({ citation, handle, label: meeting.title ?? 'Untitled meeting', visibility: 'only_me',
      ...(text === undefined ? {} : { text }), dates: dates(meeting),
      ...(dates(meeting).occurred === undefined ? {} : { occurred_at: dates(meeting).occurred!.slice(0, 10), date_kind: 'occurred' as const }),
    });
    issued.set(canonicalSha256(citation), value); handles.set(handle, value);
    return value;
  }
  function inventory(meeting: GranolaMeetingV1) { return remember(meeting, 'inventory', canonicalSha256(metadata(meeting))); }
  function citation(value: unknown): PersonPageCitationV1 {
    let parsed: PersonPageCitationV1;
    try { parsed = validatePersonPageCitationV1(value); } catch { return fail('invalid_request'); }
    if (parsed.tool_id !== 'granola' || parsed.external_scope_id !== binding.external_scope_id || !GRANOLA_ID_V1.test(parsed.page_id)
      || parsed.permalink !== `https://notes.granola.ai/d/${parsed.page_id}` || !/^(?:inventory|(?:notes|summary):(?:0|[1-9]\d{0,5})|transcript:(?:0|[1-9]\d{0,5}):(?:0|[1-9]\d{0,5}))$/.test(parsed.section_id)) fail('invalid_request');
    return parsed;
  }
  let membership: { readonly key: string; readonly ids: ReadonlySet<string> } | undefined;
  /**
   * Bound folder membership never comes from an import setting. It is read once per reader for search and open, and
   * re-read by every revalidation, the release fence, including when reopening an old answer.
   */
  async function members(signal?: AbortSignal, fresh = false, via = api): Promise<ReadonlySet<string> | undefined> {
    if (shown === undefined) return undefined;
    const key = shown.join();
    if (!fresh && membership?.key === key) return membership.ids;
    const ids = new Set<string>();
    for (const folder_id of shown) {
      const seen = new Set<string>();
      for (let cursor: string | undefined;;) {
        const page = await via.search({ folder_id, from_date: '1970-01-01', to_date: now, limit: 100, ...(cursor === undefined ? {} : { cursor }), signal });
        page.meetings.forEach(meeting => ids.add(meeting.id));
        // A bounded read must never assert that a partial folder is its full contents.
        if (ids.size > 1_000 || page.incomplete) fail('unavailable');
        if (page.next_cursor === null) break;
        if (seen.has(page.next_cursor) || seen.size >= 20) fail('invalid_output');
        seen.add(page.next_cursor); cursor = page.next_cursor;
      }
    }
    membership = { key, ids };
    return ids;
  }
  function scope(meeting: string, allowed: ReadonlySet<string> | undefined) {
    if (allowed !== undefined && !allowed.has(meeting)) fail('unauthorized');
  }
  /** `reads` holds one revalidation's provider reads, so many sections of one meeting or chunk cost one read each. */
  async function section(ref: PersonPageCitationV1, allowed: ReadonlySet<string> | undefined, reads: Map<string, Promise<unknown>>, signal?: AbortSignal): Promise<Value> {
    const once = <T>(key: string, read: () => Promise<T>) => {
      if (!reads.has(key)) reads.set(key, read());
      return reads.get(key) as Promise<T>;
    };
    scope(ref.page_id, allowed);
    const meeting = await once(`meeting:${ref.page_id}`, () => fences.meeting(ref.page_id, signal));
    if (ref.section_id === 'inventory') return inventory(meeting);
    const [kind, raw, part] = ref.section_id.split(':'), offset = Number(kind === 'transcript' ? part : raw);
    if (offset % SECTION !== 0) fail('invalid_request');
    if (kind === 'transcript') {
      const chunk = await once(JSON.stringify([meeting.id, Number(raw), ref.version]), () => fences.chunk(meeting.id, Number(raw), ref.version, signal));
      if (offset >= [...chunk.text].length) fail('not_found');
      return remember(meeting, ref.section_id, chunk.version, [...chunk.text].slice(offset, offset + SECTION).join(''));
    }
    const text = kind === 'notes' ? meeting.private_notes ?? '' : meeting.summary ?? '';
    if (offset >= [...text].length && offset !== 0) fail('not_found');
    return remember(meeting, ref.section_id, canonicalSha256({ metadata: metadata(meeting), text }), [...text].slice(offset, offset + SECTION).join(''));
  }
  function range(input: EvidenceDateFilterV1) {
    validateEvidenceDateFilterV1(input, ['occurred', 'any']);
    // Fetch a wider UTC window, then apply the exact requested timezone locally.
    const shift = (day: string, delta: number) => new Date(Date.parse(`${day}T12:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);
    // Granola reads a bare date as that whole day, so a bare end date of today or later would reach past now.
    const until = input.until === undefined ? undefined : shift(input.until, 1);
    return { from_date: input.since === undefined ? '1970-01-01' : shift(input.since, -1), to_date: until === undefined || until >= now.slice(0, 10) ? now : until };
  }
  const matches = (meeting: GranolaMeetingV1, input: EvidenceDateFilterV1) => matchesEvidenceDateV1(dates(meeting), input, 'occurred');
  /**
   * A transcript chunk's slices that name a search term, most terms first, ties in reading order. When none names one
   * (Granola's index can match a form the words do not show), the chunk's single best slice stands for the passage.
   */
  function matchingSlices(text: string, terms: readonly string[]): readonly { readonly offset: number; readonly text: string }[] {
    const characters = [...text], slices: { offset: number; text: string; score: number }[] = [];
    for (let offset = 0; offset < characters.length; offset += SECTION) {
      const body = characters.slice(offset, offset + SECTION).join('');
      if (body.trim()) slices.push({ offset, text: body, score: terms.filter(term => body.toLowerCase().includes(term)).length });
    }
    const ranked = slices.map((slice, index) => ({ slice, index })).sort((left, right) => right.slice.score - left.slice.score || left.index - right.index).map(entry => entry.slice);
    const named = ranked.filter(slice => slice.score > 0);
    return named.length > 0 ? named : ranked.slice(0, 1);
  }
  function sections(meeting: GranolaMeetingV1, kind: string, text: string, version: string, start = 0): Value[] {
    const characters = [...text], items: Value[] = [];
    if (start >= characters.length && start !== 0) fail('not_found');
    for (let offset = start; offset < characters.length; offset += SECTION) {
      const body = characters.slice(offset, offset + SECTION).join('');
      if (body.trim()) items.push(remember(meeting, `${kind}:${offset}`, version, body));
    }
    return items;
  }
  async function open(ref: PersonPageCitationV1, limit: number, signal?: AbortSignal): Promise<PersonLiveEvidencePageV1<PersonPageCitationV1>> {
    const allowed = await members(signal); scope(ref.page_id, allowed);
    if (ref.section_id !== 'inventory') {
      const meeting = await api.meeting(ref.page_id, signal);
      const [kind, raw, part] = ref.section_id.split(':');
      const offset = Number(kind === 'transcript' ? part : raw);
      if (offset % SECTION !== 0) fail('invalid_request');
      const chunk = kind === 'transcript' ? await api.chunk(meeting.id, Number(raw), ref.version, signal) : undefined;
      const text = chunk?.text ?? (kind === 'notes' ? meeting.private_notes ?? '' : meeting.summary ?? '');
      const version = chunk?.version ?? canonicalSha256({ metadata: metadata(meeting), text });
      const items = sections(meeting, kind === 'transcript' ? `transcript:${raw}` : kind!, text, version, offset);
      await verify(signal);
      return { items: items.slice(0, size(limit)), truncated: items.length > size(limit), anchor_truncated: items.length > size(limit) };
    }
    const meeting = await api.meeting(ref.page_id, signal), items: Value[] = [];
    for (const [kind, text] of [['notes', meeting.private_notes ?? ''], ['summary', meeting.summary ?? '']] as const) {
      items.push(...sections(meeting, kind, text, canonicalSha256({ metadata: metadata(meeting), text })));
    }
    await verify(signal);
    return { items: items.slice(0, size(limit)), truncated: items.length > size(limit), anchor_truncated: items.length > size(limit),
      notice: 'These are meeting notes and summaries. Search the transcript for what was said, decided, or assigned.' };
  }
  return Object.freeze<PersonLiveEvidenceReaderV1<PersonPageCitationV1>>({ binding,
    validateCitation(value) {
      const ref = citation(value);
      if (!issued.has(canonicalSha256(ref))) fail('invalid_request');
      return { citation: ref, tool_id: 'granola', external_scope_id: binding.external_scope_id, coordinates: { object_id: `${ref.page_id}:${ref.section_id}:${ref.version}` } };
    },
    async list(input) {
      const limit = size(input.limit), window = range(input);
      if (input.container !== undefined && (!GRANOLA_ID_V1.test(input.container) || (folders !== undefined && !folders.includes(input.container)))) fail('invalid_request');
      const selected = input.container === undefined ? shown ?? [undefined] : shown === undefined || shown.includes(input.container) ? [input.container] : [];
      if (selected.length === 0) { await verify(input.signal); return { items: [], truncated: false, page_full: false, ...notice(LEFT_OUT) }; }
      const selection = canonicalSha256({ selected: selected.map(id => id ?? null), window, limit, date_field: input.date_field ?? null, time_zone: input.time_zone ?? null });
      const previous = input.cursor === undefined ? undefined : cursors.get(input.cursor);
      if (input.cursor !== undefined && (previous === undefined || previous.selection !== selection)) fail('invalid_request');
      const index = previous?.folder ?? 0, folder_id = selected[index];
      return budgeted(input.signal, async () => {
        const page = await api.search({ ...window, limit, ...(folder_id === undefined ? {} : { folder_id }), ...(previous?.cursor === undefined ? {} : { cursor: previous.cursor }), signal: input.signal });
        if (page.next_cursor !== null && page.next_cursor === previous?.cursor) fail('invalid_output');
        let next_cursor: string | undefined;
        if (page.next_cursor !== null || index + 1 < selected.length) {
          next_cursor = randomUUID(); cursors.set(next_cursor, { selection, folder: page.next_cursor === null ? index + 1 : index, ...(page.next_cursor === null ? {} : { cursor: page.next_cursor }) });
        }
        await verify(input.signal);
        return { items: page.meetings.filter(meeting => matches(meeting, input)).map(inventory), truncated: next_cursor !== undefined || page.incomplete === true,
          ...(next_cursor === undefined ? {} : { next_cursor }), page_full: page.meetings.length === limit,
          ...notice(page.incomplete === true && 'Granola could not finish this listing. Narrow the date range.', leftOut()) };
      });
    },
    async search(input) {
      const limit = searchSize(input.limit), window = range(input), items: Value[] = [], passages: Value[] = [];
      const terms = input.query.toLowerCase().split(/\s+/u).filter(Boolean);
      let truncated = false, transcriptLost: 'unauthorized' | 'unavailable' | undefined, budget = false;
      try {
        for (const folder_id of shown ?? [undefined]) {
          const page = await api.search({ ...window, query: input.query, limit, ...(folder_id === undefined ? {} : { folder_id }), signal: input.signal });
          items.push(...page.meetings.filter(meeting => matches(meeting, input)).map(inventory));
          truncated ||= page.next_cursor !== null || page.incomplete === true;
        }
        const allowed = await members(input.signal), ids = allowed === undefined ? undefined : [...allowed];
        for (let offset = 0; ids === undefined ? offset === 0 : offset < ids.length; offset += 100) {
          if (passages.length >= limit) { truncated = true; break; }
          let page;
          try { page = await api.searchTranscripts({ ...window, query: input.query, limit: Math.min(limit, TRANSCRIPT_SEARCH_MAX), ...(ids === undefined ? {} : { meeting_ids: ids.slice(offset, offset + 100) }), signal: input.signal }); }
          catch (error) {
            if (spent) throw error;
            // Notes and transcripts can have different provider permissions, and Granola reports a failed tool call as an
            // MCP error, not an HTTP status. Either way the notes results stand; transcript search is never retried through another tool.
            if (!(error instanceof AuthorityOperationError) || !['unauthorized', 'unavailable', 'rate_limited'].includes(error.code)) throw error;
            transcriptLost = error.code === 'unauthorized' ? 'unauthorized' : 'unavailable'; truncated = true; break;
          }
          truncated ||= page.next_cursor !== null || page.incomplete;
          for (const match of page.meetings) {
            if (passages.length >= limit) { truncated = true; break; }
            scope(match.meeting_id, allowed);
            const meeting = await lagging(api.meeting(match.meeting_id, input.signal));
            if (meeting === undefined) { truncated = true; continue; }
            if (!matches(meeting, input)) continue;
            for (const passage of match.passages) {
              if (passages.length >= limit) { truncated = true; break; }
              const chunk = await lagging(api.chunk(meeting.id, passage.chunk_id, match.version, input.signal));
              if (chunk === undefined) { truncated = true; continue; }
              const found = matchingSlices(chunk.text, terms);
              const kept = found.slice(0, Math.min(SLICES_PER_PASSAGE, limit - passages.length));
              passages.push(...kept.map(slice => remember(meeting, `transcript:${passage.chunk_id}:${slice.offset}`, chunk.version, slice.text)));
              truncated ||= found.length > kept.length;
            }
          }
        }
      } catch (error) {
        input.signal?.throwIfAborted();
        if (!spent) throw error;
        budget = true; truncated = true;
      }
      // Passages and notes or summary hits alternate, so neither crowds the other out of the limit.
      const merged = new Map<string, Value>();
      for (let index = 0; index < Math.max(passages.length, items.length); index += 1) {
        for (const value of [passages[index], items[index]]) if (value !== undefined) merged.set(canonicalSha256(value.citation), merged.get(canonicalSha256(value.citation)) ?? value);
      }
      const released: Value[] = [];
      let bytes = 0;
      for (const value of [...merged.values()].slice(0, limit)) {
        const { handle: _handle, ...shown } = value;
        bytes += Buffer.byteLength(JSON.stringify(shown), 'utf8') + ITEM_OVERHEAD_BYTES;
        if (bytes > SEARCH_RESULT_BYTES) break;
        released.push(value);
      }
      await verify(input.signal);
      return { items: released, truncated: truncated || merged.size > released.length,
        ...notice(leftOut(), transcriptLost === 'unauthorized' ? 'Granola did not allow transcript search. These results cover accessible notes only; they cannot establish what was said in a transcript.'
          : transcriptLost === 'unavailable' ? 'Granola could not complete transcript search. These results cover notes only; they cannot establish what was said in a transcript.' : INDEX_NOTICE,
        budget && BUDGET_NOTICE) };
    },
    async open(input) {
      const item = handles.get(input.handle); if (item === undefined) fail('invalid_request');
      return budgeted(input.signal, () => open(item.citation, input.limit, input.signal));
    },
    async openCitation(input) { const ref = citation(input.citation); return budgeted(input.signal, () => open(ref, input.limit, input.signal)); },
    async revalidate(input) {
      const allowed = input.citations.length === 0 ? undefined : await members(input.signal, true, fences), reads = new Map<string, Promise<unknown>>();
      for (const value of input.citations) {
        const ref = citation(value), original = issued.get(canonicalSha256(ref));
        if (original === undefined) fail('invalid_request');
        const current = await section(ref, allowed, reads, input.signal);
        if (canonicalSha256(current.citation) !== canonicalSha256(ref) || current.label !== original.label) fail('stale_access_state');
      }
      await verify(input.signal);
    },
  });
}
