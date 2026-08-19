import { beforeEach, describe, expect, it, vi } from 'vitest';

const { processOneAuthorityMeeting } = vi.hoisted(() => ({
  processOneAuthorityMeeting: vi.fn(),
}));

vi.mock('../src/composition/process-one-meeting.js', () => ({
  processOneAuthorityMeeting,
}));

import { runOrganizationAuthorityCli } from '../src/composition/cli.js';

const ARGUMENTS = [
  'process-one-meeting',
  '--config',
  '/echo/authority.json',
  '--principal-id',
  'prn_00000000-0000-4000-8000-000000000001',
  '--membership-id',
  'mem_00000000-0000-4000-8000-000000000001',
  '--membership-type',
  'employee',
  '--source-instance',
  'founder-canary',
] as const;

describe('process-one-meeting CLI', () => {
  beforeEach(() => {
    processOneAuthorityMeeting.mockReset();
  });

  it('dispatches the exact bounded operator input and returns sanitized counts', async () => {
    processOneAuthorityMeeting.mockResolvedValue({
      schema_version: 1,
      kind: 'echo-organization-authority-one-meeting-run',
      source: { adapter_id: 'granola', instance_id: 'founder-canary' },
      decision_processor: {
        adapter_id: 'structured-text',
        instance_id: 'founder-structured-text',
      },
      outcome: 'pending_created',
      source_binding: {
        owner: 'provisioned',
        configuration: 'provisioned',
      },
      ok: true,
      meetings_seen: 1,
      meetings_processed: 0,
      meetings_skipped: 0,
      meetings_pending: 1,
      meetings_rejected: 0,
      meetings_dead_lettered: 0,
      deliveries: 0,
      cursor_advanced: false,
      failure_count: 0,
      failure_stages: [],
      pending_approval_ids: ['approval-digest'],
    });
    const stdout: string[] = [];
    const exitCode = await runOrganizationAuthorityCli(ARGUMENTS, {}, {
      stdout: (value) => stdout.push(value),
      stderr: () => undefined,
    });

    expect(exitCode).toBe(0);
    expect(processOneAuthorityMeeting).toHaveBeenCalledWith(
      '/echo/authority.json',
      {
        principal_id: 'prn_00000000-0000-4000-8000-000000000001',
        membership_id: 'mem_00000000-0000-4000-8000-000000000001',
        membership_type: 'employee',
        source_instance_id: 'founder-canary',
      },
    );
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      meetings_seen: 1,
      meetings_pending: 1,
      ok: true,
      failure_count: 0,
    });
  });

  it('refuses owner email and credential scope in command arguments', async () => {
    const arguments_ = [
      ...ARGUMENTS,
      '--owner-email',
      'founder@example.com',
      '--credential-scope',
      'organization',
    ];
    await expect(
      runOrganizationAuthorityCli(arguments_, {}, {
        stdout: () => undefined,
        stderr: () => undefined,
      }),
    ).rejects.toThrow('usage:');
    expect(processOneAuthorityMeeting).not.toHaveBeenCalled();
  });
});
