import { randomUUID } from 'node:crypto';
import { canonicalSha256, sha256Digest } from '@echo-brain/federation-protocol';
import { validatePersonPageCitationV1, type PersonPageCitationV1 } from '@echo-brain/organization-api';
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
function size(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) fail('invalid_request');
  return Math.min(limit, 20);
}

/** Request-memory only. Raw notes and transcripts remain in Granola; receipts contain coordinates and digests. */
export async function createGranolaPersonLiveEvidenceReaderV1(options: {
  readonly transport: PersonProviderAuthenticatedFetchV1; readonly folder_ids?: readonly string[]; readonly signal?: AbortSignal;
}): Promise<PersonLiveEvidenceReaderV1<PersonPageCitationV1>> {
  const binding = GRANOLA_PERSON_PROVIDER_V1.copyBinding(options.transport.binding);
  const folders = options.folder_ids === undefined ? undefined : [...options.folder_ids];
  if (folders !== undefined && (folders.length < 1 || folders.length > 20 || folders.some(id => !GRANOLA_ID_V1.test(id)))) fail('invalid_request');
  let calls = 0;
  const now = new Date().toISOString();
  const api = createGranolaMcpV1({ binding, async fetch(url, init) {
    options.signal?.throwIfAborted();
    if (++calls > 240) fail('unavailable');
    return options.transport.fetch(url, init);
  } });
  const issued = new Map<string, Value>(), handles = new Map<string, Value>(), cursors = new Map<string, Cursor>();
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
  /** Bound folder membership is re-read, including when reopening an old answer. It never comes from an import setting. */
  async function members(signal?: AbortSignal): Promise<ReadonlySet<string> | undefined> {
    if (shown === undefined) return undefined;
    const ids = new Set<string>();
    for (const folder_id of shown) {
      const seen = new Set<string>();
      for (let cursor: string | undefined;;) {
        const page = await api.search({ folder_id, from_date: '1970-01-01', to_date: now, limit: 100, ...(cursor === undefined ? {} : { cursor }), signal });
        page.meetings.forEach(meeting => ids.add(meeting.id));
        // A bounded read must never assert that a partial folder is its full contents.
        if (ids.size > 1_000 || page.incomplete) fail('unavailable');
        if (page.next_cursor === null) break;
        if (seen.has(page.next_cursor) || seen.size >= 20) fail('invalid_output');
        seen.add(page.next_cursor); cursor = page.next_cursor;
      }
    }
    return ids;
  }
  function scope(meeting: string, allowed: ReadonlySet<string> | undefined) {
    if (allowed !== undefined && !allowed.has(meeting)) fail('unauthorized');
  }
  async function section(ref: PersonPageCitationV1, allowed: ReadonlySet<string> | undefined, signal?: AbortSignal): Promise<Value> {
    scope(ref.page_id, allowed);
    const meeting = await api.meeting(ref.page_id, signal);
    if (ref.section_id === 'inventory') return inventory(meeting);
    const [kind, raw, part] = ref.section_id.split(':'), offset = Number(kind === 'transcript' ? part : raw);
    if (offset % SECTION !== 0) fail('invalid_request');
    if (kind === 'transcript') {
      const chunk = await api.chunk(meeting.id, Number(raw), ref.version, signal);
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
    return { from_date: input.since === undefined ? '1970-01-01' : shift(input.since, -1), to_date: input.until === undefined ? now : [now, shift(input.until, 1)].sort()[0]! };
  }
  const matches = (meeting: GranolaMeetingV1, input: EvidenceDateFilterV1) => matchesEvidenceDateV1(dates(meeting), input, 'occurred');
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
    },
    async search(input) {
      const limit = size(input.limit), window = range(input), items: Value[] = [];
      let truncated = false, transcriptDenied = false;
      for (const folder_id of shown ?? [undefined]) {
        const page = await api.search({ ...window, query: input.query, limit, ...(folder_id === undefined ? {} : { folder_id }), signal: input.signal });
        items.push(...page.meetings.filter(meeting => matches(meeting, input)).map(inventory));
        truncated ||= page.next_cursor !== null || page.incomplete === true;
      }
      const allowed = await members(input.signal), ids = allowed === undefined ? undefined : [...allowed];
      const passages: Value[] = [];
      for (let offset = 0; ids === undefined ? offset === 0 : offset < ids.length; offset += 100) {
        if (passages.length >= limit) { truncated = true; break; }
        let page;
        try { page = await api.searchTranscripts({ ...window, query: input.query, limit, ...(ids === undefined ? {} : { meeting_ids: ids.slice(offset, offset + 100) }), signal: input.signal }); }
        catch (error) {
          // Notes and transcripts can have different provider permissions. A denied transcript search is never retried through another tool.
          if (!(error instanceof AuthorityOperationError) || error.code !== 'unauthorized') throw error;
          transcriptDenied = true; truncated = true; break;
        }
        truncated ||= page.next_cursor !== null || page.incomplete;
        for (const match of page.meetings) {
          if (passages.length >= limit) { truncated = true; break; }
          scope(match.meeting_id, allowed);
          const meeting = await api.meeting(match.meeting_id, input.signal);
          if (!matches(meeting, input)) continue;
          for (const passage of match.passages) {
            if (passages.length >= limit) { truncated = true; break; }
            const chunk = await api.chunk(meeting.id, passage.chunk_id, match.version, input.signal);
            const terms = input.query.toLowerCase().split(/\s+/u).filter(Boolean);
            const parts = sections(meeting, `transcript:${passage.chunk_id}`, chunk.text, chunk.version);
            const score = (item: Value) => terms.filter(term => item.text!.toLowerCase().includes(term)).length;
            parts.sort((a, b) => score(b) - score(a));
            const remaining = limit - passages.length;
            passages.push(...parts.slice(0, remaining));
            truncated ||= parts.length > remaining;
          }
        }
      }
      const unique = [...new Map([...passages, ...items].map(item => [canonicalSha256(item.citation), item])).values()];
      await verify(input.signal);
      return { items: unique.slice(0, limit), truncated: truncated || unique.length > limit,
        ...notice(leftOut(), transcriptDenied ? 'Granola did not allow transcript search. These results cover accessible notes only; they cannot establish what was said in a transcript.' : INDEX_NOTICE) };
    },
    async open(input) {
      const item = handles.get(input.handle); if (item === undefined) fail('invalid_request');
      return open(item.citation, input.limit, input.signal);
    },
    async openCitation(input) { return open(citation(input.citation), input.limit, input.signal); },
    async revalidate(input) {
      const allowed = await members(input.signal);
      for (const value of input.citations) {
        const ref = citation(value), original = issued.get(canonicalSha256(ref));
        if (original === undefined) fail('invalid_request');
        const current = await section(ref, allowed, input.signal);
        if (canonicalSha256(current.citation) !== canonicalSha256(ref) || current.label !== original.label) fail('stale_access_state');
      }
      await verify(input.signal);
    },
  });
}
