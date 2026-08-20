import { beforeEach, describe, expect, it, vi } from 'vitest';

const { baselineAuthorityLiveSource } = vi.hoisted(() => ({
  baselineAuthorityLiveSource: vi.fn(),
}));

vi.mock('../src/composition/baseline-live-source.js', () => ({
  baselineAuthorityLiveSource,
}));

import { runOrganizationAuthorityCli } from '../src/composition/cli.js';

describe('baseline-live-source CLI', () => {
  beforeEach(() => baselineAuthorityLiveSource.mockReset());

  it('prints the closed baseline receipt', async () => {
    baselineAuthorityLiveSource.mockResolvedValue({
      schema_version: 1,
      kind: 'echo-organization-authority-meeting-live-source-baseline',
      outcome: 'baseline_created',
      source: { adapter_id: 'granola', instance_id: 'founder-canary' },
      cutoff_at: '2026-08-20T04:00:00.000Z',
    });
    const stdout: string[] = [];

    await expect(
      runOrganizationAuthorityCli(
        ['baseline-live-source', '--config', '/echo/authority.json'],
        {},
        { stdout: (value) => stdout.push(value), stderr: () => undefined },
      ),
    ).resolves.toBe(0);

    expect(baselineAuthorityLiveSource).toHaveBeenCalledWith('/echo/authority.json');
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      outcome: 'baseline_created',
      cutoff_at: '2026-08-20T04:00:00.000Z',
    });
  });

  it('rejects caller identity and cutoff flags', async () => {
    await expect(
      runOrganizationAuthorityCli(
        [
          'baseline-live-source',
          '--config',
          '/echo/authority.json',
          '--principal-id',
          'prn_00000000-0000-4000-8000-000000000001',
        ],
        {},
        { stdout: () => undefined, stderr: () => undefined },
      ),
    ).rejects.toThrow('usage:');
    expect(baselineAuthorityLiveSource).not.toHaveBeenCalled();
  });
});
