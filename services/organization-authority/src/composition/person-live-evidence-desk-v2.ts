import type { PersonSlackMessageCitationV1 } from '@echo-brain/organization-api';
import type { EvidenceDeskKindV1, EvidenceDeskPortV1 } from '@echo-brain/organization-authority-kernel/shared/evidence-desk-v1';
import type { EvidenceDeskPortV2, EvidenceDeskResultV2 } from '@echo-brain/organization-authority-kernel/shared/evidence-desk-v2';
import type { PersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';

const LOCAL_KINDS: readonly EvidenceDeskKindV1[] = ['decision', 'action', 'rationale', 'note', 'document_passage'];

/** A request-owned dispatcher. Server composition selects live sources; models select only read tools. */
export function createPersonLiveEvidenceDeskV2(base: EvidenceDeskPortV1, ticket?: PersonLiveEvidenceSourceV1, slack?: PersonLiveEvidenceSourceV1<PersonSlackMessageCitationV1>): EvidenceDeskPortV2 {
  if ((ticket !== undefined || slack !== undefined) && base.scope.kind !== 'global') throw new AuthorityOperationError('unauthorized', 'Live source is unsupported in this scope');
  type Source = EvidenceDeskPortV1 | PersonLiveEvidenceSourceV1;
  const issued = new Map<string, Source>();
  const remember = (result: EvidenceDeskResultV2, source: Source) => {
    for (const item of result.items) {
      const previous = issued.get(item.id);
      if (previous !== undefined && previous !== source) throw new AuthorityOperationError('unavailable', 'Evidence item ownership is ambiguous');
      issued.set(item.id, source);
    }
    return result;
  };
  const refused = (): never => { throw new AuthorityOperationError('unauthorized', 'Live source is unavailable in this scope'); };
  return Object.freeze<EvidenceDeskPortV2>({
    scope: base.scope,
    async search(input) {
      input.signal?.throwIfAborted();
      const maximum = input.limit ?? 8;
      if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 50) throw new AuthorityOperationError('invalid_request', 'Evidence search limit is invalid');
      const { kinds: requestedKinds, ...request } = input;
      if (requestedKinds?.includes('ticket') && ticket === undefined) refused();
      // A separately bound Slack source owns its kind exclusively. Existing
      // callers without that source retain the V1 desk's Slack behavior.
      const kinds = requestedKinds?.filter((kind): kind is EvidenceDeskKindV1 => kind !== 'ticket' && (slack === undefined || kind !== 'slack_message')) ?? (slack === undefined ? undefined : LOCAL_KINDS);
      const pages: { readonly source: Source; readonly result: EvidenceDeskResultV2 }[] = [];
      if (kinds?.length !== 0) {
        const result = await base.search({ ...request, ...(kinds === undefined ? {} : { kinds }) });
        input.signal?.throwIfAborted();
        pages.push({ source: base, result });
      }
      for (const [source, kind] of [[ticket, 'ticket'], [slack, 'slack_message']] as const) {
        if (source === undefined || (requestedKinds !== undefined && !requestedKinds.includes(kind))) continue;
        const result = input.query === undefined
          ? await source.list({ limit: Math.min(maximum, 20), signal: input.signal })
          : await source.search({ query: input.query, limit: Math.min(maximum, 5), signal: input.signal });
        input.signal?.throwIfAborted();
        pages.push({ source, result });
      }
      if (pages.length === 1 && pages[0]!.source === base) return remember(pages[0]!.result, base);
      // Take one item from each nonempty source before taking any second
      // item. A full ticket page cannot hide the matching local/Slack items.
      const selected: EvidenceDeskResultV2['items'][number][] = [];
      for (let index = 0; selected.length < maximum; index += 1) {
        let found = false;
        for (const page of pages) {
          const item = page.result.items[index];
          if (item === undefined) continue;
          found = true;
          if (selected.length === maximum) break;
          remember({ items: [item], truncated: false, receipt_digests: [] }, page.source);
          selected.push(item);
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
      const result = source === base ? await base.open(input) : await source.open({ item: input.item, signal: input.signal });
      input.signal?.throwIfAborted();
      return remember(result, source);
    },
    async list(input) {
      input.signal?.throwIfAborted();
      if (input.source !== 'ticket' && (input.source !== 'slack' || slack === undefined)) {
        const { kinds, ...request } = input;
        if (kinds?.includes('ticket')) refused();
        const result = await base.list({ ...request, source: input.source, ...(kinds === undefined ? {} : { kinds: kinds.filter(kind => kind !== 'ticket') }) });
        input.signal?.throwIfAborted();
        return remember(result, base);
      }
      const source = input.source === 'ticket' ? ticket : slack;
      const kind = input.source === 'ticket' ? 'ticket' : 'slack_message';
      if (source === undefined || (input.source === 'ticket' && input.channel !== undefined) || input.kinds?.some(value => value !== kind)) refused();
      const result = await source!.list({ ...(input.channel === undefined ? {} : { container: input.channel }), limit: Math.min(input.limit ?? 20, 20), since: input.since, until: input.until, cursor: input.cursor, signal: input.signal });
      input.signal?.throwIfAborted();
      return remember(result, source!);
    },
    async revalidate(input) {
      input.signal?.throwIfAborted();
      const checked = await base.revalidate(input);
      input.signal?.throwIfAborted();
      if (ticket === undefined && slack === undefined) return checked;
      for (const source of [ticket, slack]) {
        if (source === undefined) continue;
        await source.revalidate(input);
        input.signal?.throwIfAborted();
      }
      // Local snapshots and original grants may change while a live reader awaits provider I/O.
      const final = await base.revalidate(input);
      input.signal?.throwIfAborted();
      // A prior source's ECHO grant may change while a later provider or the
      // base fence awaits. Finish with all local grants in one synchronous turn.
      for (const source of [ticket, slack]) source?.assertCurrent();
      input.signal?.throwIfAborted();
      return final;
    },
  });
}
