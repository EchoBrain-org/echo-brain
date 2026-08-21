import { beforeEach, describe, expect, it, vi } from 'vitest';

const seams = vi.hoisted(() => ({
  acquireInitializationLock: vi.fn(),
  acquireRuntimeLock: vi.fn(),
  maintenanceFingerprint: vi.fn(),
  readRuntimeConfig: vi.fn(),
  resolveServeConfig: vi.fn(),
  inspectPreflight: vi.fn(),
  resolveEffectiveConfig: vi.fn(),
  readCredential: vi.fn(),
  readOwnerEmail: vi.fn(),
  readScope: vi.fn(),
  assertOwnerIdentity: vi.fn(),
  storeConstructor: vi.fn(),
  store: { activateLiveSource: vi.fn(), close: vi.fn() },
  releaseInitializationLock: vi.fn(),
  releaseRuntimeLock: vi.fn(),
}));

vi.mock('../src/adapters/runtime/singleton-runtime-lock.js', () => ({
  acquireAuthorityInitializationLock: seams.acquireInitializationLock,
  acquireAuthorityRuntimeLock: seams.acquireRuntimeLock,
}));
vi.mock('../src/adapters/runtime/runtime-fingerprint.js', () => ({
  authorityMaintenanceFingerprint: seams.maintenanceFingerprint,
}));
vi.mock('../src/composition/operator-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/composition/operator-config.js')>()),
  readAuthorityRuntimeConfig: seams.readRuntimeConfig,
  resolveAuthorityServeConfig: seams.resolveServeConfig,
}));
vi.mock('../src/composition/operator-state.js', () => ({
  inspectAuthorityServePreflight: seams.inspectPreflight,
  resolveEffectiveAuthorityServeConfig: seams.resolveEffectiveConfig,
}));
vi.mock('../src/adapters/security/private-file-credentials.js', () => ({
  readPrivateAuthorityGranolaOrganizationCredential: seams.readCredential,
  readPrivateAuthorityGranolaOwnerEmail: seams.readOwnerEmail,
  readPrivateAuthorityOrganizationCredentialScope: seams.readScope,
}));
vi.mock('../src/adapters/persistence/sqlite/processing-source-identity.js', () => ({
  assertAuthorityProcessingOwnerEmailBinding: seams.assertOwnerIdentity,
}));
vi.mock('../src/processing/storage/sqlite-authority-processing-store.js', () => ({
  SqliteAuthorityProcessingStore: seams.storeConstructor,
}));

import { createGranolaLiveOnlyCursor } from '../src/processing/adapters/meeting-sources/granola/index.js';
import { activateAuthorityMeetingSource } from '../src/composition/activate-meeting-source.js';

const CONFIG_PATH = '/echo/authority.json';
const ORGANIZATION_ID = 'org_00000000-0000-4000-8000-000000000001';
const PRINCIPAL_ID = 'prn_00000000-0000-4000-8000-000000000001';
const MEMBERSHIP_ID = 'mem_00000000-0000-4000-8000-000000000001';
const INPUT = {
  principal_id: PRINCIPAL_ID,
  membership_id: MEMBERSHIP_ID,
  membership_type: 'employee' as const,
  source_instance_id: 'founder-live',
};
const CUTOFF = '2026-08-20T04:00:00.000Z';

function configure(): void {
  seams.readRuntimeConfig.mockReturnValue({ state_dir: '/echo/state' });
  seams.resolveServeConfig.mockReturnValue({ marker: 'serve-config' });
  seams.maintenanceFingerprint.mockReturnValue(`sha256:${'a'.repeat(64)}`);
  seams.acquireInitializationLock.mockResolvedValue(seams.releaseInitializationLock);
  seams.acquireRuntimeLock.mockResolvedValue({ release: seams.releaseRuntimeLock });
  seams.inspectPreflight.mockResolvedValue(undefined);
  seams.resolveEffectiveConfig.mockReturnValue({
    state_directory: '/echo/state',
    database_path: '/echo/state/authority.sqlite',
    organization_id: ORGANIZATION_ID,
    organization_recording_policy_v1: {},
  });
  seams.readCredential.mockReturnValue(`grn_${'a'.repeat(32)}`);
  seams.readOwnerEmail.mockReturnValue('founder@example.com');
  seams.readScope.mockReturnValue('organization');
  seams.assertOwnerIdentity.mockReturnValue(`sha256:${'b'.repeat(64)}`);
  seams.storeConstructor.mockImplementation(function () { return seams.store; });
  seams.store.activateLiveSource.mockImplementation(
    async (_source, createCursor, assertCursor) => {
      const cursor = createCursor(CUTOFF);
      assertCursor(cursor);
      return {
        outcome: 'activated',
        cursor,
        source_binding: {
          owner_binding: 'provisioned',
          configuration_binding: 'provisioned',
        },
      };
    },
  );
  seams.store.close.mockReturnValue(undefined);
}

beforeEach(() => {
  for (const seam of Object.values(seams)) {
    if (typeof seam === 'function' && 'mockReset' in seam) seam.mockReset();
  }
  for (const seam of Object.values(seams.store)) seam.mockReset();
  configure();
});

describe('activateAuthorityMeetingSource', () => {
  it('takes stopped locks and atomically admits the exact Person, local credential proof, and live-only cutoff', async () => {
    await expect(activateAuthorityMeetingSource(CONFIG_PATH, INPUT)).resolves.toEqual({
      schema_version: 1,
      kind: 'echo-organization-authority-meeting-source-activation',
      outcome: 'activated',
      source: { adapter_id: 'granola', instance_id: 'founder-live', version: '2.2.0' },
      cutoff_at: CUTOFF,
      source_binding: { owner: 'provisioned', configuration: 'provisioned' },
    });
    expect(seams.maintenanceFingerprint).toHaveBeenCalledWith(
      { marker: 'serve-config' },
      'activate-meeting-source',
    );
    expect(seams.assertOwnerIdentity).toHaveBeenCalledWith(
      '/echo/state/authority.sqlite',
      expect.objectContaining({ organization_id: ORGANIZATION_ID, principal_id: PRINCIPAL_ID }),
      'founder@example.com',
    );
    expect(seams.store.activateLiveSource).toHaveBeenCalledOnce();
    expect(seams.store.close).toHaveBeenCalledOnce();
  });

  it('returns the persisted live cutoff on a retry without invoking the cutoff factory', async () => {
    const cursor = createGranolaLiveOnlyCursor(CUTOFF);
    seams.store.activateLiveSource.mockImplementation(async (_source, _createCursor, assertCursor) => {
      assertCursor(cursor);
      return {
        outcome: 'already_activated', cursor,
        source_binding: { owner_binding: 'existing', configuration_binding: 'existing' },
      };
    });
    await expect(activateAuthorityMeetingSource(CONFIG_PATH, INPUT, {
      now: () => { throw new Error('retry must not sample another cutoff'); },
    })).resolves.toMatchObject({ outcome: 'already_activated', cutoff_at: CUTOFF });
  });

  it('does not activate before stopped ownership is acquired', async () => {
    seams.acquireRuntimeLock.mockRejectedValue(new Error('authority is already running'));
    await expect(activateAuthorityMeetingSource(CONFIG_PATH, INPUT)).rejects.toThrow('already running');
    expect(seams.store.activateLiveSource).not.toHaveBeenCalled();
    expect(seams.releaseInitializationLock).toHaveBeenCalledOnce();
  });
});
