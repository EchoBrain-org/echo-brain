import { randomUUID } from 'node:crypto';
import { canonicalSha256, sha256Digest } from '@echo-brain/federation-protocol';
import { PERSON_EVIDENCE_LABEL_MAX_BYTES_V1, validatePersonPageCitationV1, type PersonPageCitationV1 } from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonLiveEvidenceReaderV1, PersonLiveEvidenceValueV1, PersonLiveEvidencePageV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { validateEvidenceDateFilterV1, matchesEvidenceDateV1, type EvidenceDateFilterV1 } from '@echo-brain/organization-authority-kernel/shared/temporal-query-v1';
import type { PersonProviderAuthenticatedFetchV1 } from '@echo-brain/provider-runtime/person-provider-json-transport-v1';
import { boundUtf8V1, createPersonLiveListV1, personLiveEvidencePageFitV1 as fit } from '@echo-brain/provider-runtime/person-provider-v1';
import { createGranolaMcpV1, GRANOLA_PERSON_PROVIDER_V1, GRANOLA_ID_V1, type GranolaMeetingV1 } from './granola-mcp-v1.js';

const fail: typeof GRANOLA_PERSON_PROVIDER_V1.failure = GRANOLA_PERSON_PROVIDER_V1.failure;
/**
 * A released slice of notes, a summary or a transcript chunk, in characters: at most 2,400 UTF-8 bytes. Not a limit on
 * what is read: every slice of a text is reachable, and an open continues from any slice it released.
 */
const SECTION = 600;
const INDEX_NOTICE = 'Granola transcript search uses a live index that can lag. No matching passage does not prove a topic was never discussed.';
const LEFT_OUT = 'Some Granola folders mapped to this project are not visible to your Granola account, so these results leave out their meetings.';
function notice(...parts: readonly (string | false)[]): { notice?: string } {
  const text = parts.filter(Boolean).join(' ');
  return text === '' ? {} : { notice: text };
}
type Value = PersonLiveEvidenceValueV1<PersonPageCitationV1>;
/** Where a list stands: the mapped folder it reads, and Granola's cursor in it. */
type ListState = { readonly folder: number; readonly cursor?: string };
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
/** Any positive limit: a read releases as many items as are asked for and one result carries. */
function size(limit: number) {
  if (!Number.isInteger(limit) || limit < 1) fail('invalid_request');
  return limit;
}
/** Granola's largest meeting page and transcript-search page, and the most meetings one transcript search may name. */
const MEETING_PAGE_MAX = 100;
const TRANSCRIPT_SEARCH_MAX = 20;
const TRANSCRIPT_SEARCH_MEETINGS_MAX = 100;

/** Request-memory only. Raw notes and transcripts remain in Granola; receipts contain coordinates and digests. */
export async function createGranolaPersonLiveEvidenceReaderV1(options: {
  readonly transport: PersonProviderAuthenticatedFetchV1; readonly folder_ids?: readonly string[]; readonly signal?: AbortSignal;
}): Promise<PersonLiveEvidenceReaderV1<PersonPageCitationV1>> {
  const binding = GRANOLA_PERSON_PROVIDER_V1.copyBinding(options.transport.binding);
  const folders = options.folder_ids === undefined ? undefined : [...options.folder_ids];
  if (folders !== undefined && (folders.length < 1 || folders.some(id => !GRANOLA_ID_V1.test(id)))) fail('invalid_request');
  const now = new Date().toISOString();
  const api = createGranolaMcpV1({ binding, async fetch(url, init) {
    options.signal?.throwIfAborted();
    return options.transport.fetch(url, init);
  } });
  const issued = new Map<string, Value>(), handles = new Map<string, Value>();
  const lists = createPersonLiveListV1<GranolaMeetingV1, ListState>('', fail);
  // Project members can see different Granola folders: the reader works over the mapped folders this asker sees.
  let shown = folders;
  async function verify(signal?: AbortSignal, initial = false) {
    const account = await api.account(signal);
    if (account.workspace_id !== binding.external_scope_id || account.email !== binding.external_subject_id) fail('stale_access_state');
    if (folders !== undefined) {
      const accessible = new Set((await api.folders(signal)).map(folder => folder.id)), before = shown!;
      shown = folders.filter(id => accessible.has(id));
      // Results read from a folder that has since gone out of sight are not released.
      if (!initial && before.some(id => !accessible.has(id))) fail('unauthorized');
    }
  }
  await verify(options.signal, true);
  const leftOut = () => shown !== undefined && shown.length < folders!.length && LEFT_OUT;
  /** An item as it would be released; `remember` releases it. */
  function build(meeting: GranolaMeetingV1, section: string, version: string, text?: string): Value {
    const citation = validatePersonPageCitationV1({ kind: 'page', tool_id: 'granola', external_scope_id: binding.external_scope_id,
      page_id: meeting.id, section_id: section, version, permalink: meeting.url, text_sha256: sha256Digest(text ?? '') });
    const handle = randomUUID();
    // The meeting's title within the evidence label bound.
    const value: Value = Object.freeze({ citation, handle, label: boundUtf8V1(meeting.title ?? 'Untitled meeting', PERSON_EVIDENCE_LABEL_MAX_BYTES_V1), visibility: 'only_me',
      ...(text === undefined ? {} : { text }), dates: dates(meeting),
      ...(dates(meeting).occurred === undefined ? {} : { occurred_at: dates(meeting).occurred!.slice(0, 10), date_kind: 'occurred' as const }),
    });
    return value;
  }
  function remember(meeting: GranolaMeetingV1, section: string, version: string, text?: string): Value {
    const value = build(meeting, section, version, text);
    issued.set(canonicalSha256(value.citation), value); handles.set(value.handle, value);
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
  async function members(signal?: AbortSignal, fresh = false): Promise<ReadonlySet<string> | undefined> {
    if (shown === undefined) return undefined;
    const key = shown.join();
    if (!fresh && membership?.key === key) return membership.ids;
    const ids = new Set<string>();
    for (const folder_id of shown) {
      const seen = new Set<string>();
      for (let cursor: string | undefined;;) {
        const page = await api.search({ folder_id, from_date: '1970-01-01', to_date: now, limit: MEETING_PAGE_MAX, ...(cursor === undefined ? {} : { cursor }), signal });
        page.meetings.forEach(meeting => ids.add(meeting.id));
        // A read must never assert that a partial folder is its full contents: it follows Granola's pages to the end. A
        // cursor that comes back is a cycle, a provider fault, and fails.
        if (page.incomplete) fail('unavailable');
        if (page.next_cursor === null) break;
        if (seen.has(page.next_cursor)) fail('invalid_output');
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
    const meeting = await once(`meeting:${ref.page_id}`, () => api.meeting(ref.page_id, signal));
    if (ref.section_id === 'inventory') return inventory(meeting);
    const [kind, raw, part] = ref.section_id.split(':'), offset = Number(kind === 'transcript' ? part : raw);
    if (offset % SECTION !== 0) fail('invalid_request');
    if (kind === 'transcript') {
      const chunk = await once(JSON.stringify([meeting.id, Number(raw), ref.version]), () => api.chunk(meeting.id, Number(raw), ref.version, signal));
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
      // As many slices as were asked for and one result carries; the last one shown opens the rest.
      const shownCount = fit(items, size(limit));
      return { items: items.slice(0, shownCount), truncated: items.length > shownCount, anchor_truncated: items.length > shownCount };
    }
    const meeting = await api.meeting(ref.page_id, signal), items: Value[] = [];
    for (const [kind, text] of [['notes', meeting.private_notes ?? ''], ['summary', meeting.summary ?? '']] as const) {
      items.push(...sections(meeting, kind, text, canonicalSha256({ metadata: metadata(meeting), text })));
    }
    await verify(signal);
    const shownCount = fit(items, size(limit));
    return { items: items.slice(0, shownCount), truncated: items.length > shownCount, anchor_truncated: items.length > shownCount,
      notice: 'These are meeting notes and summaries. Search the transcript for what was said, decided, or assigned.' };
  }
  return Object.freeze<PersonLiveEvidenceReaderV1<PersonPageCitationV1>>({ binding,
    validateCitation(value) {
      const ref = citation(value);
      if (!issued.has(canonicalSha256(ref))) fail('invalid_request');
      return { citation: ref, tool_id: 'granola', external_scope_id: binding.external_scope_id, coordinates: { object_id: `${ref.page_id}:${ref.section_id}:${ref.version}` } };
    },
    async list(input) {
      const wanted = size(input.limit), limit = Math.min(wanted, MEETING_PAGE_MAX), window = range(input);
      if (input.container !== undefined && (!GRANOLA_ID_V1.test(input.container) || (folders !== undefined && !folders.includes(input.container)))) fail('invalid_request');
      const selected = input.container === undefined ? shown ?? [undefined] : shown === undefined || shown.includes(input.container) ? [input.container] : [];
      if (selected.length === 0) { await verify(input.signal); return { items: [], truncated: false, page_full: false, ...notice(LEFT_OUT) }; }
      const selection = canonicalSha256({ selected: selected.map(id => id ?? null), window, limit, date_field: input.date_field ?? null, time_zone: input.time_zone ?? null });
      const previous = lists.resume(input.cursor, selection);
      let incomplete = false;
      const page = await lists.page({ previous, selection, wanted, value: meeting => build(meeting, 'inventory', canonicalSha256(metadata(meeting))), async read(state) {
        const index = state?.folder ?? 0, folder_id = selected[index];
        const found = await api.search({ ...window, limit, ...(folder_id === undefined ? {} : { folder_id }), ...(state?.cursor === undefined ? {} : { cursor: state.cursor }), signal: input.signal });
        if (found.next_cursor !== null && found.next_cursor === state?.cursor) fail('invalid_output');
        incomplete = found.incomplete === true;
        const folder = found.next_cursor === null ? index + 1 : index;
        return { rows: found.meetings.filter(meeting => matches(meeting, input)), state: { folder, ...(found.next_cursor === null ? {} : { cursor: found.next_cursor }) },
          more: found.next_cursor !== null || folder < selected.length, full: found.meetings.length === limit };
      } });
      await verify(input.signal);
      return { items: page.rows.map(inventory), truncated: page.truncated || incomplete, ...(page.next_cursor === undefined ? {} : { next_cursor: page.next_cursor }), page_full: page.page_full,
        ...notice(incomplete && 'Granola could not finish this listing. Narrow the date range.', leftOut()) };
    },
    async search(input) {
      const limit = size(input.limit), window = range(input), items: Value[] = [];
      /** Each transcript passage's matching slices, kept apart so they can be taken in turns. */
      const passages: { readonly meeting: GranolaMeetingV1; readonly chunk: number; readonly version: string; readonly slices: readonly { readonly offset: number; readonly text: string }[] }[] = [];
      const terms = input.query.toLowerCase().split(/\s+/u).filter(Boolean);
      let truncated = false, transcriptLost: 'unauthorized' | 'unavailable' | undefined;
      for (const folder_id of shown ?? [undefined]) {
        const page = await api.search({ ...window, query: input.query, limit: Math.min(limit, MEETING_PAGE_MAX), ...(folder_id === undefined ? {} : { folder_id }), signal: input.signal });
        items.push(...page.meetings.filter(meeting => matches(meeting, input)).map(inventory));
        truncated ||= page.next_cursor !== null || page.incomplete === true;
      }
      const allowed = await members(input.signal), ids = allowed === undefined ? undefined : [...allowed];
      for (let offset = 0; ids === undefined ? offset === 0 : offset < ids.length; offset += TRANSCRIPT_SEARCH_MEETINGS_MAX) {
        if (passages.length >= limit) { truncated = true; break; }
        let page;
        try { page = await api.searchTranscripts({ ...window, query: input.query, limit: Math.min(limit, TRANSCRIPT_SEARCH_MAX), ...(ids === undefined ? {} : { meeting_ids: ids.slice(offset, offset + TRANSCRIPT_SEARCH_MEETINGS_MAX) }), signal: input.signal }); }
        catch (error) {
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
            passages.push({ meeting, chunk: passage.chunk_id, version: chunk.version, slices: matchingSlices(chunk.text, terms) });
          }
        }
      }
      // Every matching slice of every passage, taken in turns (each passage's first, then each one's second, ...), so one
      // long chunk never crowds out other meetings' passages.
      const slices: Value[] = [];
      for (let turn = 0; passages.some(passage => turn < passage.slices.length); turn += 1) {
        for (const passage of passages) {
          const slice = passage.slices[turn];
          if (slice !== undefined) slices.push(remember(passage.meeting, `transcript:${passage.chunk}:${slice.offset}`, passage.version, slice.text));
        }
      }
      // Passages and notes or summary hits alternate, so neither crowds the other out of the limit.
      const merged = new Map<string, Value>();
      for (let index = 0; index < Math.max(slices.length, items.length); index += 1) {
        for (const value of [slices[index], items[index]]) if (value !== undefined) merged.set(canonicalSha256(value.citation), merged.get(canonicalSha256(value.citation)) ?? value);
      }
      // As many as were asked for and one result carries; the rest are reported with `truncated`.
      const all = [...merged.values()];
      const released = all.slice(0, fit(all, limit));
      await verify(input.signal);
      return { items: released, truncated: truncated || all.length > released.length,
        ...notice(leftOut(), transcriptLost === 'unauthorized' ? 'Granola did not allow transcript search. These results cover accessible notes only; they cannot establish what was said in a transcript.'
          : transcriptLost === 'unavailable' ? 'Granola could not complete transcript search. These results cover notes only; they cannot establish what was said in a transcript.' : INDEX_NOTICE) };
    },
    async open(input) {
      const item = handles.get(input.handle); if (item === undefined) fail('invalid_request');
      return open(item.citation, input.limit, input.signal);
    },
    async openCitation(input) { return open(citation(input.citation), input.limit, input.signal); },
    async revalidate(input) {
      const allowed = input.citations.length === 0 ? undefined : await members(input.signal, true), reads = new Map<string, Promise<unknown>>();
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
