import { EVIDENCE_ANY_DATE_V1, evidenceDateFilterV1 } from "@echo-brain/organization-authority-kernel/shared/temporal-query-v1";
import { validatePersonEvidenceOpenRequestV1, type PersonAnswerCitationV3 } from '@echo-brain/organization-api';
import type { EvidenceDeskKindV1, EvidenceDeskPortV1, EvidenceDeskResultV1 } from '@echo-brain/organization-authority-kernel/shared/evidence-desk-v1';
import type { EvidenceDeskItemV2, EvidenceDeskPortV2, EvidenceDeskResultV2, PersonLiveSourceDescriptorV2 } from '@echo-brain/organization-authority-kernel/shared/evidence-desk-v2';
import { FOLLOW_UP_EVIDENCE_KIND_V1, FOLLOW_UPS_LIMITS_V1, FOLLOW_UPS_SOURCE_ID_V1 } from '@echo-brain/organization-authority-kernel/shared/follow-up-evidence-v1';
import type { PersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { annotateCoreRuntimeV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';
import type { PersonFollowUpsEvidenceSourceV1 } from './person-follow-ups-evidence-v1.js';
import type { PersonWorkspaceEvidenceSourcesV1 } from './person-workspace-evidence-v1.js';
import { WORKSPACE_SOURCE_IDS_V1, type WorkspaceSourceIdV1 } from '@echo-brain/organization-authority-kernel/shared/workspace-evidence-v1';
import { observePersonLiveEvidenceV1 } from './person-live-evidence-observation-v1.js';
import { mergeUncheckedV1 } from '../application/evidence-unchecked-v1.js';

const LOCAL_KINDS: readonly EvidenceDeskKindV1[] = ['imported_meeting', 'decision', 'action', 'rationale', 'note', 'document_passage'];
/** Live inventory pages match the research loop's list fetch; each reader still applies its own smaller cap. */
const LIVE_LIST_MAX = 50;
/**
 * Coverage notices for a source that was briefly unavailable to a search across sources. Only a tool's items, follow-ups
 * and the asker's projects join one: a tool's containers, people and tools are searched only when named.
 */
const UNAVAILABLE_NOTICES: Readonly<Record<Exclude<PersonLiveSourceDescriptorV2['kind'], 'tool_container'> | typeof FOLLOW_UP_EVIDENCE_KIND_V1 | 'project', string>> = Object.freeze({
  ticket: 'Live tickets could not be searched just now, so these results leave them out.',
  page: 'Live pages could not be searched just now, so these results leave them out.',
  slack_message: 'Live Slack messages could not be searched just now, so these results leave them out.',
  follow_up: 'Follow-ups could not be searched just now, so these results leave them out.',
  project: 'Your projects could not be searched just now, so these results leave them out.',
});
/** A provider outage, timeout or rate limit. Authorization, stale access and cancellation are never transient. */
function transientLiveFailure(error: unknown): boolean {
  return error instanceof AuthorityOperationError && (error.code === 'unavailable' || error.code === 'rate_limited');
}

export type { PersonLiveSourceDescriptorV2 } from '@echo-brain/organization-authority-kernel/shared/evidence-desk-v2';
export interface RegisteredPersonLiveEvidenceSourceV2 {
  readonly descriptor: PersonLiveSourceDescriptorV2;
  readonly source: PersonLiveEvidenceSourceV1;
  /** Provider composition has already applied this exact request's scope. */
  readonly scope: { readonly kind: 'global' } | { readonly kind: 'project'; readonly project_id: string };
}

/** The workspace source that owns items of a desk kind, for a workspace kind. */
const WORKSPACE_KIND_SOURCES: Readonly<Record<string, WorkspaceSourceIdV1>> = Object.freeze({ project: 'projects', person: 'people', tool: 'tools' });
const workspaceKind = (kind: string): boolean => Object.hasOwn(WORKSPACE_KIND_SOURCES, kind);
/** Kinds only a bound live source serves; Slack messages may also be ECHO's own imports. */
const LIVE_ONLY_KINDS: ReadonlySet<string> = new Set(['ticket', 'page', 'tool_container']);

/** Items several reads released beside their rows, each once. */
function linkedOf(results: readonly EvidenceDeskResultV2[]): readonly EvidenceDeskItemV2[] | undefined {
  const linked = new Map<string, EvidenceDeskItemV2>();
  for (const result of results) for (const item of result.linked ?? []) if (!linked.has(item.id)) linked.set(item.id, item);
  return linked.size === 0 ? undefined : Object.freeze([...linked.values()]);
}

/**
 * Request-owned dispatch by source identity; content kind never selects one provider.
 * `followUps` binds ECHO's shared follow-ups (ADR-0040) to this desk; it reads
 * a follow-up's tool item through this same desk. `workspace` binds the
 * asker's projects, people and tools (research tool contract v1).
 */
export function createRegisteredPersonLiveEvidenceDeskV2(base: EvidenceDeskPortV1, registrations: readonly RegisteredPersonLiveEvidenceSourceV2[],
  followUps?: (desk: Pick<EvidenceDeskPortV2, 'openCitation'>) => PersonFollowUpsEvidenceSourceV1, workspace?: PersonWorkspaceEvidenceSourcesV1): EvidenceDeskPortV2 {
  const sources = new Map<string, RegisteredPersonLiveEvidenceSourceV2>();
  const routingNames = new Set(['meeting', 'meetings', 'document', 'documents', FOLLOW_UPS_SOURCE_ID_V1, ...WORKSPACE_SOURCE_IDS_V1]);
  for (const registration of registrations) {
    const { descriptor, scope } = registration;
    if (descriptor.tool_id !== undefined && descriptor.tool_id !== registration.source.tool_id) throw new AuthorityOperationError('unauthorized', 'Live source identity does not match its reader');
    if (scope.kind !== base.scope.kind || (scope.kind === 'project' && (base.scope.kind !== 'project' || scope.project_id !== base.scope.project_id))) throw new AuthorityOperationError('unauthorized', 'Live source is unsupported in this scope');
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(descriptor.source_id) || !/^[a-z][a-z0-9_-]{0,63}$/.test(descriptor.selector) ||
        [descriptor.source_id, descriptor.selector].some(name => routingNames.has(name))) throw new AuthorityOperationError('invalid_request', 'Live source identity is ambiguous');
    routingNames.add(descriptor.source_id); routingNames.add(descriptor.selector);
    sources.set(descriptor.source_id, Object.freeze({ ...registration, descriptor: Object.freeze({ ...descriptor, tool_id: registration.source.tool_id }) }));
  }
  // Its tool reads go through this desk, which exists by the time any of them is made.
  const followUpSource: PersonFollowUpsEvidenceSourceV1 | undefined = followUps?.({ openCitation: (request): Promise<EvidenceDeskResultV2> => desk.openCitation!(request) });
  const workspaceSources = workspace === undefined ? undefined : new Map<string, PersonWorkspaceEvidenceSourcesV1[WorkspaceSourceIdV1]>([['projects', workspace.projects], ['people', workspace.people], ['tools', workspace.tools]]);
  type WorkspaceSource = PersonWorkspaceEvidenceSourcesV1[WorkspaceSourceIdV1];
  type LiveSource = RegisteredPersonLiveEvidenceSourceV2 | PersonFollowUpsEvidenceSourceV1 | WorkspaceSource;
  type Source = EvidenceDeskPortV1 | LiveSource;
  const issued = new Map<string, Source>();
  const lookup = (phase: 'evidence_search' | 'evidence_list' | 'evidence_open', source: RegisteredPersonLiveEvidenceSourceV2, operation: () => Promise<EvidenceDeskResultV2>) =>
    observePersonLiveEvidenceV1(phase, source.descriptor.kind === 'slack_message' ? 'slack' : source.descriptor.kind, async () => {
      const result = await operation();
      annotateCoreRuntimeV1({ counts: { included_count: result.items.length }, result: result.items.length === 0 ? 'empty' : 'returned' });
      return result;
    });
  /** The source that opens an item released beside a result: a workspace kind's own source, else the one that released it. */
  const ownerOf = (item: EvidenceDeskItemV2, source: Source): Source =>
    workspaceKind(item.kind) && workspaceSources !== undefined ? workspaceSources.get(WORKSPACE_KIND_SOURCES[item.kind]!)! : source;
  const withSourceId = (item: EvidenceDeskItemV2, owner: Source) => owner === base ? item : Object.freeze({ ...item, source_id: (owner as LiveSource).descriptor.source_id });
  const remember = (result: EvidenceDeskResultV2, source: Source) => {
    if (source !== base && result.items.some(item => item.kind !== (source as LiveSource).descriptor.kind)) throw new AuthorityOperationError('invalid_output', 'Live source returned an incompatible content kind');
    for (const item of result.items) {
      const previous = issued.get(item.id);
      if (previous !== undefined && previous !== source) throw new AuthorityOperationError('unavailable', 'Evidence item ownership is ambiguous');
      issued.set(item.id, source);
    }
    // An item released beside the result (research tool contract v1) keeps the owner that first released it: a decision a
    // follow-up links to was released by the base desk through openCitation. One released only here opens through its kind's source.
    const linked = (result.linked ?? []).map(item => {
      const owner = issued.get(item.id) ?? ownerOf(item, source);
      issued.set(item.id, owner);
      return withSourceId(item, owner);
    });
    const items = source === base ? result.items : result.items.map(item => withSourceId(item, source));
    return Object.freeze({ ...result, items: Object.freeze(items), ...(result.linked === undefined ? {} : { linked: Object.freeze(linked) }) });
  };
  const refused = (): never => { throw new AuthorityOperationError('unauthorized', 'Live source is unavailable in this scope'); };
  const desk: EvidenceDeskPortV2 = Object.freeze<EvidenceDeskPortV2>({
    scope: base.scope,
    live_sources: Object.freeze([...[...sources.values()].map(value => value.descriptor), ...(followUpSource === undefined ? [] : [followUpSource.descriptor]),
      ...(workspaceSources === undefined ? [] : [...workspaceSources.values()].map(value => value.descriptor))]),
    async search(input) {
      input.signal?.throwIfAborted();
      const maximum = input.limit ?? 8;
      if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 50) throw new AuthorityOperationError('invalid_request', 'Evidence search limit is invalid');
      const { kinds: requestedKinds, source: selectedId, ...request } = input;
      if (selectedId === FOLLOW_UPS_SOURCE_ID_V1) {
        if (followUpSource === undefined || requestedKinds?.some(kind => kind !== FOLLOW_UP_EVIDENCE_KIND_V1)) refused();
        const result = input.query === undefined
          ? await followUpSource!.list({ ...evidenceDateFilterV1(input), source: FOLLOW_UPS_SOURCE_ID_V1, limit: Math.min(maximum, FOLLOW_UPS_LIMITS_V1.list_page), signal: input.signal })
          : await followUpSource!.search({ ...evidenceDateFilterV1(input), query: input.query, limit: Math.min(maximum, FOLLOW_UPS_LIMITS_V1.search_hits), signal: input.signal });
        input.signal?.throwIfAborted();
        return remember(result, followUpSource!);
      }
      const selectedWorkspace = selectedId === undefined ? undefined : workspaceSources?.get(selectedId);
      if (selectedWorkspace !== undefined) {
        if (requestedKinds?.some(kind => kind !== selectedWorkspace.descriptor.kind)) refused();
        const result = input.query === undefined
          ? await selectedWorkspace.list({ ...evidenceDateFilterV1(input), source: selectedWorkspace.descriptor.source_id, limit: maximum, signal: input.signal })
          : await selectedWorkspace.search({ ...evidenceDateFilterV1(input), query: input.query, limit: maximum, signal: input.signal });
        input.signal?.throwIfAborted();
        return remember(result, selectedWorkspace);
      }
      const selectedSource = selectedId === undefined ? undefined : sources.get(selectedId);
      const localSource = selectedId === 'meeting' || selectedId === 'document';
      if (selectedId !== undefined && selectedSource === undefined && !localSource) refused();
      for (const kind of requestedKinds ?? []) if (LIVE_ONLY_KINDS.has(kind) && ![...sources.values()].some(value => value.descriptor.kind === kind)) refused();
      if (requestedKinds?.includes(FOLLOW_UP_EVIDENCE_KIND_V1) === true && followUpSource === undefined) refused();
      if (requestedKinds?.some(workspaceKind) === true && workspaceSources === undefined) refused();
      if (selectedSource !== undefined && requestedKinds?.some(kind => kind !== selectedSource.descriptor.kind)) refused();
      const liveKinds = new Set([...sources.values()].map(value => value.descriptor.kind));
      const localKinds = selectedId === 'meeting' ? ['imported_meeting', 'decision', 'action', 'rationale', 'note'] as const : selectedId === 'document' ? ['note', 'document_passage'] as const : undefined;
      const kinds = (requestedKinds ?? localKinds)?.filter((kind): kind is EvidenceDeskKindV1 => !LIVE_ONLY_KINDS.has(kind) && kind !== FOLLOW_UP_EVIDENCE_KIND_V1 && !workspaceKind(kind) && !liveKinds.has(kind as 'slack_message')) ?? (liveKinds.has('slack_message') ? LOCAL_KINDS : undefined);
      type Page = { readonly source: Source; readonly result: EvidenceDeskResultV2 };
      type Unavailable = { readonly notice: string; readonly result?: undefined; readonly failure: unknown };
      /** Across sources, a source's transient failure becomes a coverage notice and the others still answer. */
      const tolerate = (kind: keyof typeof UNAVAILABLE_NOTICES, lookup: Promise<Page>): Promise<Page | Unavailable> => lookup.catch((failure: unknown): Unavailable => {
        if (!transientLiveFailure(failure)) throw failure;
        return { notice: UNAVAILABLE_NOTICES[kind], failure };
      });
      const page = (source: Source, operation: () => Promise<EvidenceDeskResultV2>): Promise<Page> =>
        Promise.resolve().then(operation).then(result => ({ source, result }));
      const lookups: Promise<Page | Unavailable>[] = [];
      if (selectedSource === undefined && kinds?.length !== 0) {
        lookups.push(page(base, () => base.search({ ...request, ...(selectedId === "meeting" || selectedId === "document" ? { source: selectedId } : {}), ...(kinds === undefined ? {} : { kinds }) })));
      }
      const dated = input.since !== undefined || input.until !== undefined || input.date_field !== undefined;
      /** A window on any date for a source that reads one date only: its own default date (research tool contract v1). */
      const datesFor = (capabilities: PersonLiveSourceDescriptorV2['capabilities']) => {
        const { date_field: field, ...bounds } = evidenceDateFilterV1(input);
        return field === undefined || (field === EVIDENCE_ANY_DATE_V1 && capabilities?.any_date !== true) ? bounds : { ...bounds, date_field: field };
      };
      for (const registration of selectedSource === undefined ? (localSource ? [] : sources.values()) : [selectedSource]) {
        const { source, descriptor } = registration;
        if (requestedKinds !== undefined && !requestedKinds.includes(descriptor.kind)) continue;
        // Across sources (research tool contract v1), one that records no dates sits out a dated search, and a tool's
        // containers are searched only when named: each search scans the tool's projects or spaces. A chosen source answers
        // or refuses as asked.
        if (selectedSource === undefined && (descriptor.kind === 'tool_container' ||
            (dated && descriptor.capabilities !== undefined && Object.keys(descriptor.capabilities.dates).length === 0))) continue;
        const dates = selectedSource === undefined ? datesFor(descriptor.capabilities) : evidenceDateFilterV1(input);
        const live = page(registration, () => input.query === undefined
          ? lookup('evidence_list', registration, () => source.list({ ...dates, limit: Math.min(maximum, LIVE_LIST_MAX), signal: input.signal }))
          : lookup('evidence_search', registration, () => source.search({ ...dates, query: input.query!, limit: Math.min(maximum, 5), signal: input.signal })));
        lookups.push(selectedSource !== undefined || descriptor.kind === 'tool_container' ? live : tolerate(descriptor.kind, live));
      }
      // Follow-ups join a keyword search across sources, dated too, on the dates they record; they hold no inventory. Only some
      // of them are kept below, so they are released with ECHO-held text and none is read live (ADR-0040).
      if (followUpSource !== undefined && selectedId === undefined && input.query !== undefined &&
          (requestedKinds === undefined || requestedKinds.includes(FOLLOW_UP_EVIDENCE_KIND_V1))) {
        const query = input.query;
        lookups.push(tolerate(FOLLOW_UP_EVIDENCE_KIND_V1, page(followUpSource, () => followUpSource.search({ ...evidenceDateFilterV1(input), query, limit: Math.min(maximum, FOLLOW_UPS_LIMITS_V1.search_hits), live: false, signal: input.signal }))));
      }
      // The asker's projects join a keyword search across sources as follow-ups do, dated too, on their creation (research tool
      // contract v1). People and tools are searched only when named: their names rarely answer a search for content, and
      // the directory is read whole.
      const projects = workspaceSources?.get('projects');
      if (projects !== undefined && selectedId === undefined && input.query !== undefined &&
          (requestedKinds === undefined || requestedKinds.includes(projects.descriptor.kind))) {
        const query = input.query;
        lookups.push(tolerate('project', page(projects, () => projects.search({ ...evidenceDateFilterV1(input), query, limit: maximum, signal: input.signal }))));
      }
      const settled = await Promise.all(lookups);
      input.signal?.throwIfAborted();
      const pages = settled.filter((value): value is Page => value.result !== undefined);
      const unavailable = settled.filter((value): value is Unavailable => value.result === undefined);
      // With nothing that answered, the failure stays the result.
      if (pages.length === 0 && unavailable.length > 0) throw unavailable[0]!.failure;
      if (unavailable.length === 0 && pages.length === 1 && pages[0]!.source === base) return remember(pages[0]!.result, base);
      // Take one item from each nonempty source before taking any second
      // item. One full provider page cannot hide matching evidence from another source. The asker's projects fill what the
      // content sources leave, so a project's name never crowds out what was said about it (research tool contract v1).
      const selected: EvidenceDeskResultV2['items'][number][] = [];
      const workspacePage = (value: Page) => workspaceSources !== undefined && [...workspaceSources.values()].includes(value.source as WorkspaceSource);
      for (const tier of [pages.filter(value => !workspacePage(value)), pages.filter(workspacePage)]) {
        for (let index = 0; selected.length < maximum; index += 1) {
          let found = false;
          for (const page of tier) {
            const item = page.result.items[index];
            if (item === undefined) continue;
            found = true;
            if (selected.length === maximum) break;
            selected.push(remember({ items: [item], truncated: false, receipt_digests: [] }, page.source).items[0]!);
          }
          if (!found) break;
        }
      }
      const notices = [...pages.flatMap(page => page.result.notice === undefined ? [] : [page.result.notice]),
        ...unavailable.map(value => value.notice)];
      // Items released beside the kept rows come through once each, as their sources gave them; those beside rows left out,
      // and those kept as rows, stay out. Unchecked counts are summed (research tool contract v1).
      const rows = new Set(selected.map(item => item.id));
      const kept = new Set(selected.flatMap(item => Object.values(item.links ?? {}).flat()));
      const linked = linkedOf(pages.map(page => remember({ items: [], truncated: false, receipt_digests: [], linked: (page.result.linked ?? []).filter(item => kept.has(item.id) && !rows.has(item.id)) }, page.source)));
      const unchecked = mergeUncheckedV1(pages.map(page => page.result.unchecked));
      return Object.freeze({
        items: Object.freeze(selected),
        truncated: pages.some(page => page.result.truncated) || pages.reduce((count, page) => count + page.result.items.length, 0) > maximum,
        receipt_digests: Object.freeze([...new Set(pages.flatMap(page => page.result.receipt_digests))]),
        ...(notices.length === 0 ? {} : { notice: notices.join(' ') }),
        ...(linked === undefined ? {} : { linked }), ...(unchecked === undefined ? {} : { unchecked }),
      });
    },
    async open(input) {
      input.signal?.throwIfAborted();
      const source = issued.get(input.item);
      if (source === undefined) throw new AuthorityOperationError('not_found', 'Evidence item is not available in this request');
      const result = source === base ? await base.open(input)
        : source === followUpSource ? await followUpSource.open({ item: input.item, signal: input.signal })
        : workspaceSources !== undefined && [...workspaceSources.values()].includes(source as WorkspaceSource) ? await (source as WorkspaceSource).open({ item: input.item, signal: input.signal })
        : await lookup('evidence_open', source as RegisteredPersonLiveEvidenceSourceV2, () => (source as RegisteredPersonLiveEvidenceSourceV2).source.open({ item: input.item, signal: input.signal }));
      input.signal?.throwIfAborted();
      return remember(result, source);
    },
    async list(input) {
      input.signal?.throwIfAborted();
      const workspaceSource = workspaceSources?.get(input.source);
      if (workspaceSource !== undefined) {
        const result = await workspaceSource.list(input);
        input.signal?.throwIfAborted();
        return remember(result, workspaceSource);
      }
      if (WORKSPACE_SOURCE_IDS_V1.includes(input.source as WorkspaceSourceIdV1)) refused();
      if (input.source === FOLLOW_UPS_SOURCE_ID_V1) {
        if (followUpSource === undefined) refused();
        const result = await followUpSource!.list(input);
        input.signal?.throwIfAborted();
        return remember(result, followUpSource!);
      }
      // Owner and status are follow-ups' own filters; the research loop applies its meeting filters itself. A source that
      // cannot apply one refuses the read rather than answer wider than asked (ADR-0041).
      if (input.owner !== undefined || input.status !== undefined || input.role !== undefined) throw new AuthorityOperationError('invalid_request', 'This source cannot be filtered by owner, status or role');
      const registration = sources.get(input.source);
      if (registration === undefined) {
        if (!['meeting', 'document'].includes(input.source)) refused();
        const { kinds, ...request } = input;
        if (kinds?.some(kind => LIVE_ONLY_KINDS.has(kind) || kind === FOLLOW_UP_EVIDENCE_KIND_V1 || workspaceKind(kind))) refused();
        const result = await base.list({ ...request, source: input.source as 'meeting' | 'document', ...(kinds === undefined ? {} : { kinds: kinds as readonly EvidenceDeskKindV1[] }) });
        input.signal?.throwIfAborted();
        return remember(result, base);
      }
      const { source, descriptor } = registration;
      if ((input.channel !== undefined && !descriptor.requires_channel) || input.kinds?.some(kind => kind !== descriptor.kind)) refused();
      const result = await lookup('evidence_list', registration, () => source.list({ ...evidenceDateFilterV1(input), ...(input.channel === undefined ? {} : { container: input.channel }), limit: Math.min(input.limit ?? 20, LIVE_LIST_MAX), since: input.since, until: input.until, cursor: input.cursor, signal: input.signal }));
      input.signal?.throwIfAborted();
      return remember(result, registration);
    },
    /**
     * Background triggers' starting evidence: a citation released by an earlier
     * request. Live citations go to the source with the same tool identity and
     * content kind; ECHO citations go to the base desk. Both apply this request's
     * scope and permissions; nothing is opened from the citation alone.
     */
    async openCitation(input) {
      input.signal?.throwIfAborted();
      const value = input.citation;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new AuthorityOperationError('invalid_request', 'Evidence citation is invalid');
      const { kind, tool_id: toolId } = value as { readonly kind?: unknown; readonly tool_id?: unknown };
      if (kind === 'ticket' || kind === 'page' || kind === 'slack_message') {
        const registration = [...sources.values()].find(entry => entry.descriptor.kind === kind && entry.source.tool_id === toolId);
        if (registration === undefined || registration.source.openCitation === undefined) return refused();
        const result = await lookup('evidence_open', registration, () => registration.source.openCitation!({ citation: value, signal: input.signal }));
        input.signal?.throwIfAborted();
        return remember(result, registration);
      }
      const local = (base as EvidenceDeskPortV1 & { openCitation?(request: { readonly citation: PersonAnswerCitationV3; readonly neighbours?: number; readonly signal?: AbortSignal }): Promise<EvidenceDeskResultV1> }).openCitation;
      if (local === undefined) return refused();
      let citation: PersonAnswerCitationV3;
      try { citation = validatePersonEvidenceOpenRequestV1({ schema_version: 1, citation: value }).citation; }
      catch { throw new AuthorityOperationError('invalid_request', 'Evidence citation is invalid'); }
      const result = await local.call(base, { citation, ...(input.neighbours === undefined ? {} : { neighbours: input.neighbours }), ...(input.signal === undefined ? {} : { signal: input.signal }) });
      input.signal?.throwIfAborted();
      return remember(result, base);
    },
    async revalidate(input) {
      // Every layer receives the same mode. An incremental check (ADR-0038)
      // re-reads only what each layer released since its own last check, so
      // the second base check below re-reads nothing new and keeps only its
      // session, grant and snapshot pins.
      input.signal?.throwIfAborted();
      // Follow-ups, projects and people read only ECHO's own state, so their checks run with the final synchronous local checks.
      const local = () => { followUpSource?.revalidate(input); workspace?.projects.revalidate(input); workspace?.people.revalidate(input); };
      if (sources.size === 0) {
        // The tools list is read through each tool's own store, so its check is awaited first: the base check that follows
        // is the last await before the final synchronous checks (research tool contract v1).
        if (workspace !== undefined) { await workspace.tools.revalidate(input); input.signal?.throwIfAborted(); }
        const checked = await base.revalidate(input);
        input.signal?.throwIfAborted();
        local();
        return checked;
      }
      await base.revalidate(input);
      input.signal?.throwIfAborted();
      // With live sources, the tools check is awaited beside the providers', before the second base check.
      if (workspace !== undefined) { await workspace.tools.revalidate(input); input.signal?.throwIfAborted(); }
      const providers = [...sources.values()];
      // Bound independent provider I/O. Both local fences and the synchronous
      // final grant checks remain in place; every provider must succeed.
      for (let offset = 0; offset < providers.length; offset += 4) {
        await Promise.all(providers.slice(offset, offset + 4).map(({ source, descriptor }) =>
          observePersonLiveEvidenceV1('evidence_revalidate', descriptor.kind === 'slack_message' ? 'slack' : descriptor.kind, () => source.revalidate(input))));
        input.signal?.throwIfAborted();
      }
      // Local snapshots and original grants may change while a live reader awaits provider I/O.
      const final = await base.revalidate(input);
      input.signal?.throwIfAborted();
      // A prior source's ECHO grant may change while a later provider or the
      // base fence awaits. Finish with all local grants in one synchronous turn.
      local();
      for (const { source } of sources.values()) source.assertCurrent();
      input.signal?.throwIfAborted();
      return final;
    },
  });
  return desk;
}
