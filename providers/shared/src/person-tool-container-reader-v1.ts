import { randomUUID } from 'node:crypto';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { PERSON_EVIDENCE_LABEL_MAX_BYTES_V1, validatePersonWorkspaceCitationV1, type PersonToolContainerCitationV1, type PersonToolContainerKindV1 } from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type {
  PersonConnectorReadBindingV1, PersonLiveEvidenceListInputV1, PersonLiveEvidencePageV1, PersonLiveEvidenceReaderV1, PersonLiveEvidenceValueV1,
} from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import type { EvidenceDateFilterV1 } from '@echo-brain/organization-authority-kernel/shared/temporal-query-v1';
import { boundUtf8V1 as bound, createPersonLiveListV1, guardedPersonProviderOperationV1, inBatchesOfFourV1, personLiveEvidencePageFitV1, type PersonProviderFailureCodeV1 } from './person-provider-v1.js';

type Citation = PersonToolContainerCitationV1;
type Page = PersonLiveEvidencePageV1<Citation>;

/** A container as its tool reports it, already validated: provider-stable id, key and display name. */
export interface PersonToolContainerV1 { readonly id: string; readonly key: string; readonly name: string }

/** Containers a tool returned, and how many of its rows were left out because they could not be shown. */
interface PersonToolContainerRowsV1 { readonly containers: readonly PersonToolContainerV1[]; readonly left_out: number }

/** One tool's container reads, each made with the asker's own connection under the tool's current permissions. */
export interface PersonToolContainerProviderV1 {
  readonly binding: PersonConnectorReadBindingV1;
  /** The tool as the person's tools list names it, such as Jira. */
  readonly tool: string;
  readonly container: PersonToolContainerKindV1;
  /** What one container is called in its text, such as "Jira project". */
  readonly noun: string;
  /** Fails when the reader's transport no longer carries the binding it was made for; the reader runs it around every `verify`. */
  fence(): void;
  /** Checks the connection and returns the tool's verified site origin. */
  verify(signal?: AbortSignal): Promise<string>;
  /** The container's display link in the tool, from the verified origin and its key. */
  permalink(origin: string, container: PersonToolContainerV1): string;
  /**
   * One page of the containers the asker can see, in a stable order, and the provider's continuation. The reader refuses
   * a page, or `candidates`, that names one container twice.
   */
  page(input: { readonly cursor?: string; readonly limit: number; readonly signal?: AbortSignal }): Promise<PersonToolContainerRowsV1 & { readonly next?: string }>;
  /**
   * Containers that may match `probe` by key or name, or the first containers when there is none, and whether the tool
   * holds more than it returned. The reader matches every search term itself.
   */
  candidates(input: { readonly probe?: string; readonly signal?: AbortSignal }): Promise<PersonToolContainerRowsV1 & { readonly more: boolean }>;
  /**
   * One container under current permissions. It refuses with not_found when the asker cannot see it (Jira and Confluence
   * answer 404 for a container that is missing or hidden from them), and with unauthorized when the tool refuses the
   * connection itself. The reader refuses an answer for another container.
   */
  exact(id: string, signal?: AbortSignal): Promise<PersonToolContainerV1>;
  failure(code: PersonProviderFailureCodeV1): never;
  /** The most containers the tool returns in one page. */
  readonly page_max: number;
}

/**
 * A tool's rows as containers. A row that fails validation is left out and counted, never shown, so one malformed
 * container cannot fail a whole list or search; the reader then says that some could not be shown.
 */
export function personToolContainerRowsV1(rows: readonly unknown[], parse: (row: unknown) => PersonToolContainerV1): PersonToolContainerRowsV1 {
  const containers: PersonToolContainerV1[] = [];
  for (const row of rows) {
    try { containers.push(parse(row)); }
    catch (error) { if (!(error instanceof AuthorityOperationError) || error.code !== 'invalid_output') throw error; }
  }
  return Object.freeze({ containers: Object.freeze(containers), left_out: rows.length - containers.length });
}

interface Released { readonly container: PersonToolContainerV1; readonly value: Omit<PersonLiveEvidenceValueV1<Citation>, 'handle'> }

/**
 * A connected tool's containers as an Ask source (research tool contract v1): Jira projects or Confluence spaces the
 * asker can see through their own connection. Each item's label is the container's name, its attributes its key and
 * tool, and its text names the ECHO projects mapped to it that the asker can see. Containers record no dates, so a date
 * window is refused, never ignored. Construct once per request from trusted ECHO state.
 */
export async function createPersonToolContainerReaderV1(options: {
  readonly provider: PersonToolContainerProviderV1;
  /** Trusted project-scope pin: the containers an ECHO project maps. Models cannot widen or replace it. */
  readonly pinned?: readonly string[];
  /** The names of the visible ECHO projects mapped to each container, by container id, read locally on every call. */
  readonly echo_projects: () => ReadonlyMap<string, readonly string[]>;
  readonly signal?: AbortSignal;
}): Promise<PersonLiveEvidenceReaderV1<Citation>> {
  const { provider } = options;
  const { binding } = provider;
  // Explicitly typed so control flow knows it never returns.
  const failure: (code: PersonProviderFailureCodeV1) => never = code => provider.failure(code);
  const pinned = options.pinned === undefined ? undefined : Object.freeze([...new Set(options.pinned)]);
  if (pinned !== undefined && pinned.length === 0) failure('invalid_request');
  const nouns = provider.noun.toLowerCase().split(' ');
  const handles = new Map<string, Released>();
  /**
   * Every distinct release of each citation. A container's citation commits to no text, so releases of one container
   * with different names or ECHO projects share it, and each must still be what the asker sees when it is checked.
   */
  const issued = new Map<string, readonly Released[]>();
  /** A list's continuation; its state is the tool's next page token (or, for a project scope, this reader's offset). */
  const lists = createPersonLiveListV1<PersonToolContainerV1, string | undefined>('tool_container_cursor_', failure);

  const safe = <T>(operation: () => Promise<T>, signal?: AbortSignal) => guardedPersonProviderOperationV1(failure, operation, signal);
  /** The connection checked, between two fences of the reader's own binding. */
  async function verify(signal?: AbortSignal): Promise<void> {
    provider.fence();
    const verified = await provider.verify(signal);
    provider.fence();
    origin = verified;
  }
  let origin = '';
  await safe(() => verify(options.signal), options.signal);
  /** A provider answer that names one container twice is malformed. */
  function distinct<R extends PersonToolContainerRowsV1>(rows: R): R {
    if (new Set(rows.containers.map(container => container.id)).size !== rows.containers.length) failure('invalid_output');
    return rows;
  }
  /** An exact read's answer, which must be the container asked for. */
  function asked(id: string, container: PersonToolContainerV1): PersonToolContainerV1 {
    if (container.id !== id) failure('invalid_output');
    return container;
  }
  /** Any positive limit: a page holds as many as are asked for and one result carries. */
  function limit(value: number): number {
    if (!Number.isInteger(value) || value < 1) failure('invalid_request');
    return value;
  }
  function refuseDates(input: EvidenceDateFilterV1): void {
    if (input.since !== undefined || input.until !== undefined || input.date_field !== undefined) failure('invalid_request');
  }
  /**
   * Keywords, compared case-insensitively, any length and any number of them. Words that only name the collection
   * ("Jira projects") match every container.
   */
  function searchTerms(query: string): { readonly terms: readonly string[]; readonly probe?: string } {
    if (typeof query !== 'string' || query.trim() === '' || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(query)) failure('invalid_request');
    const words = [...new Set(query.normalize('NFC').toLowerCase().trim().split(/\s+/u).map(word => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(word => word !== ''))];
    const terms = words.filter(word => !nouns.some(noun => word === noun || word === `${noun}s` || word === `${noun}es`));
    const probe = terms.reduce<string | undefined>((longest, term) => longest === undefined || term.length > longest.length ? term : longest, undefined);
    return { terms, ...(probe === undefined ? {} : { probe }) };
  }
  /** How many of `terms` the container's key, name or mapped ECHO project names contain. */
  function matched(container: PersonToolContainerV1, names: readonly string[], terms: readonly string[]): number {
    const haystack = [container.key, container.name, ...names].join('\n').normalize('NFC').toLowerCase();
    return terms.filter(term => haystack.includes(term)).length;
  }
  /**
   * The containers that match every term, in candidate order. When none does, a longer query must not end empty: the
   * containers that match some terms, most matched first, and `partial` says they do not match every term.
   */
  function matching(containers: readonly PersonToolContainerV1[], echo: ReadonlyMap<string, readonly string[]>, terms: readonly string[]): { readonly containers: readonly PersonToolContainerV1[]; readonly partial: boolean } {
    const scored = containers.map((container, index) => ({ container, index, score: matched(container, echo.get(container.id) ?? [], terms) }));
    const every = scored.filter(entry => entry.score === terms.length);
    if (every.length > 0 || terms.length < 2) return { containers: every.map(entry => entry.container), partial: false };
    const some = scored.filter(entry => entry.score > 0).sort((left, right) => right.score - left.score || left.index - right.index);
    return { containers: some.map(entry => entry.container), partial: some.length > 0 };
  }
  /**
   * What the container is, then every mapped ECHO project by whole name: no length of its own (the result's bound carries it).
   */
  function describe(container: PersonToolContainerV1, mapped: readonly string[]): string {
    const head = `${provider.noun} ${container.key}: ${container.name}`.normalize('NFC');
    const names = mapped.map(name => name.normalize('NFC'));
    return names.length === 0 ? head : `${head}\nECHO projects: ${names.join(', ')}`;
  }
  function value(container: PersonToolContainerV1, echo: ReadonlyMap<string, readonly string[]>): Released['value'] {
    if (pinned !== undefined && !pinned.includes(container.id)) failure('unauthorized');
    let citation: Citation;
    try {
      citation = validatePersonWorkspaceCitationV1({ kind: 'tool_container', tool_id: binding.tool_id, external_scope_id: binding.external_scope_id,
        container: provider.container, container_id: container.id, permalink: provider.permalink(origin, container) }) as Citation;
    } catch { failure('invalid_output'); }
    const names = [...new Set(echo.get(container.id) ?? [])].sort();
    return Object.freeze({ citation, label: bound(container.name, PERSON_EVIDENCE_LABEL_MAX_BYTES_V1), text: describe(container, names), visibility: 'only_me' as const,
      attributes: Object.freeze({ key: container.key, tool: provider.tool }) });
  }
  function release(containers: readonly PersonToolContainerV1[], echo: ReadonlyMap<string, readonly string[]>): readonly PersonLiveEvidenceValueV1<Citation>[] {
    const values = containers.map(container => ({ container, value: value(container, echo) }));
    return Object.freeze(values.map(released => {
      const handle = `tool_container_${randomUUID()}`;
      handles.set(handle, released);
      const key = canonicalSha256(released.value.citation);
      const digest = canonicalSha256(released.value);
      issued.set(key, Object.freeze([...(issued.get(key) ?? []).filter(previous => canonicalSha256(previous.value) !== digest), released]));
      return Object.freeze({ ...released.value, handle });
    }));
  }
  /**
   * Containers by exact read. One the asker cannot see is left out, never released or counted; one the tool answered but
   * that cannot be shown is left out and counted. A refused connection (unauthorized: HTTP 401 or 403) says nothing about
   * one container, so it fails the read rather than end a list without it.
   */
  async function visibleAll(ids: readonly string[], signal?: AbortSignal): Promise<PersonToolContainerRowsV1> {
    const read = await inBatchesOfFourV1(ids, async id => {
      try {
        return asked(id, await provider.exact(id, signal));
      } catch (error) {
        if (error instanceof AuthorityOperationError && (error.code === 'not_found' || error.code === 'invalid_output')) return error.code;
        throw error;
      }
    });
    return { containers: read.filter((value): value is PersonToolContainerV1 => typeof value !== 'string'), left_out: read.filter(value => value === 'invalid_output').length };
  }
  /**
   * A result that left a row out says so, so it never reads as complete (ADR-0041). A notice, not `truncated`: a list's
   * later page replaces its `truncated`, while one page's notice keeps the whole list incomplete.
   */
  const leftOut = (count: number) => count === 0 ? undefined : `Some ${provider.noun}s could not be shown, so these results leave them out.`;
  const notice = (...parts: readonly (string | undefined)[]) => { const text = parts.filter(part => part !== undefined).join(' '); return text === '' ? {} : { notice: text }; };

  return Object.freeze({
    binding,
    validateCitation(raw: unknown) {
      let citation: ReturnType<typeof validatePersonWorkspaceCitationV1>;
      try { citation = validatePersonWorkspaceCitationV1(raw); } catch { failure('invalid_output'); }
      const released = citation.kind === 'tool_container' ? issued.get(canonicalSha256(citation))?.[0] : undefined;
      if (released === undefined) failure('invalid_output');
      return Object.freeze({ citation: released.value.citation, tool_id: binding.tool_id, external_scope_id: binding.external_scope_id,
        coordinates: Object.freeze({ object_id: released.container.id }) });
    },
    async search(input): Promise<Page> {
      refuseDates(input);
      const wanted = limit(input.limit);
      const { terms, probe } = searchTerms(input.query);
      return safe(async () => {
        await verify(input.signal);
        const echo = options.echo_projects();
        let candidates: PersonToolContainerRowsV1;
        let more = false;
        if (pinned !== undefined) candidates = await visibleAll(pinned, input.signal);
        else {
          const found = distinct(await provider.candidates({ ...(probe === undefined ? {} : { probe }), ...(input.signal === undefined ? {} : { signal: input.signal }) }));
          more = found.more;
          // The tool searches its own keys and names; a mapped ECHO project's name finds a container only here.
          const seen = new Set(found.containers.map(container => container.id));
          const mapped = probe === undefined ? [] : [...echo].filter(([id, names]) => !seen.has(id) && names.some(name => name.normalize('NFC').toLowerCase().includes(probe))).map(([id]) => id).sort();
          const exact = await visibleAll(mapped, input.signal);
          candidates = { containers: [...found.containers, ...exact.containers], left_out: found.left_out + exact.left_out };
        }
        const found = matching(candidates.containers, echo, terms);
        // As many as were asked for and one result carries; the rest are reported with `truncated`.
        const selected = found.containers.slice(0, personLiveEvidencePageFitV1(found.containers.map(container => value(container, echo)), wanted));
        await verify(input.signal);
        return Object.freeze({ items: release(selected, echo), truncated: more || found.containers.length > selected.length,
          ...notice(found.partial ? `No ${provider.noun} matched every word of this search; these match some of them.` : undefined, leftOut(candidates.left_out)) });
      }, input.signal);
    },
    async list(input: PersonLiveEvidenceListInputV1): Promise<Page> {
      refuseDates(input);
      if (input.container !== undefined) failure('invalid_request');
      const wanted = limit(input.limit);
      const maximum = Math.min(wanted, provider.page_max);
      const selection = canonicalSha256({ maximum });
      const previous = lists.resume(input.cursor, selection);
      return safe(async () => {
        await verify(input.signal);
        const echo = options.echo_projects();
        let omitted = 0;
        const page = await lists.page({ previous, selection, wanted, value: container => value(container, echo), async read(token) {
          if (pinned !== undefined) {
            // A project scope maps a few containers, each read exactly: its pages hold only those the asker can see, and
            // its end is known. The continuation is this reader's own offset.
            const offset = token === undefined ? 0 : Number(token);
            const visible = await visibleAll(pinned, input.signal);
            omitted = visible.left_out;
            return { rows: visible.containers.slice(offset, offset + maximum), state: String(offset + maximum), more: offset + maximum < visible.containers.length, full: false };
          }
          const read = distinct(await provider.page({ ...(token === undefined ? {} : { cursor: token }), limit: maximum, ...(input.signal === undefined ? {} : { signal: input.signal }) }));
          const rows = read.containers.length + read.left_out;
          if (rows > maximum || (read.next !== undefined && rows === 0)) failure('invalid_output');
          omitted = read.left_out;
          // A last page that held its full size, counting rows left out, cannot confirm the list's end (ADR-0041).
          return { rows: read.containers, state: read.next, more: read.next !== undefined, full: rows >= maximum };
        } });
        await verify(input.signal);
        return Object.freeze({ items: release(page.rows, echo), truncated: page.truncated, ...(page.next_cursor === undefined ? {} : { next_cursor: page.next_cursor }),
          page_full: page.page_full, ...notice(leftOut(omitted)) });
      }, input.signal);
    },
    async open(input): Promise<Page> {
      limit(input.limit);
      const released = handles.get(input.handle);
      if (released === undefined) failure('not_found');
      return safe(async () => {
        await verify(input.signal);
        const current = asked(released.container.id, await provider.exact(released.container.id, input.signal));
        const echo = options.echo_projects();
        await verify(input.signal);
        return Object.freeze({ items: release([current], echo), truncated: false });
      }, input.signal);
    },
    async revalidate(input): Promise<void> {
      return safe(async () => {
        // An incremental check reads only containers released since the caller's last one (ADR-0038), then checks the
        // connection once; a full check also checks it first.
        if (input.mode !== 'incremental') await verify(input.signal);
        const byContainer = new Map<string, Released[]>();
        for (const raw of input.citations) {
          let citation: ReturnType<typeof validatePersonWorkspaceCitationV1>;
          try { citation = validatePersonWorkspaceCitationV1(raw); } catch { failure('invalid_request'); }
          const releases = issued.get(canonicalSha256(citation));
          if (releases === undefined) failure('unauthorized');
          for (const released of releases) byContainer.set(released.container.id, [...byContainer.get(released.container.id) ?? [], released]);
        }
        // What was released must still be what the asker sees now: the container, its link, and the ECHO projects named,
        // read after the provider's so a change during its reads is seen.
        const current = await inBatchesOfFourV1([...byContainer.keys()], async id => asked(id, await provider.exact(id, input.signal)));
        const echo = options.echo_projects();
        for (const container of current) {
          const fresh = canonicalSha256(value(container, echo));
          if (byContainer.get(container.id)!.some(released => canonicalSha256(released.value) !== fresh)) failure('stale_access_state');
        }
        await verify(input.signal);
      }, input.signal);
    },
  } satisfies PersonLiveEvidenceReaderV1<Citation>);
}
