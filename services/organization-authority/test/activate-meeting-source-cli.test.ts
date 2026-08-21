import { beforeEach, describe, expect, it, vi } from 'vitest';

const { activateAuthorityMeetingSource } = vi.hoisted(() => ({
  activateAuthorityMeetingSource: vi.fn(),
}));
vi.mock('../src/composition/activate-meeting-source.js', () => ({
  activateAuthorityMeetingSource,
}));
import { runOrganizationAuthorityCli } from '../src/composition/cli.js';

describe('activate-meeting-source CLI', () => {
  beforeEach(() => activateAuthorityMeetingSource.mockReset());

  it('prints the closed activation receipt', async () => {
    activateAuthorityMeetingSource.mockResolvedValue({ outcome: 'activated' });
    const output: string[] = [];
    await expect(runOrganizationAuthorityCli([
      'activate-meeting-source', '--config', '/echo/authority.json',
      '--principal-id', 'prn_00000000-0000-4000-8000-000000000001',
      '--membership-id', 'mem_00000000-0000-4000-8000-000000000001',
      '--membership-type', 'employee', '--source-instance', 'founder-live',
    ], {}, { stdout: (value) => output.push(value), stderr: () => undefined })).resolves.toBe(0);
    expect(activateAuthorityMeetingSource).toHaveBeenCalledWith('/echo/authority.json', expect.objectContaining({ source_instance_id: 'founder-live' }));
    expect(JSON.parse(output.join(''))).toMatchObject({ outcome: 'activated' });
  });

  it('rejects the retired canary commands', async () => {
    for (const command of ['process-one-meeting', 'baseline-live-source']) {
      await expect(runOrganizationAuthorityCli([command, '--config', '/echo/authority.json'], {}, { stdout: () => undefined, stderr: () => undefined })).rejects.toThrow('usage:');
    }
  });
});
