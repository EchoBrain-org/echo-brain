import type { EvidenceDeskPortV1 } from '@echo-brain/organization-authority-kernel/shared/evidence-desk-v1';
import type { EvidenceDeskPortV2, EvidenceDeskResultV2 } from '@echo-brain/organization-authority-kernel/shared/evidence-desk-v2';
import type { PersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';

/** A request-owned dispatcher. Server composition selects the live source; models select only read tools. */
export function createPersonLiveEvidenceDeskV2(base: EvidenceDeskPortV1, ticket?: PersonLiveEvidenceSourceV1): EvidenceDeskPortV2 {
  if (ticket !== undefined && base.scope.kind !== 'global') throw new AuthorityOperationError('unauthorized', 'Live source is unsupported in this scope');
  const liveItems = new Set<string>();
  const remember = (result: EvidenceDeskResultV2) => { for (const item of result.items) liveItems.add(item.id); return result; };
  const refused = (): never => { throw new AuthorityOperationError('unauthorized', 'Live source is unavailable in this scope'); };
  return Object.freeze<EvidenceDeskPortV2>({
    scope: base.scope,
    async search(input) {
      const maximum = input.limit ?? 8;
      const { kinds: requestedKinds, ...request } = input;
      const kinds = requestedKinds?.filter(kind => kind !== 'ticket');
      const stored = kinds?.length === 0 ? { items: [], truncated: false, receipt_digests: [] } : await base.search({ ...request, ...(kinds === undefined ? {} : { kinds }) });
      if (ticket === undefined || (input.kinds !== undefined && !input.kinds.includes('ticket'))) {
        if (input.kinds?.includes('ticket')) refused();
        return stored;
      }
      const live = remember(input.query === undefined ? await ticket.list({ limit: Math.min(maximum, 20), signal: input.signal }) : await ticket.search({ query: input.query, limit: Math.min(maximum, 5), signal: input.signal }));
      const items = [...stored.items.slice(0, Math.max(0, maximum - live.items.length)), ...live.items];
      return Object.freeze({ items: Object.freeze(items), truncated: stored.truncated || live.truncated || stored.items.length + live.items.length > maximum, receipt_digests: Object.freeze([...stored.receipt_digests, ...live.receipt_digests]), ...('notice' in stored && stored.notice !== undefined ? { notice: stored.notice } : {}) });
    },
    async open(input) { return liveItems.has(input.item) ? remember(await ticket!.open({ item: input.item, signal: input.signal })) : base.open(input); },
    async list(input) {
      if (input.source !== 'ticket') {
        const { kinds, ...request } = input;
        if (kinds?.includes('ticket')) refused();
        return base.list({ ...request, source: input.source, ...(kinds === undefined ? {} : { kinds: kinds.filter(kind => kind !== 'ticket') }) });
      }
      if (ticket === undefined || input.channel !== undefined || input.kinds?.some(kind => kind !== 'ticket')) refused();
      return remember(await ticket!.list({ limit: Math.min(input.limit ?? 20, 20), since: input.since, until: input.until, cursor: input.cursor, signal: input.signal }));
    },
    async revalidate(input) {
      const checked = await base.revalidate(input);
      if (ticket === undefined) return checked;
      await ticket.revalidate(input);
      // Local snapshots and original grants may change while a live reader awaits provider I/O.
      return base.revalidate(input);
    },
  });
}
