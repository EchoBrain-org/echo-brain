import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type { PersonToolContainerCitationV1 } from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { createAuditedPersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/audited-person-live-evidence-v1';
import type { PersonConnectorReadBindingV1, PersonLiveEvidenceReleaseV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import type { PersonProviderFailureCodeV1 } from '../src/person-provider-v1.js';
import { createPersonToolContainerReaderV1, type PersonToolContainerProviderV1, type PersonToolContainerV1 } from '../src/person-tool-container-reader-v1.js';

const binding: PersonConnectorReadBindingV1 = Object.freeze({ organization_id: 'synthetic-org', principal_id: 'synthetic-person', membership_id: 'synthetic-member',
  tool_id: 'fixture', external_scope_id: 'site-1', external_subject_id: 'synthetic-account', read_grant_sha256: canonicalSha256({ synthetic_grant: 1 }) });
const LEFT_OUT = 'Some Fixture channels could not be shown, so these results leave them out.';
const failure = (code: PersonProviderFailureCodeV1): never => { throw new AuthorityOperationError(code, 'Fixture tool refused'); };

/** A tool of four channels, any of which an exact read can hide or find malformed, behind the shared reader and its audited source. */
async function fixture(pinned?: readonly string[]) {
  const state = {
    containers: new Map<string, PersonToolContainerV1>(['1', '2', '3', '4'].map(id => [id, { id, key: `C${id}`, name: `Channel ${id}` }])),
    hidden: new Set<string>(), malformed: new Set<string>(), rejected: false,
    echo: new Map<string, readonly string[]>([['2', ['Launchscope']]]),
  };
  const provider = {
    binding, tool: 'Fixture', container: 'slack_channel', noun: 'Fixture channel', failure, fence: vi.fn(),
    verify: vi.fn(async () => 'https://fixture.example.test'),
    permalink: (origin, container) => `${origin}/channels/${container.key}`,
    page: vi.fn(async ({ cursor, limit }: { readonly cursor?: string; readonly limit: number }) => {
      const start = Number(cursor ?? '0');
      return { containers: [...state.containers.values()].slice(start, start + limit), left_out: 0, ...(start + limit < state.containers.size ? { next: String(start + limit) } : {}) };
    }),
    candidates: vi.fn(async () => ({ containers: [...state.containers.values()], left_out: 0, more: false })),
    exact: vi.fn(async (id: string) => {
      if (state.rejected) failure('unauthorized');
      const container = state.containers.get(id);
      if (container === undefined || state.hidden.has(id)) failure('not_found');
      if (state.malformed.has(id)) failure('invalid_output');
      return container!;
    }),
  } satisfies PersonToolContainerProviderV1;
  const audit = { record: vi.fn(async (release: PersonLiveEvidenceReleaseV1<PersonToolContainerCitationV1>) => canonicalSha256(release)) };
  const reader = await createPersonToolContainerReaderV1({ provider, echo_projects: () => state.echo, ...(pinned === undefined ? {} : { pinned }) });
  const source = createAuditedPersonLiveEvidenceSourceV1({ actor: binding, read_grant_sha256: binding.read_grant_sha256, reader, audit, authorization: { assertCurrent: () => {} },
    access: { tool_id: 'fixture', identity_status: 'linked', external_scope_id: 'site-1', external_subject_id: binding.external_subject_id, read_status: 'connected', read_capabilities: ['live_evidence'] } });
  return { state, provider, audit, source };
}

describe('the shared tool container reader (research tool contract v1)', () => {
  it('refuses dates and a container selector before reading, pins a project scope, fences every check, and rechecks what it released', async () => {
    const f = await fixture(['1', '2', '3', '4']);
    expect(f.provider.fence).toHaveBeenCalledTimes(2);
    for (const call of [() => f.source.list({ since: '2026-10-01' }), () => f.source.search({ query: 'one', until: '2026-10-01' }), () => f.source.list({ container: 'C1' })]) {
      await expect(call()).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(f.provider.verify).toHaveBeenCalledTimes(1);
    // A project scope reads only its mapped channels, exactly: one hidden is left out unsaid, one it cannot show is left out and said.
    f.state.hidden.add('3'); f.state.malformed.add('4');
    const first = await f.source.list({ limit: 1 });
    expect(first.items.map(item => [item.label, item.text])).toEqual([['Channel 1', 'Fixture channel C1: Channel 1']]);
    expect(first).toMatchObject({ truncated: true, next_cursor: expect.any(String), notice: LEFT_OUT });
    const second = await f.source.list({ limit: 1, cursor: first.next_cursor });
    expect(second.items.map(item => [item.label, item.text])).toEqual([['Channel 2', 'Fixture channel C2: Channel 2\nECHO projects: Launchscope']]);
    expect(second).toMatchObject({ truncated: false, page_full: false });
    expect(f.provider.page).not.toHaveBeenCalled(); expect(f.provider.candidates).not.toHaveBeenCalled();
    expect((await f.source.search({ query: 'channel 2' })).items.map(item => item.label)).toEqual(['Channel 2']);
    // Every connection check sits between two fences of the reader's binding.
    expect(f.provider.fence).toHaveBeenCalledTimes(2 * f.provider.verify.mock.calls.length);
    await expect(f.source.revalidate({})).resolves.toBeUndefined();
    f.state.containers.set('2', { id: '2', key: 'C2', name: 'Channel Two' });
    await expect(f.source.revalidate({})).rejects.toMatchObject({ code: 'stale_access_state' });
    f.state.rejected = true;
    await expect(f.source.revalidate({})).rejects.toMatchObject({ code: 'unauthorized' });
    // A refused connection says nothing about one channel, so a list or search fails rather than end empty and complete.
    await expect(f.source.list({})).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(f.source.search({ query: 'channel' })).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('refuses a provider answer that names one channel twice, or another channel than it asked for, before anything is released', async () => {
    const twice = await fixture();
    twice.provider.page.mockResolvedValueOnce({ containers: [twice.state.containers.get('1')!, twice.state.containers.get('1')!], left_out: 0 });
    await expect(twice.source.list({})).rejects.toMatchObject({ code: 'invalid_output' });
    twice.provider.candidates.mockResolvedValueOnce({ containers: [twice.state.containers.get('2')!, twice.state.containers.get('2')!], left_out: 0, more: false });
    await expect(twice.source.search({ query: 'channel' })).rejects.toMatchObject({ code: 'invalid_output' });
    const other = await fixture();
    const [listed] = (await other.source.list({ limit: 1 })).items;
    other.provider.exact.mockResolvedValueOnce(other.state.containers.get('2')!);
    await expect(other.source.open({ item: listed!.id })).rejects.toMatchObject({ code: 'invalid_output' });
    expect([...twice.audit.record.mock.calls, ...other.audit.record.mock.calls]).toHaveLength(1);
  });
});
