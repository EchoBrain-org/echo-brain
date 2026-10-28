import { describe, expect, it, vi } from 'vitest';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { EvidenceDeskPortV2 } from '@echo-brain/organization-authority-kernel/shared/evidence-desk-v2';
import type { PersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import type { PersonLiveConnectorSourceV1 } from '../src/application/ports/person-context-live-runtime-v1.js';
import { bindPersonLiveEvidenceDeskV1, type CreatePersonLiveAnswerRouteOptionsV1, type PersonLiveRequestContextV1 } from '../src/composition/person-live-answer-route-v1.js';

const context: PersonLiveRequestContextV1 = Object.freeze({ authority_id: 'authority-fixture', organization_id: 'org-fixture', state_lineage_id: 'lineage-fixture',
  principal_id: 'person-fixture', membership_id: 'membership-fixture', session_family_id: 'session-fixture', request_id: 'ask_fixture' });
const empty = { items: [], truncated: false, receipt_digests: [] };
const sourceIds = (desk: EvidenceDeskPortV2) => (desk.live_sources ?? []).map(source => source.source_id);

function reader(tool_id: string): PersonLiveEvidenceSourceV1 {
  return { tool_id, search: vi.fn(async () => empty), open: vi.fn(async () => empty), list: vi.fn(async () => empty), revalidate: vi.fn(async () => {}), assertCurrent: vi.fn(() => {}) };
}

/** A catalog source whose binding settles after `delay` ms with its reader, nothing (unlinked) or a failure. */
function connector(kind: 'ticket' | 'page', delay: number, outcome: 'bound' | 'unlinked' | Error = 'bound') {
  const tool_id = kind === 'ticket' ? 'jira' : 'confluence';
  const bound = reader(tool_id);
  const source = vi.fn(({ signal }: { readonly signal?: AbortSignal }) => new Promise<PersonLiveEvidenceSourceV1 | undefined>((resolve, reject) => {
    const timer = setTimeout(() => outcome instanceof Error ? reject(outcome) : resolve(outcome === 'bound' ? bound : undefined), delay);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  }));
  const value = { descriptor: { source_id: kind, kind, selector: `${kind}s`, description: `Live ${kind}s.`, metadata_only_list: true, tool_id }, scopes: ['global', 'project'],
    application: { source } } as unknown as PersonLiveConnectorSourceV1;
  return { value, source, bound };
}

function options() {
  const forLiveRequest = vi.fn(() => ({ record: vi.fn() }));
  // The base desk reads ECHO context lazily; binding never touches it.
  return { forLiveRequest, value: { audit: { forLiveRequest }, originals: {}, records: {} } as unknown as CreatePersonLiveAnswerRouteOptionsV1 };
}

async function settle<T>(pending: Promise<T>, ms = 500): Promise<T> {
  const observed = pending.then(value => ({ value }), (error: unknown) => ({ error }));
  await vi.advanceTimersByTimeAsync(ms);
  const result = await observed;
  if ('error' in result) throw result.error;
  return result.value;
}

describe('binding live sources for one request', () => {
  it('binds sources concurrently and registers them in catalog order', async () => {
    vi.useFakeTimers();
    try {
      const ticket = connector('ticket', 80); const page = connector('page', 50);
      const { value, forLiveRequest } = options();
      const start = Date.now(); let elapsed = 0;
      const desk = await settle(bindPersonLiveEvidenceDeskV1(value, [ticket.value, page.value], { access_token: 'token-fixture', scope: { kind: 'global' } }, context)
        .then(result => { elapsed = Date.now() - start; return result; }));
      expect(elapsed).toBe(80);
      expect(sourceIds(desk)).toEqual(['ticket', 'page']);
      // One release witness for the request, shared by its sources, so their witnesses never share a sequence number.
      expect(forLiveRequest).toHaveBeenCalledTimes(1);
      expect(ticket.source).toHaveBeenCalledWith(expect.objectContaining({ access_token: 'token-fixture' }));
      const auditOf = (calls: readonly unknown[][]) => (calls[0]![0] as { readonly audit: unknown }).audit;
      expect(auditOf(ticket.source.mock.calls)).toBe(auditOf(page.source.mock.calls));
    } finally { vi.useRealTimers(); }
  });

  it('leaves out unlinked sources and binds nothing for the mine scope', async () => {
    vi.useFakeTimers();
    try {
      const ticket = connector('ticket', 10, 'unlinked'); const page = connector('page', 20);
      const desk = await settle(bindPersonLiveEvidenceDeskV1(options().value, [ticket.value, page.value], { access_token: 'token-fixture', scope: { kind: 'project', project_id: 'project-fixture' } }, context));
      expect(sourceIds(desk)).toEqual(['page']);
      expect(page.source).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'project-fixture' }));

      const mine = connector('ticket', 10);
      const none = await settle(bindPersonLiveEvidenceDeskV1(options().value, [mine.value], { access_token: 'token-fixture', scope: { kind: 'mine' } }, context));
      expect(sourceIds(none)).toEqual([]);
      expect(mine.source).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it.each([
    ['the first source fails after the second binds', 50, 10, 'first'],
    ['the second source fails while the first binds', 10, 50, 'second'],
    ['both fail, the later one first', 50, 10, 'both'],
  ] as const)('fails with the first failure in catalog order when %s', async (_label, ticketDelay, pageDelay, failing) => {
    vi.useFakeTimers();
    try {
      const first = new AuthorityOperationError('unauthorized', 'Fixture ticket grant revoked');
      const second = new AuthorityOperationError('unavailable', 'Fixture page outage');
      const ticket = connector('ticket', ticketDelay, failing === 'second' ? 'bound' : first);
      const page = connector('page', pageDelay, failing === 'first' ? 'bound' : second);
      await expect(settle(bindPersonLiveEvidenceDeskV1(options().value, [ticket.value, page.value], { access_token: 'token-fixture', scope: { kind: 'global' } }, context)))
        .rejects.toBe(failing === 'second' ? second : first);
    } finally { vi.useRealTimers(); }
  });

  it('stops on cancellation while sources are binding', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const ticket = connector('ticket', 50); const page = connector('page', 80);
      const pending = bindPersonLiveEvidenceDeskV1(options().value, [ticket.value, page.value], { access_token: 'token-fixture', scope: { kind: 'global' }, signal: controller.signal }, context);
      setTimeout(() => controller.abort(), 20);
      await expect(settle(pending)).rejects.toMatchObject({ name: 'AbortError' });
    } finally { vi.useRealTimers(); }
  });
});
