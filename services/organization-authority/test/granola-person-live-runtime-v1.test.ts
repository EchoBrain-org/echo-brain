import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyOrganizationRecordLogBaselineV4, createRecordPolicyFactProjectorRegistryV1, createPersonPolicyFactProjectorV2 } from '@echo-brain/organization-record/organization-record-api-v1';
import type { NangoPersonConnectionV1 } from '@echo-brain/provider-runtime/nango-person-connection-v1';
import { createPersonMeetingRuntimeV1 } from '../src/composition/person-meeting-runtime-v1.js';
import { openGranolaPersonLiveRuntimeV1 } from '../src/composition/granola-person-live-runtime-v1.js';
import type { AfterApprovedRecordHookV1 } from '../src/composition/approval-core-v1.js';

vi.mock('../src/composition/person-meeting-runtime-v1.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/composition/person-meeting-runtime-v1.js')>(),
  createPersonMeetingRuntimeV1: vi.fn(() => ({ applications: [], processing: {}, tools: async () => [], approvals: async () => { throw new Error('unused'); }, close() {} })),
}));
// The wrapper opens the Authority's signing key; the stub runtime never signs.
vi.mock('../src/adapters/security/file-organization-authority-signer.js', () => ({ FileOrganizationAuthoritySigner: { openExisting: vi.fn(() => ({})) } }));

const COORDINATES = { authority_id: 'oau_00000000-0000-4000-8000-000000000001', organization_id: 'org_00000000-0000-4000-8000-000000000002', state_lineage_id: 'lineage-granola' };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.mocked(createPersonMeetingRuntimeV1).mockClear(); });

function open(approval_core?: { readonly after_record: readonly AfterApprovedRecordHookV1[] }) {
  const state_directory = mkdtempSync(join(tmpdir(), 'granola-live-'));
  const connections = new Database(':memory:'), authority = new Database(':memory:'), record = new Database(':memory:');
  applyOrganizationRecordLogBaselineV4(record);
  record.prepare('INSERT INTO organization_record_log_metadata VALUES (1,?,?,?,?)').run(COORDINATES.authority_id, COORDINATES.organization_id, COORDINATES.state_lineage_id, '2026-10-07T00:00:00.000Z');
  const runtime = openGranolaPersonLiveRuntimeV1({
    state_directory, sessions: { authenticateAccess: () => { throw new Error('unused'); } },
    resources: { coordinates: COORDINATES, database: authority, record } as never,
    processor: {} as never, projectors: createRecordPolicyFactProjectorRegistryV1([createPersonPolicyFactProjectorV2()]), nango_authorization: () => 'unused',
    ...(approval_core === undefined ? {} : { approval_core }),
    seams: { database: connections, nango: {} as NangoPersonConnectionV1, fetch: (async () => { throw new Error('unused'); }) as typeof fetch },
  });
  cleanups.push(() => { runtime.close(); for (const db of [connections, authority, record]) db.close(); rmSync(state_directory, { recursive: true, force: true }); });
  return vi.mocked(createPersonMeetingRuntimeV1).mock.lastCall![0];
}

describe('Granola personal live runtime', () => {
  it('forwards approval_core to the person meeting runtime', () => {
    const hook: AfterApprovedRecordHookV1 = () => {};
    expect(open({ after_record: [hook] }).approval_core).toEqual({ after_record: [hook] });
    expect(open()).not.toHaveProperty('approval_core');
  });
});
