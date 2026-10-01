import { describe, expect, it, vi } from 'vitest';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { EvidenceDeskPortV1 } from '@echo-brain/organization-authority-kernel/shared/evidence-desk-v1';
import type { PersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { createPersonLiveEvidenceDeskV2 } from '../src/composition/person-live-evidence-desk-v2.js';
const empty = { items: [], truncated: false, receipt_digests: [] };
function fixture(scope: EvidenceDeskPortV1['scope'] = { kind: 'global' }) {
  let current = true;
  const base: EvidenceDeskPortV1 = { scope, search: vi.fn(async () => empty), open: vi.fn(async () => empty), list: vi.fn(async () => empty), revalidate: vi.fn(async () => { if (!current) throw new AuthorityOperationError('stale_access_state', 'Fixture base grant revoked'); return { checked_at: '2026-10-01T00:00:00.000Z' }; }) };
  const ticket: PersonLiveEvidenceSourceV1 = { tool_id: 'jira', search: vi.fn(async () => empty), open: vi.fn(async () => empty), list: vi.fn(async () => empty), revalidate: vi.fn(async () => {}) };
  return { base, ticket, revokeBase: () => { current = false; } };
}
describe('thin live ticket dispatcher', () => {
  it('rechecks local grants/snapshot after provider visibility awaits, suppressing mixed evidence after drift', async () => {
    const f = fixture(); vi.mocked(f.ticket.revalidate).mockImplementation(async () => { f.revokeBase(); });
    await expect(createPersonLiveEvidenceDeskV2(f.base, f.ticket).revalidate({})).rejects.toMatchObject({ code: 'stale_access_state' });
    expect(f.base.revalidate).toHaveBeenCalledTimes(2);
  });
  it.each([{ kind: 'mine' as const }, { kind: 'project' as const, project_id: 'prj_00000000-0000-4000-8000-000000000001' as const }])('excludes tickets in unsupported scope and refuses explicit ticket reads without global fallback', async scope => {
    const f = fixture(scope);
    expect(() => createPersonLiveEvidenceDeskV2(f.base, f.ticket)).toThrow(AuthorityOperationError);
    const desk = createPersonLiveEvidenceDeskV2(f.base);
    await desk.search({ query: 'launch' });
    await expect(desk.list({ source: 'ticket' })).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(desk.search({ query: 'launch', kinds: ['ticket'] })).rejects.toMatchObject({ code: 'unauthorized' });
    expect(f.ticket.search).not.toHaveBeenCalled(); expect(f.ticket.list).not.toHaveBeenCalled();
  });
  it('does not forward live cursors or project/container selectors into other desk sources', async () => {
    const f = fixture(); const desk = createPersonLiveEvidenceDeskV2(f.base, f.ticket);
    await expect(desk.list({ source: 'ticket', channel: 'unsupported-project-map' })).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(desk.list({ source: 'document', kinds: ['ticket'] })).rejects.toMatchObject({ code: 'unauthorized' });
    expect(f.ticket.list).not.toHaveBeenCalled(); expect(f.base.list).not.toHaveBeenCalled();
  });
});
