import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyOrganizationRecordLogBaselineV6 } from '@echo-brain/organization-record/organization-record-api-v1';
import { authorityRecordPolicyProjectorsV1 } from '../src/composition/authority-record-protocols-v1.js';
import { openPersonMeetingRuntimeV1 } from '../src/composition/person-meeting-runtime-v1.js';
import { createApprovalCoreV1, type AfterApprovedRecordHookV1 } from '../src/composition/approval-core-v1.js';

vi.mock('../src/composition/approval-core-v1.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/composition/approval-core-v1.js')>(),
  createApprovalCoreV1: vi.fn(async () => ({})),
}));
// The opener reads the Authority's signing key; the stub core never signs.
vi.mock('../src/adapters/security/file-organization-authority-signer.js', () => ({ FileOrganizationAuthoritySigner: { openExisting: vi.fn(() => ({})) } }));

const COORDINATES = { authority_id: 'oau_00000000-0000-4000-8000-000000000001', organization_id: 'org_00000000-0000-4000-8000-000000000002', state_lineage_id: 'lineage-meetings' };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.mocked(createApprovalCoreV1).mockClear(); });

async function open(approval_core?: { readonly after_record: readonly AfterApprovedRecordHookV1[] }) {
  const state_directory = mkdtempSync(join(tmpdir(), 'person-meetings-'));
  const authority = new Database(':memory:'), record = new Database(':memory:');
  applyOrganizationRecordLogBaselineV6(record);
  record.prepare('INSERT INTO organization_record_log_metadata VALUES (1,?,?,?,?)').run(COORDINATES.authority_id, COORDINATES.organization_id, COORDINATES.state_lineage_id, '2026-10-07T00:00:00.000Z');
  const runtime = openPersonMeetingRuntimeV1({
    state_directory, sessions: { authenticateAccess: () => { throw new Error('unused'); } },
    resources: { coordinates: COORDINATES, database: authority, record },
    processor: { processor_adapter_id: 'fixture-llm' } as never, projectors: authorityRecordPolicyProjectorsV1(),
    providers: [{ id: 'fixture', cursor: { policy: { source_adapter_id: 'fixture-source' } } } as never],
    ...(approval_core === undefined ? {} : { approval_core }),
  });
  cleanups.push(() => { runtime.close(); for (const db of [authority, record]) db.close(); rmSync(state_directory, { recursive: true, force: true }); });
  await runtime.approvals();
  return vi.mocked(createApprovalCoreV1).mock.lastCall![2];
}

describe('Personal meeting runtime opener', () => {
  it('forwards approval_core to the shared approval core', async () => {
    const hook: AfterApprovedRecordHookV1 = () => {};
    expect(await open({ after_record: [hook] })).toMatchObject({ after_record: [hook] });
    expect(await open()).not.toHaveProperty('after_record');
  });
});
