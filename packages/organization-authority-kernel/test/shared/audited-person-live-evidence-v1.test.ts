import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256, type Sha256Digest } from '@echo-brain/federation-protocol';
import { validatePersonTicketCitationV1, type PersonConnectorAccessV1, type PersonSlackMessageCitationV1, type PersonTicketCitationV1 } from '@echo-brain/organization-api';
import { AuthorityOperationError } from '../../src/domain/errors.js';
import { createAuditedPersonLiveEvidenceSourceV1 } from '../../src/shared/audited-person-live-evidence-v1.js';
import type { PersonConnectorReadBindingV1, PersonLiveEvidenceCitationV1, PersonLiveEvidencePageV1, PersonLiveEvidenceReaderV1, PersonLiveEvidenceReleaseV1, PersonLiveEvidenceValueV1 } from '../../src/shared/person-live-evidence-v1.js';

const actor = { organization_id: 'org_00000000-0000-4000-8000-000000000001', principal_id: 'person-one', membership_id: 'mem_00000000-0000-4000-8000-000000000001' };
const read_grant_sha256 = canonicalSha256({ grant: 1 });
const textDigest = (text: string): Sha256Digest => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
const access = (tool_id = 'tickets'): PersonConnectorAccessV1 => ({ tool_id, identity_status: 'linked', external_scope_id: tool_id === 'slack' ? 'T123' : 'tenant-1', external_subject_id: 'subject-one', read_status: 'connected', read_capabilities: ['live_evidence'] });
const binding = (tool_id = 'tickets'): PersonConnectorReadBindingV1 => ({ ...actor, tool_id, external_scope_id: access(tool_id).external_scope_id, external_subject_id: 'subject-one', read_grant_sha256 });
const ticket = (text = 'Ship the new integration', ticket_id = 'ECHO-42'): PersonLiveEvidenceValueV1<PersonTicketCitationV1> => ({
  handle: `private:${ticket_id}`, label: ticket_id, text, visibility: 'only_me', occurred_at: '2026-09-30', attributes: { status: 'In progress', owner: 'Alex' },
  citation: { kind: 'ticket', tool_id: 'tickets', external_scope_id: 'tenant-1', ticket_id, permalink: `https://tickets.example.test/browse/${ticket_id}`, text_sha256: textDigest(text) },
});
const slack = (): PersonLiveEvidenceValueV1<PersonSlackMessageCitationV1> => ({
  handle: 'private:channel-and-thread', label: '#launch · Alex', text: 'Launch is Friday', visibility: 'team',
  citation: { kind: 'slack_message', team_id: 'T123', channel_id: 'C123', message_ts: '1758873600.000100', permalink: 'https://example.slack.com/archives/C123/p1758873600000100', text_sha256: textDigest('Launch is Friday') },
});
const slackCitation = (value: unknown): PersonSlackMessageCitationV1 => {
  if ((value as { readonly kind?: unknown } | null)?.kind !== 'slack_message') throw new Error('Slack citation kind is invalid');
  return value as PersonSlackMessageCitationV1;
};
const page = <C extends PersonLiveEvidenceCitationV1>(items: readonly PersonLiveEvidenceValueV1<C>[], next_cursor?: string): PersonLiveEvidencePageV1<C> => ({ items, truncated: false, ...(next_cursor === undefined ? {} : { next_cursor }) });

function fixture<C extends PersonLiveEvidenceCitationV1>(tool_id: string, initial: PersonLiveEvidencePageV1<C>) {
  let selected = initial;
  const releases: PersonLiveEvidenceReleaseV1<C>[] = [];
  const events: string[] = [];
  const reader: PersonLiveEvidenceReaderV1<C> = {
    binding: binding(tool_id),
    validateCitation(value) {
      const citation = tool_id === 'slack' ? slackCitation(value) : validatePersonTicketCitationV1(value);
      return { citation: citation as C, tool_id: citation.kind === 'ticket' ? citation.tool_id : 'slack', external_scope_id: citation.kind === 'ticket' ? citation.external_scope_id : citation.team_id, coordinates: { object_id: citation.kind === 'ticket' ? citation.ticket_id : citation.message_ts, ...(citation.kind === 'ticket' ? {} : { container_id: citation.channel_id }) } };
    },
    search: vi.fn(async () => { events.push('read'); return selected; }),
    open: vi.fn(async () => { events.push('open'); return selected; }),
    list: vi.fn(async () => { events.push('list'); return selected; }),
    revalidate: vi.fn(async () => { events.push('provider-check'); }),
  };
  const authorization = { requireCurrent: vi.fn(async () => { events.push('grant-check'); }) };
  const audit = { record: vi.fn(async (release: PersonLiveEvidenceReleaseV1<C>) => { events.push('audit'); releases.push(release); return canonicalSha256(release); }) };
  const options = { actor, access: access(tool_id), read_grant_sha256, authorization, reader, audit };
  return { options, reader, audit, authorization, releases, events, select: (value: PersonLiveEvidencePageV1<C>) => { selected = value; }, make: () => createAuditedPersonLiveEvidenceSourceV1(options) };
}

describe('shared audited live evidence source V1', () => {
  it.each(['slack', 'tickets'])('uses the same person-bound release boundary for %s', async tool_id => {
    const item = tool_id === 'slack' ? slack() : ticket();
    const f = fixture(tool_id, page<PersonLiveEvidenceCitationV1>([item]));
    const source = f.make();
    const result = await source.search({ query: 'launch' });
    expect(f.events).toEqual(['grant-check', 'read', 'grant-check', 'audit', 'grant-check']);
    expect(result.items).toEqual([expect.objectContaining({ kind: item.citation.kind, text: item.text, citation: item.citation, receipt_sha256: canonicalSha256(f.releases[0]!) })]);
    expect(result.items[0]).not.toHaveProperty('handle');
    expect(JSON.stringify(f.releases)).not.toContain(item.text!);
    expect(f.releases[0]!.citations[0]).not.toHaveProperty('label');
    const { handle: _handle, ...releasedValue } = item;
    expect(f.releases[0]!.value_digests).toEqual([canonicalSha256(releasedValue)]);
    expect(JSON.stringify(f.releases)).not.toContain(item.handle);
    expect(Object.isFrozen(result.items[0])).toBe(true);
    expect(f.authorization.requireCurrent).toHaveBeenCalledWith(binding(tool_id), {});
    await source.revalidate({});
    expect(f.reader.revalidate).toHaveBeenCalledWith({ citations: [item.citation] });
  });

  it('refuses an identity-only link, export-only grant, revoked grant and reader for another person/tenant/grant', () => {
    const f = fixture('tickets', page([ticket()]));
    for (const altered of [
      { ...f.options, access: { ...access(), read_status: 'not_connected' as const, read_capabilities: [] } },
      { ...f.options, access: { ...access(), read_capabilities: ['source_export' as const] } },
      { ...f.options, access: { ...access(), read_status: 'revoked' as const, read_capabilities: [] } },
      ...[{ principal_id: 'another-person' }, { organization_id: 'org_00000000-0000-4000-8000-000000000002' }, { membership_id: 'mem_00000000-0000-4000-8000-000000000002' }, { external_subject_id: 'someone-else' }, { external_scope_id: 'another-tenant' }, { read_grant_sha256: canonicalSha256({ grant: 2 }) }].map(drift => ({ ...f.options, reader: { ...f.reader, binding: { ...binding(), ...drift } } })),
    ]) expect(() => createAuditedPersonLiveEvidenceSourceV1(altered)).toThrow(AuthorityOperationError);
    expect(f.reader.search).not.toHaveBeenCalled();
  });

  it('rejects drift during a read and during audit before returning any evidence', async () => {
    for (const failAt of [2, 3]) {
      const f = fixture('tickets', page([ticket()]));
      let calls = 0;
      f.authorization.requireCurrent.mockImplementation(async () => {
        if (++calls === failAt) throw new AuthorityOperationError('stale_access_state', 'private grant state');
      });
      await expect(f.make().search({ query: 'launch' })).rejects.toMatchObject({ code: 'stale_access_state', message: 'Live evidence operation could not be completed' });
      expect(f.audit.record).toHaveBeenCalledTimes(failAt === 2 ? 0 : 1);
    }
  });

  it('fails closed when auditing fails or returns a malformed receipt', async () => {
    const f = fixture('tickets', page([ticket()]));
    f.audit.record.mockRejectedValueOnce(new Error('private token and ticket body'));
    await expect(f.make().search({ query: 'launch' })).rejects.toMatchObject({ code: 'unavailable', message: 'Live evidence operation could not be completed' });
    f.audit.record.mockResolvedValueOnce('bad-receipt' as Sha256Digest);
    await expect(f.make().search({ query: 'launch' })).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('rejects malformed or oversized output and citations from the wrong scope/provider before audit', async () => {
    const f = fixture('tickets', page([ticket()]));
    for (const item of [
      { ...ticket(), citation: { ...ticket().citation, external_scope_id: 'tenant-two' } },
      { ...ticket(), citation: { ...ticket().citation, tool_id: 'another-tool' } },
      { ...ticket(), citation: { ...ticket().citation, text_sha256: textDigest('different bytes') } },
      { ...ticket(), text: 'x'.repeat(3073) },
      { ...ticket(), label: 'x'.repeat(1025) },
      { ...ticket(), occurred_at: '2026-02-30' },
      { ...ticket(), attributes: { status: 'In progress', token: 'secret' } },
    ]) {
      f.select(page([item]));
      await expect(f.make().search({ query: 'launch' })).rejects.toMatchObject({ code: 'invalid_output' });
    }
    f.select(page([ticket(), ticket()]));
    await expect(f.make().search({ query: 'launch' })).rejects.toMatchObject({ code: 'invalid_output' });
    f.select(page([ticket(), ticket('Another ticket', 'ECHO-43')]));
    await expect(f.make().search({ query: 'launch', limit: 1 })).rejects.toMatchObject({ code: 'invalid_output' });
    expect(f.audit.record).not.toHaveBeenCalled();
    const s = fixture('slack', page([{ ...slack(), citation: { ...slack().citation, team_id: 'T999' } }]));
    await expect(s.make().search({ query: 'launch' })).rejects.toMatchObject({ code: 'invalid_output' });
    expect(s.audit.record).not.toHaveBeenCalled();
  });

  it('revalidates inventory metadata, repeated revisions and provider item visibility before reuse', async () => {
    const inventoryCitation = { ...ticket().citation, text_sha256: textDigest('') };
    const f = fixture('tickets', page([{ ...ticket(), citation: inventoryCitation, text: undefined }]));
    const source = f.make();
    const inventory = await source.list({ container: 'ECHO' });
    expect(inventory.items[0]).not.toHaveProperty('text');
    f.select(page([ticket()]));
    await source.open({ item: inventory.items[0]!.id });
    expect(f.reader.open).toHaveBeenCalledWith({ handle: ticket().handle, limit: 10 });
    f.select(page([ticket('The ticket was edited')]));
    await source.search({ query: 'edited' });
    await source.revalidate({});
    expect(f.reader.revalidate).toHaveBeenLastCalledWith({ citations: [inventoryCitation, ticket().citation, ticket('The ticket was edited').citation] });
    vi.mocked(f.reader.revalidate).mockRejectedValueOnce(new AuthorityOperationError('unauthorized', 'Ticket is now hidden'));
    await expect(source.revalidate({})).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('commits empty releases without exposing the query or provider cursor and scopes continuations to their list', async () => {
    const f = fixture('tickets', page<PersonTicketCitationV1>([], 'private-provider-cursor'));
    const source = f.make();
    const first = await source.list({ container: 'ECHO', since: '2026-09-01', limit: 3 });
    expect(first).toMatchObject({ items: [], truncated: true });
    expect(first.receipt_digests).toHaveLength(1);
    expect(first.next_cursor).not.toBe('private-provider-cursor');
    expect(JSON.stringify(f.releases)).not.toContain('private-provider-cursor');
    await source.list({ container: 'ECHO', since: '2026-09-01', cursor: first.next_cursor });
    expect(f.reader.list).toHaveBeenLastCalledWith({ container: 'ECHO', since: '2026-09-01', limit: 10, cursor: 'private-provider-cursor' });
    for (const input of [{ container: 'another-project', since: '2026-09-01', cursor: first.next_cursor }, { container: 'ECHO', cursor: first.next_cursor }, { cursor: 'private-provider-cursor' }]) {
      await expect(source.list(input)).rejects.toMatchObject({ code: 'invalid_request' });
    }
    f.select(page([]));
    await source.search({ query: 'private query' });
    expect(f.releases.at(-1)).toMatchObject({ operation: 'search', citations: [] });
    expect(JSON.stringify(f.releases)).not.toContain('private query');
  });

  it('refuses model-authored open coordinates and sends only the issued provider handle', async () => {
    const f = fixture('tickets', page([ticket()]));
    const source = f.make();
    await expect(source.open({ item: 'ECHO-42' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(source.open({ item: ticket().citation.permalink })).rejects.toMatchObject({ code: 'not_found' });
    expect(f.reader.open).not.toHaveBeenCalled();
    const result = await source.search({ query: 'ship' });
    await source.open({ item: result.items[0]!.id });
    expect(f.reader.open).toHaveBeenCalledWith({ handle: 'private:ECHO-42', limit: 10 });
    await expect(f.make().open({ item: result.items[0]!.id })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects a continuation from a different request even when both have listed the same project', async () => {
    const f = fixture('tickets', page<PersonTicketCitationV1>([], 'private-cursor'));
    const first = f.make(); const second = f.make();
    const a = await first.list({ container: 'ECHO' });
    const b = await second.list({ container: 'ECHO' });
    expect(a.next_cursor).not.toBe(b.next_cursor);
    await expect(second.list({ container: 'ECHO', cursor: a.next_cursor })).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('rejects a changed reader binding after construction and audits no stale release', async () => {
    const f = fixture('tickets', page([ticket()]));
    const source = f.make();
    Object.assign(f.reader.binding, { external_subject_id: 'another-person' });
    await expect(source.search({ query: 'ship' })).rejects.toMatchObject({ code: 'stale_access_state' });
    expect(f.reader.search).not.toHaveBeenCalled();
    expect(f.audit.record).not.toHaveBeenCalled();
  });

  it('bounds the aggregate release before auditing and rejects sparse or accessor output without evaluating it', async () => {
    const f = fixture('tickets', page(Array.from({ length: 50 }, (_, i) => ticket('x'.repeat(3000), `ECHO-${i}`))));
    await expect(f.make().search({ query: 'ship', limit: 50 })).rejects.toMatchObject({ code: 'invalid_output' });
    f.select(page(Array(1)));
    await expect(f.make().search({ query: 'ship' })).rejects.toMatchObject({ code: 'invalid_output' });
    const getter = vi.fn(() => { throw new Error('private provider response'); });
    f.select(page([Object.defineProperty(ticket(), 'text', { get: getter, enumerable: true })]));
    await expect(f.make().search({ query: 'ship' })).rejects.toMatchObject({ code: 'invalid_output' });
    expect(getter).not.toHaveBeenCalled();
    expect(f.audit.record).not.toHaveBeenCalled();
  });

  it('retains immutable release bytes while an asynchronous audit is pending', async () => {
    const mutable = { ...ticket(), attributes: { status: 'In progress' } };
    const f = fixture('tickets', page([mutable]));
    f.audit.record.mockImplementationOnce(async release => {
      mutable.text = 'Changed after audit began'; mutable.label = 'Changed'; mutable.attributes.status = 'Changed';
      return canonicalSha256(release);
    });
    const result = await f.make().search({ query: 'ship' });
    expect(result.items[0]).toMatchObject({ text: 'Ship the new integration', label: 'ECHO-42', attributes: { status: 'In progress' } });
  });

  it('bounds input, propagates cancellation and suppresses raw provider error content', async () => {
    const f = fixture('tickets', page([ticket()]));
    const source = f.make();
    for (const value of [0, 51, 1.5, NaN]) await expect(source.search({ query: 'ship', limit: value })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(source.list({ since: '2026-02-30' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(source.list({ since: '2026-09-30', until: '2026-09-01' })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(f.reader.search).not.toHaveBeenCalled();
    vi.mocked(f.reader.search).mockRejectedValueOnce(new Error('secret-token with raw ticket text'));
    await expect(source.search({ query: 'ship' })).rejects.toMatchObject({ message: 'Live evidence operation could not be completed' });
    const controller = new AbortController();
    vi.mocked(f.reader.search).mockImplementationOnce(async () => { controller.abort(); return page([ticket()]); });
    await expect(source.search({ query: 'ship', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.audit.record).not.toHaveBeenCalled();
  });
});
