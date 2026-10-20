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

/**
 * A tool of four channels behind the shared reader and its audited source. An exact read can hide one or find it
 * malformed; a page or a search leaves a malformed one out and counts it, as a tool's own parsing does.
 */
async function fixture(pinned?: readonly string[]) {
  const state = {
    containers: new Map<string, PersonToolContainerV1>(['1', '2', '3', '4'].map(id => [id, { id, key: `C${id}`, name: `Channel ${id}` }])),
    hidden: new Set<string>(), malformed: new Set<string>(), rejected: false,
    echo: new Map<string, readonly string[]>([['2', ['Launchscope']]]),
  };
  const shown = (rows: readonly PersonToolContainerV1[]) => ({ containers: rows.filter(row => !state.malformed.has(row.id)), left_out: rows.filter(row => state.malformed.has(row.id)).length });
  const provider = {
    binding, tool: 'Fixture', container: 'slack_channel', noun: 'Fixture channel', failure, fence: vi.fn(),
    verify: vi.fn(async () => 'https://fixture.example.test'),
    permalink: (origin, container) => `${origin}/channels/${container.key}`,
    page: vi.fn(async ({ cursor, limit }: { readonly cursor?: string; readonly limit: number }) => {
      const start = Number(cursor ?? '0');
      return { ...shown([...state.containers.values()].slice(start, start + limit)), ...(start + limit < state.containers.size ? { next: String(start + limit) } : {}) };
    }),
    candidates: vi.fn(async () => ({ ...shown([...state.containers.values()]), more: false })),
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
  it('refuses dates and a container selector before reading, pins a project scope, fences every check, rechecks what it released, and refuses malformed answers', async () => {
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
    // A provider answer that names one channel twice, or another channel than the one asked for, releases nothing.
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

  it('names at most ten mapped ECHO projects, then how many more', async () => {
    const f = await fixture();
    const names = Array.from({ length: 12 }, (_, index) => `Project ${String(index + 1).padStart(2, '0')}`);
    f.state.echo.set('1', names);
    const [item] = (await f.source.list({ limit: 1 })).items;
    expect(item!.text).toBe(`Fixture channel C1: Channel 1\nECHO projects: ${names.slice(0, 10).join(', ')}, and 2 more`);
  });

  it('names mapped ECHO projects only whole, as many as fit its text, then how many more', async () => {
    const f = await fixture();
    const names = Array.from({ length: 10 }, (_, index) => `Project ${String(index + 1).padStart(2, '0')} ${'x'.repeat(150)}`);
    f.state.echo.set('1', names);
    const text = (await f.source.list({ limit: 1 })).items[0]!.text!;
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1024);
    const [head, projects] = text.split('\nECHO projects: ');
    expect(head).toBe('Fixture channel C1: Channel 1');
    const listed = projects!.split(', ');
    const more = /^and (\d+) more$/.exec(listed.pop()!);
    expect(listed).toEqual(names.slice(0, listed.length));
    expect(listed.length + Number(more?.[1])).toBe(10);
  });

  it('keeps the first mapped ECHO project whole beside a very long container name, cutting that name instead', async () => {
    const f = await fixture(); f.state.containers.set('1', { id: '1', key: 'C1', name: 'E'.repeat(1000) });
    f.state.echo.set('1', ['Atlas', 'Launchscope']);
    const text = (await f.source.list({ limit: 1 })).items[0]!.text!;
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1024);
    expect(text).toMatch(/^Fixture channel C1: E+\nECHO projects: Atlas, and 1 more$/);
  });

  it.each([
    ['renamed in its tool', 'stale_access_state', (f: Awaited<ReturnType<typeof fixture>>) => { f.state.containers.set('3', { id: '3', key: 'C3', name: 'Channel Three' }); }],
    ['re-keyed in its tool', 'stale_access_state', (f: Awaited<ReturnType<typeof fixture>>) => { f.state.containers.set('3', { id: '3', key: 'CX', name: 'Channel 3' }); }],
    ['no longer visible', 'not_found', (f: Awaited<ReturnType<typeof fixture>>) => { f.state.hidden.add('1'); }],
    ['no longer mapped to a visible ECHO project', 'stale_access_state', (f: Awaited<ReturnType<typeof fixture>>) => { f.state.echo.delete('2'); }],
  ])('revalidates every released container: one %s stops reuse', async (_change, code, change) => {
    const f = await fixture();
    await f.source.list({});
    await expect(f.source.revalidate({})).resolves.toBeUndefined();
    change(f);
    await expect(f.source.revalidate({})).rejects.toMatchObject({ code });
  });

  it('revalidates every release of a container, not only its latest', async () => {
    const f = await fixture();
    const [listed] = (await f.source.list({ limit: 1 })).items;
    f.state.containers.set('1', { id: '1', key: 'C1', name: 'Channel One' });
    expect((await f.source.open({ item: listed!.id })).items[0]!.label).toBe('Channel One');
    // The list released the old name too, and it is no longer what the asker sees.
    await expect(f.source.revalidate({})).rejects.toMatchObject({ code: 'stale_access_state' });
  });

  it('compares a check against the ECHO projects named after the tool answers, so a change during the check is seen', async () => {
    const f = await fixture();
    await f.source.list({});
    const answer = f.provider.exact.getMockImplementation()!;
    f.provider.exact.mockImplementation(async (id: string) => { const value = await answer(id); f.state.echo.delete('2'); return value; });
    await expect(f.source.revalidate({})).rejects.toMatchObject({ code: 'stale_access_state' });
  });

  it('finds what it can show when a container that may match cannot be shown, and says so', async () => {
    const f = await fixture(); f.state.malformed.add('3');
    const found = await f.source.search({ query: 'Channel 1' });
    expect(found.items.map(item => item.label)).toEqual(['Channel 1']);
    expect(found.notice).toBe(LEFT_OUT);
  });

  it("pages on from where the tool's page ended, past a container it left out", async () => {
    const f = await fixture(); f.state.malformed.add('1');
    const first = await f.source.list({ limit: 2 });
    expect(first.items.map(item => item.label)).toEqual(['Channel 2']);
    expect(first).toMatchObject({ truncated: true, next_cursor: expect.any(String), notice: LEFT_OUT });
    const second = await f.source.list({ limit: 2, cursor: first.next_cursor });
    expect(second.items.map(item => item.label)).toEqual(['Channel 3', 'Channel 4']);
    expect(f.provider.page.mock.calls.map(([input]) => input.cursor)).toEqual([undefined, '2']);
    // A last page that held its full size before a row was left out still cannot confirm the list's end (ADR-0041).
    const whole = await f.source.list({ limit: 4 });
    expect(whole.items).toHaveLength(3);
    expect(whole).toMatchObject({ truncated: false, page_full: true, notice: LEFT_OUT });
  });
});
