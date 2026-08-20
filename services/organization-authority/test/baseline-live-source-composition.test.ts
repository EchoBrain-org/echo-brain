import { beforeEach, describe, expect, it, vi } from 'vitest';

const seams = vi.hoisted(() => ({
  acquireInitializationLock: vi.fn(),
  acquireRuntimeLock: vi.fn(),
  maintenanceFingerprint: vi.fn(),
  readRuntimeConfig: vi.fn(),
  resolveServeConfig: vi.fn(),
  inspectPreflight: vi.fn(),
  resolveEffectiveConfig: vi.fn(),
  readSourceBinding: vi.fn(),
  storeConstructor: vi.fn(),
  store: {
    initialize: vi.fn(),
    countUnfinishedCandidates: vi.fn(),
    getSourceCursor: vi.fn(),
    setSourceCursor: vi.fn(),
    close: vi.fn(),
  },
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
vi.mock('../src/adapters/persistence/sqlite/processing-source-runtime-binding.js', () => ({
  readAuthorityProcessingSourceRuntimeBinding: seams.readSourceBinding,
}));
vi.mock('../src/processing/storage/sqlite-authority-processing-store.js', () => ({
  SqliteAuthorityProcessingStore: seams.storeConstructor,
}));

import { createGranolaLiveOnlyCursor } from '../src/processing/adapters/meeting-sources/granola/index.js';
import { baselineAuthorityLiveSource } from '../src/composition/baseline-live-source.js';

const CONFIG_PATH = '/echo/authority.json';
const STATE_DIRECTORY = '/echo/state';
const DATABASE_PATH = '/echo/state/authority.sqlite';
const ORGANIZATION_ID = 'org_00000000-0000-4000-8000-000000000001';
const CUTOFF_AT = '2026-08-20T04:00:00.000Z';
const FINGERPRINT = `sha256:${'a'.repeat(64)}`;
const BINDING = {
  organization_id: ORGANIZATION_ID,
  principal_id: 'prn_00000000-0000-4000-8000-000000000001',
  membership_id: 'mem_00000000-0000-4000-8000-000000000001',
  membership_type: 'employee' as const,
  source_adapter_id: 'granola' as const,
  source_instance_id: 'founder-canary',
  owner_email_sha256: `sha256:${'b'.repeat(64)}` as const,
  credential_scope: 'organization' as const,
  credential_reference_sha256: `sha256:${'c'.repeat(64)}` as const,
};

function configure(): void {
  seams.readRuntimeConfig.mockReturnValue({ state_dir: STATE_DIRECTORY });
  seams.resolveServeConfig.mockReturnValue({ marker: 'serve-config' });
  seams.maintenanceFingerprint.mockReturnValue(FINGERPRINT);
  seams.acquireInitializationLock.mockResolvedValue(
    seams.releaseInitializationLock,
  );
  seams.acquireRuntimeLock.mockResolvedValue({ release: seams.releaseRuntimeLock });
  seams.inspectPreflight.mockResolvedValue(undefined);
  seams.resolveEffectiveConfig.mockReturnValue({
    database_path: DATABASE_PATH,
    organization_id: ORGANIZATION_ID,
  });
  seams.readSourceBinding.mockReturnValue(BINDING);
  seams.storeConstructor.mockImplementation(function () {
    return seams.store;
  });
  seams.store.initialize.mockResolvedValue(undefined);
  seams.store.countUnfinishedCandidates.mockResolvedValue(0);
  seams.store.getSourceCursor
    .mockResolvedValueOnce(undefined)
    .mockImplementation(async () => seams.store.setSourceCursor.mock.calls[0]?.[1]);
  seams.store.setSourceCursor.mockResolvedValue(undefined);
  seams.store.close.mockReturnValue(undefined);
  seams.releaseInitializationLock.mockResolvedValue(undefined);
  seams.releaseRuntimeLock.mockResolvedValue(undefined);
}

beforeEach(() => {
  for (const seam of Object.values(seams)) {
    if (typeof seam === 'function' && 'mockReset' in seam) seam.mockReset();
  }
  for (const seam of Object.values(seams.store)) seam.mockReset();
  configure();
});

describe('baselineAuthorityLiveSource composition', () => {
  it('takes stopped locks and atomically writes a verified live-only cursor', async () => {
    await expect(
      baselineAuthorityLiveSource(CONFIG_PATH, { now: () => CUTOFF_AT }),
    ).resolves.toEqual({
      schema_version: 1,
      kind: 'echo-organization-authority-meeting-live-source-baseline',
      outcome: 'baseline_created',
      source: { adapter_id: 'granola', instance_id: 'founder-canary' },
      cutoff_at: CUTOFF_AT,
    });

    expect(seams.acquireInitializationLock).toHaveBeenCalledWith(
      CONFIG_PATH,
      STATE_DIRECTORY,
    );
    expect(seams.maintenanceFingerprint).toHaveBeenCalledWith(
      { marker: 'serve-config' },
      'baseline-live-source',
    );
    expect(seams.acquireRuntimeLock).toHaveBeenCalledWith(
      STATE_DIRECTORY,
      FINGERPRINT,
    );
    expect(seams.storeConstructor).toHaveBeenCalledWith(
      DATABASE_PATH,
      expect.objectContaining({
        source_adapter_id: 'granola',
        source_instance_id: 'founder-canary',
      }),
      expect.objectContaining({ bindingMode: 'require-existing', fileMustExist: true }),
    );
    expect(seams.store.setSourceCursor).toHaveBeenCalledWith(
      expect.objectContaining({
        adapter_id: 'granola',
        instance_id: 'founder-canary',
      }),
      expect.any(String),
    );
    expect(seams.store.close).toHaveBeenCalledOnce();
    expect(seams.releaseRuntimeLock).toHaveBeenCalledOnce();
    expect(seams.releaseInitializationLock).toHaveBeenCalledOnce();
  });

  it('replaces an initial-history cursor', async () => {
    const initialHistoryCursor = `granola:v1:${Buffer.from(
      JSON.stringify({
        schema_version: 1,
        watermark: null,
        page_cursor: 'private-initial-history-token',
        page_high_watermark: '2026-08-20T03:59:00.000Z',
      }),
    ).toString('base64url')}`;
    seams.store.getSourceCursor.mockReset();
    seams.store.getSourceCursor
      .mockResolvedValueOnce(initialHistoryCursor)
      .mockImplementation(async () => seams.store.setSourceCursor.mock.calls[0]?.[1]);

    await baselineAuthorityLiveSource(CONFIG_PATH, { now: () => CUTOFF_AT });

    expect(seams.store.setSourceCursor).toHaveBeenCalledOnce();
  });

  it.each([
    ['unfinished candidates', 1, undefined, 'zero unfinished candidates'],
    ['an existing live cursor', 0, createGranolaLiveOnlyCursor(CUTOFF_AT), 'existing live cursor'],
  ])('refuses %s without writing', async (_name, unfinished, cursor, message) => {
    seams.store.countUnfinishedCandidates.mockResolvedValue(unfinished);
    seams.store.getSourceCursor.mockReset();
    seams.store.getSourceCursor.mockResolvedValue(cursor);

    await expect(
      baselineAuthorityLiveSource(CONFIG_PATH, { now: () => CUTOFF_AT }),
    ).rejects.toThrow(message);

    expect(seams.store.setSourceCursor).not.toHaveBeenCalled();
    expect(seams.store.close).toHaveBeenCalledOnce();
  });
});
