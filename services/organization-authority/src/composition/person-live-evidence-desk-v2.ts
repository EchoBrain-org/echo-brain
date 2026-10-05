import type { PersonPageCitationV1, PersonSlackMessageCitationV1 } from '@echo-brain/organization-api';
import type { EvidenceDeskKindV1, EvidenceDeskPortV1 } from '@echo-brain/organization-authority-kernel/shared/evidence-desk-v1';
import { liveSourceDescriptorV2, type PersonLiveSourceDescriptorV2, type EvidenceDeskPortV2, type EvidenceDeskResultV2 } from '@echo-brain/organization-authority-kernel/shared/evidence-desk-v2';
import type { PersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { annotateCoreRuntimeV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';
import { observePersonLiveEvidenceV1 } from './person-live-evidence-observation-v1.js';

const LOCAL_KINDS: readonly EvidenceDeskKindV1[] = ['decision', 'action', 'rationale', 'note', 'document_passage'];

export type { PersonLiveSourceDescriptorV2 } from '@echo-brain/organization-authority-kernel/shared/evidence-desk-v2';
export interface RegisteredPersonLiveEvidenceSourceV2 {
  readonly descriptor: PersonLiveSourceDescriptorV2;
  readonly source: PersonLiveEvidenceSourceV1;
  /** Provider composition has already applied this exact request's scope. */
  readonly scope: { readonly kind: 'global' } | { readonly kind: 'project'; readonly project_id: string };
}

/** Compatibility construction only; all sources use the registered dispatcher below. */
export function createPersonLiveEvidenceDeskV2(base: EvidenceDeskPortV1, ticket?: PersonLiveEvidenceSourceV1, slack?: PersonLiveEvidenceSourceV1<PersonSlackMessageCitationV1>, ticketProjectId?: string, page?: PersonLiveEvidenceSourceV1<PersonPageCitationV1>, pageProjectId?: string): EvidenceDeskPortV2 {
  const registrations: RegisteredPersonLiveEvidenceSourceV2[] = [];
  for (const [source, kind, project] of [[ticket, 'ticket', ticketProjectId], [page, 'page', pageProjectId], [slack, 'slack', undefined]] as const) {
    if (source === undefined) continue;
    registrations.push({ source, descriptor: liveSourceDescriptorV2({ source: kind, tool_id: source.tool_id }), scope: project === undefined ? { kind: 'global' } : { kind: 'project', project_id: project } });
  }
  return createRegisteredPersonLiveEvidenceDeskV2(base, registrations);
}

/** Request-owned dispatch by source identity; content kind never selects one provider. */
export function createRegisteredPersonLiveEvidenceDeskV2(base: EvidenceDeskPortV1, registrations: readonly RegisteredPersonLiveEvidenceSourceV2[]): EvidenceDeskPortV2 {
  const sources = new Map<string, RegisteredPersonLiveEvidenceSourceV2>();
  const routingNames = new Set(['meeting', 'meetings', 'document', 'documents']);
  for (const registration of registrations) {
    const { descriptor, scope } = registration;
    if (descriptor.tool_id !== undefined && descriptor.tool_id !== registration.source.tool_id) throw new AuthorityOperationError('unauthorized', 'Live source identity does not match its reader');
    if (scope.kind !== base.scope.kind || (scope.kind === 'project' && (base.scope.kind !== 'project' || scope.project_id !== base.scope.project_id))) throw new AuthorityOperationError('unauthorized', 'Live source is unsupported in this scope');
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(descriptor.source_id) || !/^[a-z][a-z0-9_-]{0,63}$/.test(descriptor.selector) ||
        [descriptor.source_id, descriptor.selector].some(name => routingNames.has(name))) throw new AuthorityOperationError('invalid_request', 'Live source identity is ambiguous');
    routingNames.add(descriptor.source_id); routingNames.add(descriptor.selector);
    sources.set(descriptor.source_id, Object.freeze({ ...registration, descriptor: Object.freeze({ ...descriptor, tool_id: registration.source.tool_id }) }));
  }
  type Source = EvidenceDeskPortV1 | RegisteredPersonLiveEvidenceSourceV2;
  const issued = new Map<string, Source>();
  const lookup = (phase: 'evidence_search' | 'evidence_list' | 'evidence_open', source: RegisteredPersonLiveEvidenceSourceV2, operation: () => Promise<EvidenceDeskResultV2>) =>
    observePersonLiveEvidenceV1(phase, source.descriptor.kind === 'slack_message' ? 'slack' : source.descriptor.kind, async () => {
      const result = await operation();
      annotateCoreRuntimeV1({ counts: { included_count: result.items.length }, result: result.items.length === 0 ? 'empty' : 'returned' });
      return result;
    });
  const remember = (result: EvidenceDeskResultV2, source: Source) => {
    if (source !== base && result.items.some(item => item.kind !== (source as RegisteredPersonLiveEvidenceSourceV2).descriptor.kind)) throw new AuthorityOperationError('invalid_output', 'Live source returned an incompatible content kind');
    for (const item of result.items) {
      const previous = issued.get(item.id);
      if (previous !== undefined && previous !== source) throw new AuthorityOperationError('unavailable', 'Evidence item ownership is ambiguous');
      issued.set(item.id, source);
    }
    return source === base ? result : Object.freeze({ ...result, items: Object.freeze(result.items.map(item => Object.freeze({ ...item, source_id: (source as RegisteredPersonLiveEvidenceSourceV2).descriptor.source_id }))) });
  };
  const refused = (): never => { throw new AuthorityOperationError('unauthorized', 'Live source is unavailable in this scope'); };
  return Object.freeze<EvidenceDeskPortV2>({
    scope: base.scope,
    ticket_available: [...sources.values()].some(value => value.descriptor.kind === 'ticket'),
    live_sources: Object.freeze([...sources.values()].map(value => value.descriptor)),
    async search(input) {
      input.signal?.throwIfAborted();
      const maximum = input.limit ?? 8;
      if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 50) throw new AuthorityOperationError('invalid_request', 'Evidence search limit is invalid');
      const { kinds: requestedKinds, source: selectedId, ...request } = input;
      const selectedSource = selectedId === undefined ? undefined : sources.get(selectedId);
      const localSource = selectedId === 'meeting' || selectedId === 'document' || (selectedId === 'slack' && !sources.has('slack'));
      if (selectedId !== undefined && selectedSource === undefined && !localSource) refused();
      for (const kind of requestedKinds ?? []) if ((kind === 'ticket' || kind === 'page') && ![...sources.values()].some(value => value.descriptor.kind === kind)) refused();
      if (selectedSource !== undefined && requestedKinds?.some(kind => kind !== selectedSource.descriptor.kind)) refused();
      const liveKinds = new Set([...sources.values()].map(value => value.descriptor.kind));
      const localKinds = selectedId === 'meeting' ? ['decision', 'action', 'rationale'] as const : selectedId === 'document' ? ['note', 'document_passage'] as const : selectedId === 'slack' ? ['slack_message'] as const : undefined;
      const kinds = (requestedKinds ?? localKinds)?.filter((kind): kind is EvidenceDeskKindV1 => kind !== 'ticket' && kind !== 'page' && !liveKinds.has(kind as 'slack_message')) ?? (liveKinds.has('slack_message') ? LOCAL_KINDS : undefined);
      const page = (source: Source, operation: () => Promise<EvidenceDeskResultV2>) =>
        Promise.resolve().then(operation).then(result => ({ source, result }));
      const lookups: Promise<{ readonly source: Source; readonly result: EvidenceDeskResultV2 }>[] = [];
      if (selectedSource === undefined && kinds?.length !== 0) {
        lookups.push(page(base, () => base.search({ ...request, ...(kinds === undefined ? {} : { kinds }) })));
      }
      for (const registration of selectedSource === undefined ? (localSource ? [] : sources.values()) : [selectedSource]) {
        const { source, descriptor } = registration;
        if (requestedKinds !== undefined && !requestedKinds.includes(descriptor.kind)) continue;
        lookups.push(page(registration, () => input.query === undefined
          ? lookup('evidence_list', registration, () => source.list({ limit: Math.min(maximum, 20), signal: input.signal }))
          : lookup('evidence_search', registration, () => source.search({ query: input.query!, limit: Math.min(maximum, 5), signal: input.signal }))));
      }
      const pages = await Promise.all(lookups);
      input.signal?.throwIfAborted();
      if (pages.length === 1 && pages[0]!.source === base) return remember(pages[0]!.result, base);
      // Take one item from each nonempty source before taking any second
      // item. One full provider page cannot hide matching evidence from another source.
      const selected: EvidenceDeskResultV2['items'][number][] = [];
      for (let index = 0; selected.length < maximum; index += 1) {
        let found = false;
        for (const page of pages) {
          const item = page.result.items[index];
          if (item === undefined) continue;
          found = true;
          if (selected.length === maximum) break;
          selected.push(remember({ items: [item], truncated: false, receipt_digests: [] }, page.source).items[0]!);
        }
        if (!found) break;
      }
      const notices = pages.flatMap(page => page.result.notice === undefined ? [] : [page.result.notice]);
      return Object.freeze({
        items: Object.freeze(selected),
        truncated: pages.some(page => page.result.truncated) || pages.reduce((count, page) => count + page.result.items.length, 0) > maximum,
        receipt_digests: Object.freeze([...new Set(pages.flatMap(page => page.result.receipt_digests))]),
        ...(notices.length === 0 ? {} : { notice: notices.join(' ') }),
      });
    },
    async open(input) {
      input.signal?.throwIfAborted();
      const source = issued.get(input.item);
      if (source === undefined) throw new AuthorityOperationError('not_found', 'Evidence item is not available in this request');
      const result = source === base ? await base.open(input) : await lookup('evidence_open', source as RegisteredPersonLiveEvidenceSourceV2, () => (source as RegisteredPersonLiveEvidenceSourceV2).source.open({ item: input.item, signal: input.signal }));
      input.signal?.throwIfAborted();
      return remember(result, source);
    },
    async list(input) {
      input.signal?.throwIfAborted();
      const registration = sources.get(input.source);
      if (registration === undefined) {
        if (!['meeting', 'document', 'slack'].includes(input.source)) refused();
        const { kinds, ...request } = input;
        if (kinds?.some(kind => kind === 'ticket' || kind === 'page')) refused();
        const result = await base.list({ ...request, source: input.source as 'meeting' | 'document' | 'slack', ...(kinds === undefined ? {} : { kinds: kinds.filter((kind): kind is EvidenceDeskKindV1 => kind !== 'ticket' && kind !== 'page') }) });
        input.signal?.throwIfAborted();
        return remember(result, base);
      }
      const { source, descriptor } = registration;
      if ((input.channel !== undefined && !descriptor.requires_channel) || input.kinds?.some(kind => kind !== descriptor.kind)) refused();
      const result = await lookup('evidence_list', registration, () => source.list({ ...(input.channel === undefined ? {} : { container: input.channel }), limit: Math.min(input.limit ?? 20, 20), since: input.since, until: input.until, cursor: input.cursor, signal: input.signal }));
      input.signal?.throwIfAborted();
      return remember(result, registration);
    },
    async revalidate(input) {
      input.signal?.throwIfAborted();
      const checked = await base.revalidate(input);
      input.signal?.throwIfAborted();
      if (sources.size === 0) return checked;
      for (const { source, descriptor } of sources.values()) {
        await observePersonLiveEvidenceV1('evidence_revalidate', descriptor.kind === 'slack_message' ? 'slack' : descriptor.kind, () => source.revalidate(input));
        input.signal?.throwIfAborted();
      }
      // Local snapshots and original grants may change while a live reader awaits provider I/O.
      const final = await base.revalidate(input);
      input.signal?.throwIfAborted();
      // A prior source's ECHO grant may change while a later provider or the
      // base fence awaits. Finish with all local grants in one synchronous turn.
      for (const { source } of sources.values()) source.assertCurrent();
      input.signal?.throwIfAborted();
      return final;
    },
  });
}
